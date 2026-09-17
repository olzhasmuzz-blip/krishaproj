const now = () => new Date().toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const clean = value => String(value ?? "").replace(/\s+/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").trim();
const number = value => { const raw = String(value ?? "").replace(/[^0-9.,]/g, "").replace(/\s/g, "").replace(",", "."); const parsed = Number(raw); return Number.isFinite(parsed) ? parsed : null; };
const id = () => crypto.randomUUID();
const db = env => env.DB && typeof env.DB.prepare === "function" ? env.DB : null;
const authorized = (request, env) => !env.INGEST_API_KEY || request.headers.get("x-estate-radar-key") === env.INGEST_API_KEY || request.headers.get("authorization") === `Bearer ${env.INGEST_API_KEY}`;
const DEFAULT_FEED_URL = "https://raw.githubusercontent.com/olzhasmuzz-blip/krishaproj/main/data/krisha-feed.json";
const KRISHA_MODERATION_PATH = "/api/integrations/krisha/moderation/events";
const KRISHA_MODERATION_SUBSCRIPTIONS_PATH = "/api/integrations/krisha/moderation/subscriptions";
const MAX_MODERATION_BODY_BYTES = 64 * 1024;
const WEBHOOK_MAX_SKEW_SECONDS = 300;

// The crawler publishes already-normalized JSON. No source HTML is parsed in this Worker.
async function readFeed(env) {
  const response = await fetch(env.KRISHA_FEED_URL || DEFAULT_FEED_URL, { headers: { accept: "application/json", "cache-control": "no-cache" }, cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`feed_http_${response.status}`);
  return response.json();
}

function normalize(item) {
  const sourceId = String(item.source_id || item.id || "").match(/[0-9]+/)?.[0] || "";
  return { source_id: sourceId, source: "krisha.kz", url: String(item.url || `https://krisha.kz/a/show/${sourceId}`), title: clean(item.title || item.raw_title || "Объект без названия"), description: clean(item.description), price_kzt: number(item.price_kzt ?? item.price), rooms: number(item.rooms), area_m2: number(item.area_m2 ?? item.area), floor: number(item.floor), floors_total: number(item.floors_total), address: clean(item.address), city: clean(item.city), district: clean(item.district), residential_complex: clean(item.residential_complex), seller_label: clean(item.seller_label), photo_urls: Array.isArray(item.photo_urls) ? item.photo_urls : [], raw: item };
}

function fingerprint(item) { return [item.price_kzt || "", item.title, item.address, item.rooms || "", item.area_m2 || ""].join("|").toLowerCase(); }
function matches(profile, item) { return (!profile.city || !item.city || profile.city === item.city) && (!profile.rooms_min || (item.rooms || 0) >= profile.rooms_min) && (!profile.rooms_max || (item.rooms || 0) <= profile.rooms_max) && (!profile.price_max_kzt || (item.price_kzt || 0) <= profile.price_max_kzt) && (!profile.area_min_m2 || (item.area_m2 || 0) >= profile.area_min_m2); }

async function ingestItems(env, items) {
  const database = db(env); if (!database) return { inserted: 0, changed: 0, events: [] };
  let inserted = 0, changed = 0; const events = [];
  for (const raw of items.map(normalize).filter(item => item.source_id)) {
    const item = { ...raw, fingerprint: fingerprint(raw), observed: now() };
    const previous = await database.prepare("SELECT source_id, price_kzt FROM listings WHERE source_id = ?").bind(item.source_id).first();
    const explicitEvent = raw.event_type;
    const eventType = explicitEvent === "existing" ? null : (explicitEvent === "new" || explicitEvent === "price" ? explicitEvent : (!previous ? "new" : (previous.price_kzt && item.price_kzt && Number(previous.price_kzt) !== Number(item.price_kzt) ? "price" : null)));
    await database.prepare(`INSERT INTO listings (source_id,source,url,title,description,price_kzt,rooms,area_m2,floor,floors_total,address,city,district,residential_complex,seller_label,photo_urls_json,fingerprint,first_seen_at,last_seen_at,last_price_kzt,status,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET source=excluded.source,url=excluded.url,title=excluded.title,description=excluded.description,price_kzt=excluded.price_kzt,rooms=excluded.rooms,area_m2=excluded.area_m2,floor=excluded.floor,floors_total=excluded.floors_total,address=excluded.address,city=excluded.city,district=excluded.district,residential_complex=excluded.residential_complex,seller_label=excluded.seller_label,photo_urls_json=excluded.photo_urls_json,fingerprint=excluded.fingerprint,last_seen_at=excluded.last_seen_at,last_price_kzt=listings.price_kzt,status='active',raw_json=excluded.raw_json`).bind(item.source_id,item.source,item.url,item.title,item.description,item.price_kzt,item.rooms,item.area_m2,item.floor,item.floors_total,item.address,item.city,item.district,item.residential_complex,item.seller_label,JSON.stringify(item.photo_urls),item.fingerprint,item.observed,item.observed,item.price_kzt,"active",JSON.stringify(item.raw)).run();
    if (!previous) inserted++;
    if (eventType) {
      const eventId = id(), payload = { ...item, event_type: eventType };
      const result = await database.prepare("INSERT OR IGNORE INTO events (id,source_id,event_type,fingerprint,observed_at,payload_json) VALUES (?,?,?,?,?,?)").bind(eventId,item.source_id,eventType,item.fingerprint,item.observed,JSON.stringify(payload)).run();
      if (result.meta?.changes) { events.push({ id: eventId, ...payload }); changed++; }
    }
  }
  if (events.length) {
    const profiles = await database.prepare("SELECT * FROM profiles WHERE enabled = 1 AND telegram_chat_id IS NOT NULL AND telegram_chat_id != ''").all();
    for (const event of events) for (const profile of profiles.results || []) if (matches(profile, event)) await database.prepare("INSERT OR IGNORE INTO telegram_outbox (event_id,chat_id,payload_json,status,attempts,next_attempt_at) VALUES (?,?,?,'pending',0,?)").bind(event.id,profile.telegram_chat_id,JSON.stringify({ ...event, profile: profile.name }),now()).run();
  }
  return { inserted, changed, events };
}

async function flushTelegram(env) {
  const database = db(env); if (!database || !env.TELEGRAM_BOT_TOKEN) return { sent: 0, skipped: true };
  const rows = await database.prepare("SELECT * FROM telegram_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 25").bind(now()).all(); let sent = 0;
  for (const row of rows.results || []) {
    const event = JSON.parse(row.payload_json), price = event.price_kzt ? `${Number(event.price_kzt).toLocaleString("ru-RU")} ₸` : "цена не указана";
    const message = `${event.event_type === "new" ? "🆕 Новый объект" : "📉 Изменение цены"}\n<b>${clean(event.title)}</b>\n${clean(event.address)}\n${price}\n<a href="${event.url}">Открыть на Krisha.kz</a>\nПрофиль: ${clean(event.profile)}`;
    try { const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: row.chat_id, text: message, parse_mode: "HTML" }) }); if (!response.ok) throw new Error(`telegram_http_${response.status}`); await database.prepare("UPDATE telegram_outbox SET status='sent',sent_at=?,attempts=attempts+1,last_error=NULL WHERE id=?").bind(now(),row.id).run(); sent++; }
    catch (error) { await database.prepare("UPDATE telegram_outbox SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=?").bind(clean(error.message || error),new Date(Date.now()+60000).toISOString(),row.id).run(); }
  }
  return { sent, skipped: false };
}

