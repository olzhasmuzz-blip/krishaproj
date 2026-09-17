import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import worker from "../dist/server/index.js";

const EVENT_URL = "https://estate-radar.test/api/integrations/krisha/moderation/events";
const SUBSCRIPTIONS_URL = "https://estate-radar.test/api/integrations/krisha/moderation/subscriptions";
const WEBHOOK_SECRET = "webhook-secret-for-tests-0123456789abcdef";
const ADMIN_KEY = "admin-secret-for-tests-0123456789abcdef";

class FakeStatement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new FakeStatement(this.database, this.sql, values); }
  async first() {
    if (this.sql.includes("FROM krisha_moderation_events WHERE event_id=?")) return this.database.events.get(this.values[0]) || null;
    return null;
  }
  async all() {
    if (this.sql.includes("FROM krisha_moderation_subscriptions WHERE enabled=1")) return { results: this.database.subscriptions.filter(item => item.enabled === 1) };
    if (this.sql.includes("FROM krisha_moderation_subscriptions ORDER BY")) return { results: [...this.database.subscriptions] };
    if (this.sql.includes("FROM krisha_moderation_outbox")) {
      return { results: [...this.database.outbox.values()].filter(item => item.status === "pending" && item.next_attempt_at <= this.values[0]).sort((a, b) => a.id - b.id).slice(0, 25) };
    }
    return { results: [] };
  }
  async run() {
    if (this.sql.includes("INSERT OR IGNORE INTO krisha_moderation_events")) {
      const [event_id, listing_id, event_type, city, category, price_kzt, rooms, area_m2, occurred_at, received_at, payload_hash] = this.values;
      if (this.database.events.has(event_id)) return { meta: { changes: 0 } };
      this.database.events.set(event_id, { event_id, listing_id, event_type, city, category, price_kzt, rooms, area_m2, occurred_at, received_at, payload_hash });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT OR IGNORE INTO krisha_moderation_outbox")) {
      const [event_id, chat_id, telegram_html, next_attempt_at] = this.values;
      const key = `${event_id}:${chat_id}`;
      if (this.database.outbox.has(key)) return { meta: { changes: 0 } };
      const row = { id: ++this.database.outboxId, event_id, chat_id, telegram_html, status: "pending", attempts: 0, next_attempt_at };
      this.database.outbox.set(key, row);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE krisha_moderation_outbox SET status='sent'")) {
      const row = [...this.database.outbox.values()].find(item => item.id === this.values[1]);
      if (row) Object.assign(row, { status: "sent", sent_at: this.values[0], telegram_html: "", attempts: row.attempts + 1 });
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.includes("UPDATE krisha_moderation_outbox SET attempts=attempts+1")) {
      const row = [...this.database.outbox.values()].find(item => item.id === this.values[2]);
      if (row) Object.assign(row, { attempts: row.attempts + 1, last_error: this.values[0], next_attempt_at: this.values[1] });
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.includes("INSERT INTO krisha_moderation_subscriptions")) {
      const [id, agency_name, city, category, rooms_min, rooms_max, price_min_kzt, price_max_kzt, area_min_m2, area_max_m2, telegram_chat_id, created_at, updated_at] = this.values;
      this.database.subscriptions.push({ id, agency_name, city, category, rooms_min, rooms_max, price_min_kzt, price_max_kzt, area_min_m2, area_max_m2, telegram_chat_id, enabled: 1, created_at, updated_at });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("DELETE FROM krisha_moderation_subscriptions")) {
      const before = this.database.subscriptions.length;
      this.database.subscriptions = this.database.subscriptions.filter(item => item.id !== this.values[0]);
      return { meta: { changes: before - this.database.subscriptions.length } };
    }
    throw new Error(`Unhandled fake D1 statement: ${this.sql}`);
  }
}

class FakeD1 {
  constructor(subscriptions = []) { this.events = new Map(); this.subscriptions = subscriptions; this.outbox = new Map(); this.outboxId = 0; }
  prepare(sql) { return new FakeStatement(this, sql); }
}

function fixture(overrides = {}) {
  return {
    schema_version: 1,
    event_id: "krisha-evt-2026-09-17-1",
    event_type: "listing.submitted_for_moderation",
    occurred_at: new Date().toISOString(),
    listing: {
      source_id: "1012345678",
      city: "Астана",
      category: "Продажа квартир",
      price_kzt: 45000000,
      rooms: 2,
      area_m2: 58,
      owner_phone: "+7 777 123 45 67",
      address: "Тестовая улица, 1",
      description: "частные сведения не должны уходить в уведомление"
    },
    ...overrides
  };
}

async function signedRequest(payload, { timestamp = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
  return new Request(EVENT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-krisha-timestamp": String(timestamp), "x-krisha-signature": `sha256=${signature}` },
    body: raw
  });
}

