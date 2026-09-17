const EVENT_PATH = "/api/integrations/krisha/moderation/events";
const SUBSCRIPTIONS_PATH = "/api/integrations/krisha/moderation/subscriptions";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SKEW_SECONDS = 300;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LISTING_ID = /^\d{5,20}$/;
const CHAT_ID = /^-?\d{1,20}$/;

const now = () => new Date().toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  },
});
const database = env => env.DB && typeof env.DB.prepare === "function" ? env.DB : null;
const constantTimeEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};
const hex = buffer => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, "0")).join("");

async function readLimited(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function verifySignature(request, body, env) {
  const secret = String(env.KRISHA_MODERATION_WEBHOOK_SECRET || "");
  if (secret.length < 32) return "misconfigured";
  const timestamp = request.headers.get("x-krisha-timestamp") || "";
  const supplied = request.headers.get("x-krisha-signature") || "";
  if (!/^\d{10}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(supplied)) return "invalid";
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) return "invalid";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const expected = `sha256=${hex(await crypto.subtle.sign("HMAC", key, signed))}`;
  return constantTimeEqual(expected, supplied) ? "valid" : "invalid";
}

function text(value, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

function number(value, max, integer = false) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) return undefined;
  return value;
}

function normalizeEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.schema_version !== 1) return null;
  if (typeof body.event_id !== "string" || !EVENT_ID.test(body.event_id)) return null;
  if (body.event_type !== "listing.submitted_for_moderation") return null;
  if (typeof body.occurred_at !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(body.occurred_at) || !Number.isFinite(Date.parse(body.occurred_at))) return null;
  const listing = body.listing;
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) return null;
  const listingId = typeof listing.source_id === "string" ? listing.source_id : (Number.isSafeInteger(listing.source_id) ? String(listing.source_id) : "");
  if (!LISTING_ID.test(listingId)) return null;
  const city = text(listing.city, 100);
  const category = text(listing.category, 80);
  const price = number(listing.price_kzt, 1_000_000_000_000);
  const rooms = number(listing.rooms, 100, true);
  const area = number(listing.area_m2, 1_000_000);
  if (city === null || category === null || price === undefined || rooms === undefined || area === undefined) return null;
  return {
    event_id: body.event_id,
    event_type: body.event_type,
    occurred_at: new Date(Date.parse(body.occurred_at)).toISOString(),
    listing_id: listingId,
    city,
    category,
    price_kzt: price,
    rooms,
    area_m2: area,
  };
}

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function matches(subscription, event) {
  const sameText = (filter, value) => !filter || (value && filter.toLocaleLowerCase() === value.toLocaleLowerCase());
  if (!sameText(subscription.city, event.city) || !sameText(subscription.category, event.category)) return false;
  for (const [minimum, maximum, field] of [["rooms_min", "rooms_max", "rooms"], ["price_min_kzt", "price_max_kzt", "price_kzt"], ["area_min_m2", "area_max_m2", "area_m2"]]) {
    const value = event[field];
    if ((subscription[minimum] !== null && subscription[minimum] !== undefined || subscription[maximum] !== null && subscription[maximum] !== undefined) && value === null) return false;
    if (subscription[minimum] !== null && subscription[minimum] !== undefined && value < subscription[minimum]) return false;
    if (subscription[maximum] !== null && subscription[maximum] !== undefined && value > subscription[maximum]) return false;
  }
  return true;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function telegramMessage(event, subscription) {
  const lines = ["🔔 <b>Новое объявление отправлено на модерацию</b>", `ID: <code>${escapeHtml(event.listing_id)}</code>`];
  if (event.category) lines.push(`Тип: ${escapeHtml(event.category)}`);
  if (event.city) lines.push(`Город: ${escapeHtml(event.city)}`);
  if (event.price_kzt !== null) lines.push(`Цена: ${Number(event.price_kzt).toLocaleString("ru-RU")} ₸`);
  if (event.rooms !== null) lines.push(`Комнат: ${event.rooms}`);
  if (event.area_m2 !== null) lines.push(`Площадь: ${event.area_m2} м²`);
  lines.push(`Время подачи: ${escapeHtml(event.occurred_at)}`, `Профиль: ${escapeHtml(subscription.agency_name)}`);
  return lines.join("\n");
}

async function flushOutbox(env, eventId = null) {
  const db = database(env);
  if (!db) return { sent: 0, failed: 0, skipped: true };
  const rows = await db.prepare("SELECT * FROM krisha_moderation_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 25").bind(now()).all();
  const selected = (rows.results || []).filter(row => !eventId || row.event_id === eventId);
  let sent = 0;
  let failed = 0;
  const token = String(env.TELEGRAM_BOT_TOKEN || "");
  for (const row of selected) {
    if (!token) {
      failed++;
      continue;
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: row.chat_id, text: row.telegram_html, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(`telegram_http_${response.status}`);
      await db.prepare("UPDATE krisha_moderation_outbox SET status='sent',sent_at=?,attempts=attempts+1,last_error=NULL,telegram_html='' WHERE id=?").bind(now(), row.id).run();
      sent++;
    } catch (error) {
      failed++;
      const attempts = Math.min(Number(row.attempts || 0) + 1, 10);
      const delay = Math.min(3600, 30 * (2 ** Math.min(attempts - 1, 7)));
      await db.prepare("UPDATE krisha_moderation_outbox SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=?").bind(String(error.message || "delivery_failed").slice(0, 120), new Date(Date.now() + delay * 1000).toISOString(), row.id).run();
    }
  }
  return { sent, failed, skipped: false };
}

async function acceptEvent(request, env) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return json({ error: "json_required" }, 415);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const raw = await readLimited(request, MAX_BODY_BYTES);
  if (!raw) return json({ error: "payload_too_large" }, 413);
  const signature = await verifySignature(request, raw, env);
  if (signature === "misconfigured") return json({ error: "webhook_not_configured" }, 503);
  if (signature !== "valid") return json({ error: "unauthorized" }, 401);
  let body;
  try { body = JSON.parse(new TextDecoder().decode(raw)); }
  catch { return json({ error: "invalid_json" }, 400); }
  const event = normalizeEvent(body);
  if (!event) return json({ error: "invalid_moderation_event" }, 400);
  const db = database(env);
  if (!db) return json({ error: "persistence_unavailable" }, 503);

  const payloadHash = await sha256(JSON.stringify(event));
  const existing = await db.prepare("SELECT payload_hash FROM krisha_moderation_events WHERE event_id=?").bind(event.event_id).first();
  if (existing && !constantTimeEqual(existing.payload_hash, payloadHash)) return json({ error: "event_id_conflict" }, 409);
  let queued = 0;
  if (!existing) {
    const receivedAt = now();
    await db.prepare("INSERT OR IGNORE INTO krisha_moderation_events (event_id,listing_id,event_type,city,category,price_kzt,rooms,area_m2,occurred_at,received_at,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(event.event_id, event.listing_id, event.event_type, event.city || null, event.category || null, event.price_kzt, event.rooms, event.area_m2, event.occurred_at, receivedAt, payloadHash).run();
    const stored = await db.prepare("SELECT payload_hash FROM krisha_moderation_events WHERE event_id=?").bind(event.event_id).first();
    if (!stored || !constantTimeEqual(stored.payload_hash, payloadHash)) return json({ error: "event_id_conflict" }, 409);
  }

  const subscriptions = await db.prepare("SELECT * FROM krisha_moderation_subscriptions WHERE enabled=1").all();
  const activeSubscriptions = subscriptions.results || [];
  if (activeSubscriptions.length === 0) return json({ error: "subscriptions_not_configured", retryable: true }, 503);
  const receivedAt = now();
  for (const subscription of activeSubscriptions) {
    if (!matches(subscription, event)) continue;
    const result = await db.prepare("INSERT OR IGNORE INTO krisha_moderation_outbox (event_id,chat_id,telegram_html,status,attempts,next_attempt_at) VALUES (?,?,?,'pending',0,?)")
      .bind(event.event_id, subscription.telegram_chat_id, telegramMessage(event, subscription), receivedAt).run();
    queued += Number(result.meta?.changes || 0);
  }

  const delivery = await flushOutbox(env, event.event_id);
  const pending = await db.prepare("SELECT COUNT(*) AS count FROM krisha_moderation_outbox WHERE event_id=? AND status='pending'").bind(event.event_id).first();
  if (Number(pending?.count || 0) > 0) return json({ error: "telegram_delivery_pending", retryable: true }, 503);
  return json({ accepted: true, duplicate: Boolean(existing), deliveries_queued: queued, deliveries_sent: delivery.sent }, 202);
}

function adminAuthorized(request, env) {
  const expected = String(env.KRISHA_MODERATION_ADMIN_KEY || "");
  if (expected.length < 32) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  return constantTimeEqual(expected, supplied);
}

function normalizeSubscription(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const agency = text(body.agency_name, 120);
  const city = text(body.city, 100);
  const category = text(body.category, 80);
  if (!agency || city === null || category === null) return null;
  const chat = typeof body.telegram_chat_id === "number" && Number.isSafeInteger(body.telegram_chat_id) ? String(body.telegram_chat_id) : body.telegram_chat_id;
  if (typeof chat !== "string" || !CHAT_ID.test(chat)) return null;
  const result = { agency_name: agency, city: city || null, category: category || null, telegram_chat_id: chat };
  for (const [key, max] of [["rooms_min", 100], ["rooms_max", 100], ["price_min_kzt", 1_000_000_000_000], ["price_max_kzt", 1_000_000_000_000], ["area_min_m2", 1_000_000], ["area_max_m2", 1_000_000]]) {
    const parsed = number(body[key], max, key.startsWith("rooms_"));
    if (parsed === undefined) return null;
    result[key] = parsed;
  }
  if (result.rooms_min !== null && result.rooms_max !== null && result.rooms_min > result.rooms_max) return null;
  if (result.price_min_kzt !== null && result.price_max_kzt !== null && result.price_min_kzt > result.price_max_kzt) return null;
  if (result.area_min_m2 !== null && result.area_max_m2 !== null && result.area_min_m2 > result.area_max_m2) return null;
  return result;
}

async function subscriptionRoute(request, env, url) {
  if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
  const db = database(env);
  if (!db) return json({ error: "persistence_unavailable" }, 503);
  if (url.pathname === SUBSCRIPTIONS_PATH && request.method === "GET") {
    const rows = await db.prepare("SELECT id,agency_name,city,category,rooms_min,rooms_max,price_min_kzt,price_max_kzt,area_min_m2,area_max_m2,enabled,created_at,updated_at FROM krisha_moderation_subscriptions ORDER BY created_at DESC").all();
    return json({ items: rows.results || [] });
  }
  if (url.pathname === SUBSCRIPTIONS_PATH && request.method === "POST") {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return json({ error: "json_required" }, 415);
    const raw = await readLimited(request, 16 * 1024);
    if (!raw) return json({ error: "payload_too_large" }, 413);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(raw)); }
    catch { return json({ error: "invalid_json" }, 400); }
    const subscription = normalizeSubscription(body);
    if (!subscription) return json({ error: "invalid_subscription" }, 400);
    const createdAt = now();
    const subscriptionId = crypto.randomUUID();
    await db.prepare("INSERT INTO krisha_moderation_subscriptions (id,agency_name,city,category,rooms_min,rooms_max,price_min_kzt,price_max_kzt,area_min_m2,area_max_m2,telegram_chat_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)")
      .bind(subscriptionId, subscription.agency_name, subscription.city, subscription.category, subscription.rooms_min, subscription.rooms_max, subscription.price_min_kzt, subscription.price_max_kzt, subscription.area_min_m2, subscription.area_max_m2, subscription.telegram_chat_id, createdAt, createdAt).run();
    const { telegram_chat_id, ...publicFields } = subscription;
    return json({ item: { id: subscriptionId, ...publicFields, enabled: 1, created_at: createdAt, updated_at: createdAt } }, 201);
  }
  const match = url.pathname.match(new RegExp(`^${SUBSCRIPTIONS_PATH}/([A-Za-z0-9-]{36})$`));
  if (match && request.method === "DELETE") {
    const result = await db.prepare("DELETE FROM krisha_moderation_subscriptions WHERE id=?").bind(match[1]).run();
    return json({ deleted: Number(result.meta?.changes || 0) > 0 });
  }
  return json({ error: "not_found" }, 404);
}

async function fetchHandler(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") return json({ service: "estate-radar-ingress", status: "ok" });
  if (url.pathname === EVENT_PATH) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    return acceptEvent(request, env);
  }
  if (url.pathname === SUBSCRIPTIONS_PATH || url.pathname.startsWith(`${SUBSCRIPTIONS_PATH}/`)) return subscriptionRoute(request, env, url);
  return json({ error: "not_found" }, 404);
}

const worker = { fetch: fetchHandler };
export default worker;