async function listEvents(env) {
  const database = db(env); if (!database) return [];
  const rows = await database.prepare("SELECT e.id,e.event_type,e.observed_at,e.payload_json,l.source_id,l.url,l.title,l.description,l.price_kzt,l.rooms,l.area_m2,l.floor,l.floors_total,l.address,l.city,l.district,l.residential_complex,l.seller_label,c.agent_name FROM events e JOIN listings l ON l.source_id=e.source_id LEFT JOIN claims c ON c.source_id=l.source_id ORDER BY e.observed_at DESC LIMIT 100").all();
  return (rows.results || []).map(row => ({ ...JSON.parse(row.payload_json || "{}"), id: row.id, event_type: row.event_type, observed_at: row.observed_at, claimed_by: row.agent_name || null, price_kzt: row.price_kzt, title: row.title, address: row.address, city: row.city, description: row.description, rooms: row.rooms, area_m2: row.area_m2, floor: row.floor, floors_total: row.floors_total, url: row.url }));
}

async function syncFeed(env) {
  const feed = await readFeed(env);
  if (feed.status !== "healthy" && feed.status !== "partial") throw new Error(`feed_status_${feed.status}`);
  const ingest = await ingestItems(env, feed.items || []);
  await flushTelegram(env);
  return { feed, ingest };
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function hex(buffer) { return [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, "0")).join(""); }