test("rejects missing, invalid, and stale signatures before touching D1", async () => {
  const database = new FakeD1();
  const unsigned = await worker.fetch(new Request(EVENT_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture()) }), { DB: database });
  assert.equal(unsigned.status, 401);
  const staleRequest = await signedRequest(fixture(), { timestamp: Math.floor(Date.now() / 1000) - 600 });
  const stale = await worker.fetch(staleRequest, { DB: database, KRISHA_MODERATION_WEBHOOK_SECRET: WEBHOOK_SECRET });
  assert.equal(stale.status, 401);
  assert.equal(database.events.size, 0);
});

test("accepts a signed moderation event, filters recipients, and sends only minimal fields", async t => {
  const database = new FakeD1([
    { id: "one", agency_name: "Астана 2к", city: "Астана", category: "Продажа квартир", rooms_min: 2, rooms_max: 2, price_min_kzt: null, price_max_kzt: 50000000, area_min_m2: null, area_max_m2: null, telegram_chat_id: "-1001234567890", enabled: 1 },
    { id: "two", agency_name: "Алматы", city: "Алматы", category: "Продажа квартир", rooms_min: null, rooms_max: null, price_min_kzt: null, price_max_kzt: null, area_min_m2: null, area_max_m2: null, telegram_chat_id: "-1001234567891", enabled: 1 }
  ]);
  const sent = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const request = await signedRequest(fixture());
  const response = await worker.fetch(request, { DB: database, KRISHA_MODERATION_WEBHOOK_SECRET: WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN: "test-token" });
  const result = await response.json();
  assert.equal(response.status, 202);
  assert.deepEqual(result, { accepted: true, duplicate: false, deliveries_queued: 1, deliveries_sent: 1 });
  assert.equal(database.events.size, 1);
  assert.equal(database.outbox.size, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, "-1001234567890");
  assert.match(sent[0].body.text, /1012345678/);
  assert.match(sent[0].body.text, /Астана/);
  assert.doesNotMatch(sent[0].body.text, /777 123|Тестовая улица|частные сведения/);
  assert.equal([...database.outbox.values()][0].telegram_html, "");
});

test("treats an identical event as idempotent and rejects a changed event with the same ID", async t => {
  const database = new FakeD1([
    { id: "one", agency_name: "Профиль", city: "", category: "", rooms_min: null, rooms_max: null, price_min_kzt: null, price_max_kzt: null, area_min_m2: null, area_max_m2: null, telegram_chat_id: "-1001234567890", enabled: 1 }
  ]);
  const originalFetch = globalThis.fetch;
  let telegramCalls = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { telegramCalls++; return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  const env = { DB: database, KRISHA_MODERATION_WEBHOOK_SECRET: WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN: "test-token" };
  const payload = fixture();
  const first = await worker.fetch(await signedRequest(payload), env);
  const duplicate = await worker.fetch(await signedRequest(payload), env);
  const changed = fixture({ listing: { ...payload.listing, price_kzt: 46000000 } });
  const conflict = await worker.fetch(await signedRequest(changed), env);
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(conflict.status, 409);
  assert.equal(telegramCalls, 1);
  assert.equal(database.events.size, 1);
  assert.equal(database.outbox.size, 1);
});

test("does not expose the premoderation event route or subscriptions without their required credentials", async () => {
  const database = new FakeD1();
  const env = { DB: database };
  const unsignedSubscriptions = await worker.fetch(new Request(SUBSCRIPTIONS_URL), env);
  const methodMismatch = await worker.fetch(new Request(EVENT_URL), env);
  assert.equal(unsignedSubscriptions.status, 401);
  assert.equal(methodMismatch.status, 405);
});

test("admin subscription API validates filters and is unavailable without its separate admin key", async () => {
  const database = new FakeD1();
  const request = new Request(SUBSCRIPTIONS_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` }, body: JSON.stringify({ agency_name: "Астана", city: "Астана", category: "Продажа квартир", rooms_min: 3, rooms_max: 1, telegram_chat_id: "-1001234567890" }) });
  const response = await worker.fetch(request, { DB: database, KRISHA_MODERATION_ADMIN_KEY: ADMIN_KEY });
  assert.equal(response.status, 400);
  assert.equal(database.subscriptions.length, 0);
  const missingKey = await worker.fetch(new Request(SUBSCRIPTIONS_URL), { DB: database });
  assert.equal(missingKey.status, 401);
});

test("admin can create a scoped Telegram subscription with the separate management key", async () => {
  const database = new FakeD1();
  const request = new Request(SUBSCRIPTIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({ agency_name: "Астана 2к", city: "Астана", category: "Продажа квартир", rooms_min: 2, rooms_max: 2, price_max_kzt: 50000000, telegram_chat_id: "-1001234567890" })
  });
  const response = await worker.fetch(request, { DB: database, KRISHA_MODERATION_ADMIN_KEY: ADMIN_KEY });
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.equal(database.subscriptions.length, 1);
  assert.equal(result.item.city, "Астана");
  assert.equal(result.item.telegram_chat_id, "-1001234567890");
});
