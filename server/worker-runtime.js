const now = () => new Date().toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const clean = value => String(value ?? "").replace(/\s+/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").trim();
const number = value => { const raw = String(value ?? "").replace(/[^0-9.,]/g, "").replace(/\s/g, "").replace(",", "."); const parsed = Number(raw); return Number.isFinite(parsed) ? parsed : null; };
const id = () => crypto.randomUUID();
const db = env => env.DB && typeof env.DB.prepare === "function" ? env.DB : null;
const authorized = (request, env) => !env.INGEST_API_KEY || request.headers.get("x-estate-radar-key") === env.INGEST_API_KEY || request.headers.get("authorization") === `Bearer ${env.INGEST_API_KEY}`;

function sourceInfo(env, extra = {}) {
  return { mode: env.KRISHA_SOURCE_MODE || "demo", source: "krisha.kz", status: env.KRISHA_SOURCE_URL ? "configured" : "awaiting_configuration", message: env.KRISHA_SOURCE_URL ? "Авторизованный канал настроен." : "Укажите KRISHA_SOURCE_URL в секретах Site.", ...extra };
}

async function fetchSource(env) {
  const status = sourceInfo(env);
  if (!env.KRISHA_SOURCE_URL) return { items: [], source: status };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.KRISHA_SOURCE_TIMEOUT_MS || 12000));
  try {
    const response = await fetch(env.KRISHA_SOURCE_URL, { headers: { accept: "application/json, text/html;q=0.9", "user-agent": "EstateRadar/1.0 authorized-source" }, signal: controller.signal });
    if (!response.ok) throw new Error(`source_http_${response.status}`);
    const type = response.headers.get("content-type") || "";
    const raw = await response.text();
    let items = [];
    if (type.includes("json") || raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.data || []);
    } else {
      const seen = new Set();
      for (const match of raw.matchAll(/href=["']([^"']*\/a\/show\/([0-9]+))[^"']*["'][^>]*>([\s\S]{0,600})<\/a>/gi)) {
        if (seen.has(match[2])) continue;
        seen.add(match[2]);
        const text = clean(match[3]);
        items.push({ source_id: match[2], url: new URL(match[1], env.KRISHA_SOURCE_URL).toString(), title: text, raw_title: text });
      }
    }
    return { items: items.map(normalize), source: sourceInfo(env, { status: "healthy", count: items.length, last_successful_observation: now() }) };
  } catch (error) {
    return { items: [], source: sourceInfo(env, { status: "error", message: clean(error.message || error) }) };
  } finally { clearTimeout(timer); }
}

function normalize(item) {
  const sourceId = String(item.source_id || item.id || "").match(/[0-9]+/)?.[0] || "";
  return { source_id: sourceId, source: "krisha.kz", url: String(item.url || `https://krisha.kz/a/show/${sourceId}`), title: clean(item.title || item.raw_title || "Объект без названия"), description: clean(item.description), price_kzt: number(item.price_kzt ?? item.price), rooms: number(item.rooms), area_m2: number(item.area_m2 ?? item.area), floor: number(item.floor), floors_total: number(item.floors_total), address: clean(item.address), city: clean(item.city), district: clean(item.district), residential_complex: clean(item.residential_complex), seller_label: clean(item.seller_label), photo_urls: Array.isArray(item.photo_urls) ? item.photo_urls : [], raw: item };
}

function fingerprint(item) { return [item.price_kzt || "", item.title, item.address, item.rooms || "", item.area_m2 || ""].join("|").toLowerCase(); }
function matches(profile, item) {
  return (!profile.city || !item.city || profile.city === item.city) && (!profile.rooms_min || (item.rooms || 0) >= profile.rooms_min) && (!profile.rooms_max || (item.rooms || 0) <= profile.rooms_max) && (!profile.price_max_kzt || (item.price_kzt || 0) <= profile.price_max_kzt) && (!profile.area_min_m2 || (item.area_m2 || 0) >= profile.area_min_m2);
}