async function readBodyLimited(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function sha256Hex(value) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function verifyKrishaWebhook(request, rawBody, env) {
  const secret = String(env.KRISHA_MODERATION_WEBHOOK_SECRET || "");
  const timestamp = request.headers.get("x-krisha-timestamp") || "";
  const signature = request.headers.get("x-krisha-signature") || "";
  if (secret.length < 32 || !/^\d{10}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > WEBHOOK_MAX_SKEW_SECONDS) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const timestampBytes = new TextEncoder().encode(`${timestamp}.`);
    const signedBytes = new Uint8Array(timestampBytes.length + rawBody.length);
    signedBytes.set(timestampBytes, 0);
    signedBytes.set(rawBody, timestampBytes.length);
    const expected = `sha256=${hex(await crypto.subtle.sign("HMAC", key, signedBytes))}`;
    return constantTimeEqual(expected.toLowerCase(), signature.toLowerCase());
  } catch { return false; }
}

function textField(value, maxLength) {
  if (typeof value !== "string") return "";
  return clean(value).slice(0, maxLength);
}

function boundedNumber(value, max) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

function normalizeModerationEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.schema_version !== 1) return null;
  const listing = body.listing;
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) return null;
  const eventId = textField(body.event_id, 128);
  const listingId = textField(listing.source_id || listing.id, 32);
  const isIsoTimestamp = typeof body.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.occurred_at);
  const occurredAt = isIsoTimestamp && Number.isFinite(Date.parse(body.occurred_at)) ? new Date(body.occurred_at).toISOString() : "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId) || !/^\d{5,20}$/.test(listingId) || !occurredAt || body.event_type !== "listing.submitted_for_moderation") return null;
  const priceKzt = boundedNumber(listing.price_kzt, 1_000_000_000_000);
  const rooms = boundedNumber(listing.rooms, 100);
  const areaM2 = boundedNumber(listing.area_m2, 1_000_000);
  if ((listing.price_kzt !== null && listing.price_kzt !== undefined && priceKzt === null) ||
      (listing.rooms !== null && listing.rooms !== undefined && (rooms === null || !Number.isInteger(rooms))) ||
      (listing.area_m2 !== null && listing.area_m2 !== undefined && areaM2 === null)) return null;
  return {
    event_id: eventId,
    event_type: body.event_type,
    occurred_at: occurredAt,
    listing_id: listingId,
    city: textField(listing.city, 100),
    category: textField(listing.category, 80),
    price_kzt: priceKzt,
    rooms,
    area_m2: areaM2
  };
}

function parseSubscriptionNumber(value, max) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : NaN;
}

function normalizeModerationSubscription(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const name = textField(body.agency_name, 100);
  const chatId = textField(body.telegram_chat_id, 64);
  if (!name || !(/^-?\d{1,24}$/.test(chatId) || /^@[A-Za-z0-9_]{5,32}$/.test(chatId))) return null;
  const result = {
    agency_name: name,
    city: textField(body.city, 100),
    category: textField(body.category, 80),
    rooms_min: parseSubscriptionNumber(body.rooms_min, 100),
    rooms_max: parseSubscriptionNumber(body.rooms_max, 100),
    price_min_kzt: parseSubscriptionNumber(body.price_min_kzt, 1_000_000_000_000),
    price_max_kzt: parseSubscriptionNumber(body.price_max_kzt, 1_000_000_000_000),
    area_min_m2: parseSubscriptionNumber(body.area_min_m2, 1_000_000),
    area_max_m2: parseSubscriptionNumber(body.area_max_m2, 1_000_000),
    telegram_chat_id: chatId
  };
  if (Object.values(result).some(value => typeof value === "number" && Number.isNaN(value))) return null;
  if (result.rooms_min !== null && result.rooms_max !== null && result.rooms_min > result.rooms_max) return null;
  if (result.price_min_kzt !== null && result.price_max_kzt !== null && result.price_min_kzt > result.price_max_kzt) return null;
  if (result.area_min_m2 !== null && result.area_max_m2 !== null && result.area_min_m2 > result.area_max_m2) return null;
  return result;
}