async function ingestItems(env, items) {
  const database = db(env); if (!database) return { inserted: 0, changed: 0, events: [] };
  let inserted = 0, changed = 0; const events = [];
  for (const raw of items.map(normalize).filter(item => item.source_id)) {
    const item = { ...raw, fingerprint: fingerprint(raw), observed: now() };
    const previous = await database.prepare("SELECT source_id, price_kzt, fingerprint FROM listings WHERE source_id = ?").bind(item.source_id).first();
    const eventType = !previous ? "new" : (previous.price_kzt && item.price_kzt && Number(previous.price_kzt) !== Number(item.price_kzt) ? "price" : null);
    await database.prepare(`INSERT INTO listings (source_id,source,url,title,description,price_kzt,rooms,area_m2,floor,floors_total,address,city,district,residential_complex,seller_label,photo_urls_json,fingerprint,first_seen_at,last_seen_at,last_price_kzt,status,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET source=excluded.source,url=excluded.url,title=excluded.title,description=excluded.description,price_kzt=excluded.price_kzt,rooms=excluded.rooms,area_m2=excluded.area_m2,floor=excluded.floor,floors_total=excluded.floors_total,address=excluded.address,city=excluded.city,district=excluded.district,residential_complex=excluded.residential_complex,seller_label=excluded.seller_label,photo_urls_json=excluded.photo_urls_json,fingerprint=excluded.fingerprint,last_seen_at=excluded.last_seen_at,last_price_kzt=listings.price_kzt,status='active',raw_json=excluded.raw_json`).bind(item.source_id,item.source,item.url,item.title,item.description,item.price_kzt,item.rooms,item.area_m2,item.floor,item.floors_total,item.address,item.city,item.district,item.residential_complex,item.seller_label,JSON.stringify(item.photo_urls),item.fingerprint,item.observed,item.observed,item.price_kzt,"active",JSON.stringify(item.raw)).run();
    if (!previous) inserted++; if (eventType) changed++;
    if (eventType) {
      const eventId = id(); const payload = { ...item, event_type: eventType };
      const result = await database.prepare("INSERT OR IGNORE INTO events (id,source_id,event_type,fingerprint,observed_at,payload_json) VALUES (?,?,?,?,?,?)").bind(eventId,item.source_id,eventType,item.fingerprint,item.observed,JSON.stringify(payload)).run();
      if (result.meta?.changes) { events.push({ id: eventId, ...payload }); }
    }
  }
  if (events.length) {
    const profiles = await database.prepare("SELECT * FROM profiles WHERE enabled = 1 AND telegram_chat_id IS NOT NULL AND telegram_chat_id != ''").all();
    for (const event of events) for (const profile of profiles.results || []) if (matches(profile, event)) await database.prepare("INSERT OR IGNORE INTO telegram_outbox (event_id,chat_id,payload_json,status,attempts,next_attempt_at) VALUES (?,?,?,'pending',0,?)").bind(event.id,profile.telegram_chat_id,JSON.stringify({ ...event, profile: profile.name }),now()).run();
  }
  return { inserted, changed, events };
}

async function syncSource(env) {
  const result = await fetchSource(env); const database = db(env);
  if (database) await database.prepare("INSERT INTO source_state (source,mode,status,last_successful_observation,last_error,updated_at) VALUES ('krisha.kz',?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET mode=excluded.mode,status=excluded.status,last_successful_observation=excluded.last_successful_observation,last_error=excluded.last_error,updated_at=excluded.updated_at").bind(result.source.mode,result.source.status,result.source.last_successful_observation || null,result.source.status === "error" ? result.source.message : null,now()).run();
  if (result.source.status === "healthy") return { ...result, ingest: await ingestItems(env, result.items) };
  return { ...result, ingest: { inserted: 0, changed: 0, events: [] } };
}

async function flushTelegram(env) {
  const database = db(env); if (!database || !env.TELEGRAM_BOT_TOKEN) return { sent: 0, skipped: true };
  const rows = await database.prepare("SELECT * FROM telegram_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT 25").bind(now()).all(); let sent = 0;
  for (const row of rows.results || []) {
    const event = JSON.parse(row.payload_json); const price = event.price_kzt ? `${Number(event.price_kzt).toLocaleString("ru-RU")} ₸` : "цена не указана";
    const text = `${event.event_type === "new" ? "🆕 Новый объект" : "📉 Изменение цены"}\n<b>${clean(event.title)}</b>\n${clean(event.address)}\n${price}\n<a href="${event.url}">Открыть на Krisha.kz</a>\nПрофиль: ${clean(event.profile)}`;
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: row.chat_id, text, parse_mode: "HTML", disable_web_page_preview: false }) });
      if (!response.ok) throw new Error(`telegram_http_${response.status}`);
      await database.prepare("UPDATE telegram_outbox SET status='sent',sent_at=?,attempts=attempts+1,last_error=NULL WHERE id=?").bind(now(),row.id).run(); sent++;
    } catch (error) { await database.prepare("UPDATE telegram_outbox SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=?").bind(clean(error.message || error),new Date(Date.now()+60000).toISOString(),row.id).run(); }
  }
  return { sent, skipped: false };
}

async function listEvents(env) {
  const database = db(env); if (!database) return [];
  const rows = await database.prepare("SELECT e.id,e.event_type,e.observed_at,e.payload_json,l.source_id,l.url,l.title,l.description,l.price_kzt,l.rooms,l.area_m2,l.floor,l.floors_total,l.address,l.city,l.district,l.residential_complex,l.seller_label,c.agent_name FROM events e JOIN listings l ON l.source_id=e.source_id LEFT JOIN claims c ON c.source_id=l.source_id ORDER BY e.observed_at DESC LIMIT 100").all();
  return (rows.results || []).map(row => ({ ...JSON.parse(row.payload_json || "{}"), id: row.id, event_type: row.event_type, observed_at: row.observed_at, claimed_by: row.agent_name || null, price_kzt: row.price_kzt, title: row.title, address: row.address, city: row.city, description: row.description, rooms: row.rooms, area_m2: row.area_m2, floor: row.floor, floors_total: row.floors_total, url: row.url }));
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return json({ service: "estate-radar", status: "ok", version: "2.0.0", persistence: db(env) ? "d1" : "unavailable" });
  if (url.pathname === "/api/source-status") { const result = await fetchSource(env); return json({ ...result.source, persistence: db(env) ? "d1" : "unavailable" }, result.source.status === "error" ? 502 : 200); }
  if (url.pathname === "/api/events" && request.method === "GET") { const sync = url.searchParams.get("sync") === "1"; const result = sync ? await syncSource(env) : null; return json({ items: await listEvents(env), source: result?.source || sourceInfo(env), ingest: result?.ingest || null }); }
  if (url.pathname === "/api/profiles" && request.method === "GET") { const rows = db(env) ? await env.DB.prepare("SELECT * FROM profiles ORDER BY created_at DESC").all() : { results: [] }; return json({ items: rows.results || [] }); }
  if (url.pathname === "/api/profiles" && request.method === "POST") { if (!authorized(request, env)) return json({ error: "unauthorized" }, 401); const body = await request.json(); const profile = { id: id(), name: clean(body.name || "Новый профиль"), city: clean(body.city), rooms_min: number(body.rooms_min), rooms_max: number(body.rooms_max), price_max_kzt: number(body.price_max_kzt), area_min_m2: number(body.area_min_m2), telegram_chat_id: clean(body.telegram_chat_id), enabled: 1, created_at: now(), updated_at: now() }; if (!db(env)) return json(profile, 201); await env.DB.prepare("INSERT INTO profiles (id,name,city,rooms_min,rooms_max,price_max_kzt,area_min_m2,telegram_chat_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(profile.id,profile.name,profile.city,profile.rooms_min,profile.rooms_max,profile.price_max_kzt,profile.area_min_m2,profile.telegram_chat_id,1,profile.created_at,profile.updated_at).run(); return json(profile, 201); }
  if (url.pathname === "/api/claims" && request.method === "POST") { if (!authorized(request, env)) return json({ error: "unauthorized" }, 401); const body = await request.json(); if (!db(env) || !body.source_id) return json({ ok: true, source_id: body.source_id, agent_name: body.agent_name || "Алексей Ким" }); await env.DB.prepare("INSERT INTO claims (source_id,agent_name,claimed_at) VALUES (?,?,?) ON CONFLICT(source_id) DO UPDATE SET agent_name=excluded.agent_name,claimed_at=excluded.claimed_at").bind(String(body.source_id),clean(body.agent_name || "Алексей Ким"),now()).run(); return json({ ok: true, source_id: body.source_id, agent_name: body.agent_name || "Алексей Ким" }); }
  if (url.pathname === "/api/ingest" && request.method === "POST") { if (!authorized(request, env)) return json({ error: "unauthorized" }, 401); const body = await request.json(); const items = Array.isArray(body) ? body : body.items; if (!Array.isArray(items)) return json({ error: "items_required" }, 400); return json(await ingestItems(env, items)); }
  if (url.pathname === "/api/telegram/test" && request.method === "POST") { if (!authorized(request, env)) return json({ error: "unauthorized" }, 401); return json(await flushTelegram(env)); }
  if (url.pathname === "/api/telegram/webhook" && request.method === "POST") { const body = await request.json().catch(() => ({})); return json({ ok: true, received: Boolean(body.update_id) }); }
  const asset = assets[url.pathname] || assets["/"]; return new Response(asset.body, { headers: { "content-type": asset.type, "cache-control": "no-cache" } });
}

const worker = { fetch: route, async scheduled(controller, env, ctx) { ctx.waitUntil((async () => { await syncSource(env); await flushTelegram(env); })()); } };