function moderationSubscriptionAuthorized(request, env) {
  const expected = String(env.KRISHA_MODERATION_ADMIN_KEY || "");
  if (expected.length < 32) return false;
  const supplied = request.headers.get("x-krisha-moderation-admin-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  return constantTimeEqual(expected, supplied);
}

function moderationMatches(subscription, event) {
  const sameText = (filter, value) => !filter || (value && filter.toLocaleLowerCase() === value.toLocaleLowerCase());
  if (!sameText(subscription.city, event.city) || !sameText(subscription.category, event.category)) return false;
  for (const [min, max, field] of [["rooms_min", "rooms_max", "rooms"], ["price_min_kzt", "price_max_kzt", "price_kzt"], ["area_min_m2", "area_max_m2", "area_m2"]]) {
    const value = event[field];
    if ((subscription[min] !== null && subscription[min] !== undefined || subscription[max] !== null && subscription[max] !== undefined) && value === null) return false;
    if (subscription[min] !== null && subscription[min] !== undefined && value < subscription[min]) return false;
    if (subscription[max] !== null && subscription[max] !== undefined && value > subscription[max]) return false;
  }
  return true;
}

function escapeHtml(value) { return clean(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
function formatModerationNumber(value) { return value === null || value === undefined ? "" : Number(value).toLocaleString("ru-RU"); }

function moderationTelegramMessage(event, subscription) {
  const lines = ["🔔 <b>Новое объявление отправлено на модерацию</b>", `ID: <code>${escapeHtml(event.listing_id)}</code>`];
  if (event.category) lines.push(`Тип: ${escapeHtml(event.category)}`);
  if (event.city) lines.push(`Город: ${escapeHtml(event.city)}`);
  if (event.price_kzt !== null) lines.push(`Цена: ${formatModerationNumber(event.price_kzt)} ₸`);
  if (event.rooms !== null) lines.push(`Комнат: ${formatModerationNumber(event.rooms)}`);
  if (event.area_m2 !== null) lines.push(`Площадь: ${formatModerationNumber(event.area_m2)} м²`);
  lines.push(`Время подачи: ${escapeHtml(event.occurred_at)}`, `Профиль: ${escapeHtml(subscription.agency_name)}`);
  return lines.join("\n");
}

async function flushModerationTelegram(env) {
  const database = db(env);
  if (!database) return { sent: 0, skipped: true };
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: 0, skipped: true };
  const rows = await database.prepare("SELECT * FROM krisha_moderation_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 25").bind(now()).all();
  let sent = 0;
  for (const row of rows.results || []) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: row.chat_id, text: row.telegram_html, parse_mode: "HTML", disable_web_page_preview: true })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(`telegram_http_${response.status}`);
      await database.prepare("UPDATE krisha_moderation_outbox SET status='sent',sent_at=?,attempts=attempts+1,last_error=NULL,telegram_html='' WHERE id=?").bind(now(), row.id).run();
      sent++;
    } catch (error) {
      const attempts = Math.min(Number(row.attempts || 0) + 1, 10);
      const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(attempts - 1, 7)));
      await database.prepare("UPDATE krisha_moderation_outbox SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=?").bind(clean(error.message || error).slice(0, 160), new Date(Date.now() + delaySeconds * 1000).toISOString(), row.id).run();
    }
  }
  return { sent, skipped: false };
}

async function handleModerationWebhook(request, env) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return json({ error: "json_required" }, 415);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_MODERATION_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const rawBody = await readBodyLimited(request, MAX_MODERATION_BODY_BYTES);
  if (!rawBody) return json({ error: "payload_too_large" }, 413);
  if (!await verifyKrishaWebhook(request, rawBody, env)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = JSON.parse(new TextDecoder().decode(rawBody)); }
  catch { return json({ error: "invalid_json" }, 400); }
  const event = normalizeModerationEvent(body);
  if (!event) return json({ error: "invalid_moderation_event" }, 400);
  const database = db(env);
  if (!database) return json({ error: "persistence_unavailable" }, 503);
  const canonical = JSON.stringify(event);
  const payloadHash = await sha256Hex(canonical);
  const existing = await database.prepare("SELECT payload_hash FROM krisha_moderation_events WHERE event_id=?").bind(event.event_id).first();
  if (existing && !constantTimeEqual(existing.payload_hash, payloadHash)) return json({ error: "event_id_conflict" }, 409);
  const receivedAt = now();
  if (!existing) {
    await database.prepare("INSERT OR IGNORE INTO krisha_moderation_events (event_id,listing_id,event_type,city,category,price_kzt,rooms,area_m2,occurred_at,received_at,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(event.event_id, event.listing_id, event.event_type, event.city || null, event.category || null, event.price_kzt, event.rooms, event.area_m2, event.occurred_at, receivedAt, payloadHash).run();
    const stored = await database.prepare("SELECT payload_hash FROM krisha_moderation_events WHERE event_id=?").bind(event.event_id).first();
    if (!stored || !constantTimeEqual(stored.payload_hash, payloadHash)) return json({ error: "event_id_conflict" }, 409);
  }
  const subscriptions = await database.prepare("SELECT * FROM krisha_moderation_subscriptions WHERE enabled=1").all();
  let queued = 0;
  for (const subscription of subscriptions.results || []) {
    if (!moderationMatches(subscription, event)) continue;
    const result = await database.prepare("INSERT OR IGNORE INTO krisha_moderation_outbox (event_id,chat_id,telegram_html,status,attempts,next_attempt_at) VALUES (?,?,?,'pending',0,?)").bind(event.event_id, subscription.telegram_chat_id, moderationTelegramMessage(event, subscription), receivedAt).run();
    queued += Number(result.meta?.changes || 0);
  }
  const delivery = await flushModerationTelegram(env);
  return json({ accepted: true, duplicate: Boolean(existing), deliveries_queued: queued, deliveries_sent: delivery.sent }, 202);
}

async function handleModerationSubscriptions(request, env, url) {
  if (!moderationSubscriptionAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
  const database = db(env);
  if (!database) return json({ error: "persistence_unavailable" }, 503);
  if (url.pathname === KRISHA_MODERATION_SUBSCRIPTIONS_PATH && request.method === "GET") {
    const rows = await database.prepare("SELECT * FROM krisha_moderation_subscriptions ORDER BY created_at DESC").all();
    return json({ items: rows.results || [] });
  }
  if (url.pathname === KRISHA_MODERATION_SUBSCRIPTIONS_PATH && request.method === "POST") {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return json({ error: "json_required" }, 415);
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > 16 * 1024) return json({ error: "payload_too_large" }, 413);
    const rawBody = await readBodyLimited(request, 16 * 1024);
    if (!rawBody) return json({ error: "payload_too_large" }, 413);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(rawBody)); }
    catch { return json({ error: "invalid_json" }, 400); }
    const subscription = normalizeModerationSubscription(body);
    if (!subscription) return json({ error: "invalid_subscription" }, 400);
    const createdAt = now(), subscriptionId = id();
    await database.prepare("INSERT INTO krisha_moderation_subscriptions (id,agency_name,city,category,rooms_min,rooms_max,price_min_kzt,price_max_kzt,area_min_m2,area_max_m2,telegram_chat_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)").bind(subscriptionId, subscription.agency_name, subscription.city || null, subscription.category || null, subscription.rooms_min, subscription.rooms_max, subscription.price_min_kzt, subscription.price_max_kzt, subscription.area_min_m2, subscription.area_max_m2, subscription.telegram_chat_id, createdAt, createdAt).run();
    return json({ item: { id: subscriptionId, ...subscription, enabled: 1, created_at: createdAt, updated_at: createdAt } }, 201);
  }
  const deleteMatch = url.pathname.match(new RegExp(`^${KRISHA_MODERATION_SUBSCRIPTIONS_PATH}/([A-Za-z0-9-]{36})$`));
  if (deleteMatch && request.method === "DELETE") {
    const result = await database.prepare("DELETE FROM krisha_moderation_subscriptions WHERE id=?").bind(deleteMatch[1]).run();
    return json({ deleted: Number(result.meta?.changes || 0) > 0 });
  }
  return json({ error: "method_not_allowed" }, 405);
}

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === KRISHA_MODERATION_PATH) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    return handleModerationWebhook(request, env);
  }
  if (url.pathname === KRISHA_MODERATION_SUBSCRIPTIONS_PATH || url.pathname.startsWith(`${KRISHA_MODERATION_SUBSCRIPTIONS_PATH}/`)) return handleModerationSubscriptions(request, env, url);
  if (url.pathname === "/api/health") return json({ service: "estate-radar", status: "ok", version: "2.1.0", parser: "BeautifulSoup/html.parser", persistence: db(env) ? "d1" : "unavailable" });
  if (url.pathname === "/api/source-status") { try { const feed = await readFeed(env); return json({ source: feed.source, status: feed.status, parser: feed.parser, parser_version: feed.parser_version, count: feed.count, updated_at: feed.updated_at, checked_at: feed.checked_at || feed.updated_at, poll_interval_minutes: feed.poll_interval_minutes || 5, checked_urls: feed.checked_urls || [], failed_urls: feed.failed_urls, persistence: db(env) ? "d1" : "unavailable" }); } catch (error) { return json({ source: "krisha.kz", status: "awaiting_first_scan", parser: "BeautifulSoup/html.parser", message: clean(error.message || error), persistence: db(env) ? "d1" : "unavailable" }, 503); } }
  if (url.pathname === "/api/events" && request.method === "GET") { try { const { feed, ingest } = await syncFeed(env); const items = await listEvents(env); return json({ items: items.length ? items : feed.items || [], source: { source: feed.source, status: feed.status, parser: feed.parser, updated_at: feed.updated_at, checked_at: feed.checked_at || feed.updated_at }, ingest }); } catch (error) { return json({ items: await listEvents(env), source: { source: "krisha.kz", status: "awaiting_first_scan", parser: "BeautifulSoup/html.parser", message: clean(error.message || error) }, ingest: null }); } }
  if (url.pathname === "/api/profiles" && request.method === "GET") { const rows = db(env) ? await env.DB.prepare("SELECT * FROM profiles ORDER BY created_at DESC").all() : { results: [] }; return json({ items: rows.results || [] }); }
  if (url.pathname === "/api/profiles" && request.method === "POST") { if (!authorized(request, env)) return json({ error: "unauthorized" }, 401); const body = await request.json(); const profile = { id: id(), name: clean(body.name || "Новый профиль"), city: clean(body.city), rooms_min: number(body.rooms_min), rooms_max: number(body.rooms_max), price_max_kzt: number(body.price_max_kzt), area_min_m2: number(body.area_min_m2), telegram_chat_id: clean(body.telegram_chat_id), enabled: 1, created_at: now(), updated_at: now() }; if (!db(env)) return json(profile, 201); await env.DB.prepare("INSERT INTO profiles (id,name,city,rooms_min,rooms_max,price_max_kzt,area_min_m2,telegram_chat_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(profile.id,profile.name,profile.city,profile.rooms_min,profile.rooms_max,profile.price_max_kzt,profile.area_min_m2,profile.telegram_chat_id,1,profile.created_at,profile.updated_at).run(); return json(profile, 201); }
  if (url.pathname === "/api/claims" && request.method === "POST") { if (!authorized(request, env)) return json({ error: "unauthorized" }, 401); const body = await request.json(); if (!db(env) || !body.source_id) return json({ ok: true, source_id: body.source_id, agent_name: body.agent_name || "Алексей Ким" }); await env.DB.prepare("INSERT INTO claims (source_id,agent_name,claimed_at) VALUES (?,?,?) ON CONFLICT(source_id) DO UPDATE SET agent_name=excluded.agent_name,claimed_at=excluded.claimed_at").bind(String(body.source_id),clean(body.agent_name || "Алексей Ким"),now()).run(); return json({ ok: true, source_id: body.source_id, agent_name: body.agent_name || "Алексей Ким" }); }
  if (url.pathname === "/api/ingest" && request.method === "POST") { if (!authorized(request, env)) return json({ error: "unauthorized" }, 401); const body = await request.json(), items = Array.isArray(body) ? body : body.items; if (!Array.isArray(items)) return json({ error: "items_required" }, 400); return json(await ingestItems(env, items)); }
  if (url.pathname === "/api/telegram/test" && request.method === "POST") { if (!authorized(request, env)) return json({ error: "unauthorized" }, 401); return json(await flushTelegram(env)); }
  if (url.pathname === "/api/telegram/webhook" && request.method === "POST") { const body = await request.json().catch(() => ({})); return json({ ok: true, received: Boolean(body.update_id) }); }
  const asset = assets[url.pathname] || assets["/"]; return new Response(asset.body, { headers: { "content-type": asset.type, "cache-control": "no-cache" } });
}

const worker = { fetch: route, async scheduled(controller, env, ctx) { ctx.waitUntil((async () => { try { await syncFeed(env); } catch (error) { console.error("feed_sync_failed", clean(error.message || error)); await flushTelegram(env); } await flushModerationTelegram(env); })()); } };
