import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';

const secret = 'test-only-webhook-secret-that-is-longer-than-32-bytes';
const adminKey = 'test-only-admin-key-that-is-longer-than-32-bytes';

class MemoryStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    const [key] = this.values;
    if (this.sql.includes('FROM krisha_moderation_events WHERE event_id=?')) return this.db.events.get(key) || null;
    if (this.sql.includes('COUNT(*) AS count FROM krisha_moderation_outbox')) return { count: [...this.db.outbox.values()].filter(row => row.event_id === key && row.status === 'pending').length };
    return null;
  }
  async all() {
    if (this.sql.includes('FROM krisha_moderation_subscriptions WHERE enabled=1')) return { results: this.db.subscriptions.filter(row => row.enabled === 1) };
    if (this.sql.includes('FROM krisha_moderation_subscriptions ORDER BY')) return { results: this.db.subscriptions.map(({ telegram_chat_id, ...item }) => item) };
    if (this.sql.includes('FROM krisha_moderation_outbox')) return { results: [...this.db.outbox.values()].filter(row => row.status === 'pending' && row.next_attempt_at <= new Date().toISOString()).slice(0, 25) };
    return { results: [] };
  }
  async run() {
    const v = this.values;
    if (this.sql.startsWith('INSERT OR IGNORE INTO krisha_moderation_events')) {
      if (this.db.events.has(v[0])) return { meta: { changes: 0 } };
      this.db.events.set(v[0], { payload_hash: v[10], event_id: v[0] });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT OR IGNORE INTO krisha_moderation_outbox')) {
      const key = `${v[0]}:${v[1]}`;
      if (this.db.outbox.has(key)) return { meta: { changes: 0 } };
      this.db.outbox.set(key, { id: this.db.nextOutbox++, event_id: v[0], chat_id: v[1], telegram_html: v[2], status: 'pending', attempts: 0, next_attempt_at: v[3] });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('UPDATE krisha_moderation_outbox SET status=\'sent\'')) {
      const row = [...this.db.outbox.values()].find(item => item.id === v[1]);
      if (row) Object.assign(row, { status: 'sent', sent_at: v[0], attempts: row.attempts + 1, telegram_html: '' });
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.startsWith('UPDATE krisha_moderation_outbox SET attempts=')) {
      const row = [...this.db.outbox.values()].find(item => item.id === v[2]);
      if (row) Object.assign(row, { attempts: row.attempts + 1, last_error: v[0], next_attempt_at: v[1] });
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.startsWith('INSERT INTO krisha_moderation_subscriptions')) {
      this.db.subscriptions.push({ id: v[0], agency_name: v[1], city: v[2], category: v[3], rooms_min: v[4], rooms_max: v[5], price_min_kzt: v[6], price_max_kzt: v[7], area_min_m2: v[8], area_max_m2: v[9], telegram_chat_id: v[10], enabled: 1, created_at: v[11], updated_at: v[12] });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('DELETE FROM krisha_moderation_subscriptions')) {
      const before = this.db.subscriptions.length;
      this.db.subscriptions = this.db.subscriptions.filter(item => item.id !== v[0]);
      return { meta: { changes: before - this.db.subscriptions.length } };
    }
    return { meta: { changes: 0 } };
  }
}

class MemoryDB {
  events = new Map();
  subscriptions = [];
  outbox = new Map();
  nextOutbox = 1;
  prepare(sql) { return new MemoryStatement(this, sql); }
}

const makeEnv = () => ({ DB: new MemoryDB(), KRISHA_MODERATION_WEBHOOK_SECRET: secret, KRISHA_MODERATION_ADMIN_KEY: adminKey, TELEGRAM_BOT_TOKEN: 'telegram-test-token' });
const event = (overrides = {}) => ({
  schema_version: 1,
  event_id: 'krisha-event-00001',
  event_type: 'listing.submitted_for_moderation',
  occurred_at: new Date().toISOString(),
  listing: { source_id: '1012345678', city: 'Астана', category: 'Продажа квартир', price_kzt: 45000000, rooms: 2, area_m2: 58, description: 'must be dropped', phone: '+77000000000' },
  ...overrides,
});

async function signedRequest(body, { path = '/api/integrations/krisha/moderation/events', method = 'POST', key = secret, timestamp = String(Math.floor(Date.now() / 1000)), signatureOverride = null } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const payload = new Uint8Array(prefix.length + bytes.length);
  payload.set(prefix);
  payload.set(bytes, prefix.length);
  const signature = signatureOverride || `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, payload))].map(value => value.toString(16).padStart(2, '0')).join('')}`;
  return new Request(`https://ingress.test${path}`, { method, headers: { 'content-type': 'application/json', 'x-krisha-timestamp': timestamp, 'x-krisha-signature': signature }, body: method === 'GET' ? undefined : bytes });
}

test('accepts a signed event and sends only allow-listed details to Telegram', async t => {
  const env = makeEnv();
  env.DB.subscriptions.push({ id: 'sub-1', agency_name: 'North Realty', city: 'Астана', category: null, rooms_min: null, rooms_max: null, price_min_kzt: null, price_max_kzt: null, area_min_m2: null, area_max_m2: null, telegram_chat_id: '-1001234567890', enabled: 1 });
  let telegramBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { telegramBody = JSON.parse(init.body); return Response.json({ ok: true, result: { message_id: 1 } }); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await worker.fetch(await signedRequest(event()), env, {});
  const result = await response.json();
  assert.equal(response.status, 202);
  assert.equal(result.accepted, true);
  assert.equal(result.deliveries_sent, 1);
  assert.match(telegramBody.text, /Новое объявление отправлено на модерацию/);
  assert.match(telegramBody.text, /Астана/);
  assert.doesNotMatch(telegramBody.text, /must be dropped|\+77000000000|description/i);
  assert.equal(env.DB.events.size, 1);
  assert.equal([...env.DB.outbox.values()][0].status, 'sent');
});

test('rejects invalid and stale signatures before touching storage', async () => {
  const env = makeEnv();
  const invalid = await signedRequest(event(), { signatureOverride: `sha256=${'0'.repeat(64)}` });
  assert.equal((await worker.fetch(invalid, env, {})).status, 401);
  const stale = await signedRequest(event(), { timestamp: String(Math.floor(Date.now() / 1000) - 301) });
  assert.equal((await worker.fetch(stale, env, {})).status, 401);
  assert.equal(env.DB.events.size, 0);
});

test('retries Telegram delivery on upstream redelivery and deduplicates notification', async t => {
  const env = makeEnv();
  env.DB.subscriptions.push({ id: 'sub-1', agency_name: 'North Realty', city: null, category: null, rooms_min: null, rooms_max: null, price_min_kzt: null, price_max_kzt: null, area_min_m2: null, area_max_m2: null, telegram_chat_id: '12345678', enabled: 1 });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return calls === 1 ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true }); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const payload = event();
  const first = await worker.fetch(await signedRequest(payload), env, {});
  assert.equal(first.status, 503);
  const pending = [...env.DB.outbox.values()][0];
  pending.next_attempt_at = new Date(Date.now() - 1000).toISOString();
  const second = await worker.fetch(await signedRequest(payload), env, {});
  assert.equal(second.status, 202);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(calls, 2);
  assert.equal(env.DB.events.size, 1);
  assert.equal(env.DB.outbox.size, 1);
});

test('keeps an event retryable until at least one agency subscription is configured', async t => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ok: true }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const payload = event();

  const first = await worker.fetch(await signedRequest(payload), env, {});
  assert.equal(first.status, 503);
  assert.equal(env.DB.events.size, 1);
  assert.equal(env.DB.outbox.size, 0);

  env.DB.subscriptions.push({ id: 'sub-1', agency_name: 'North Realty', city: null, category: null, rooms_min: null, rooms_max: null, price_min_kzt: null, price_max_kzt: null, area_min_m2: null, area_max_m2: null, telegram_chat_id: '12345678', enabled: 1 });
  const second = await worker.fetch(await signedRequest(payload), env, {});
  assert.equal(second.status, 202);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(calls, 1);
  assert.equal(env.DB.outbox.size, 1);
});

test('public surface is limited to health, signed events, and admin-protected subscriptions', async () => {
  const env = makeEnv();
  const health = await worker.fetch(new Request('https://ingress.test/api/health'), env, {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { service: 'estate-radar-ingress', status: 'ok' });
  assert.equal((await worker.fetch(new Request('https://ingress.test/api/events'), env, {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://ingress.test/api/integrations/krisha/moderation/events'), env, {})).status, 405);
  assert.equal((await worker.fetch(new Request('https://ingress.test/api/integrations/krisha/moderation/subscriptions'), env, {})).status, 401);
});

test('fails closed when secrets or persistence are unavailable', async () => {
  const body = event();
  const noSecret = { DB: new MemoryDB(), KRISHA_MODERATION_WEBHOOK_SECRET: '' };
  assert.equal((await worker.fetch(await signedRequest(body), noSecret, {})).status, 503);
  const noDb = { KRISHA_MODERATION_WEBHOOK_SECRET: secret };
  assert.equal((await worker.fetch(await signedRequest(body), noDb, {})).status, 503);
});

test('rejects unsupported event shapes, oversized payloads, and non-JSON bodies', async () => {
  const env = makeEnv();
  const invalid = event({ event_type: 'listing.published' });
  assert.equal((await worker.fetch(await signedRequest(invalid), env, {})).status, 400);
  const tooLarge = new Request('https://ingress.test/api/integrations/krisha/moderation/events', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '70000' }, body: '{}' });
  assert.equal((await worker.fetch(tooLarge, env, {})).status, 413);
  const wrongContentType = new Request('https://ingress.test/api/integrations/krisha/moderation/events', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal((await worker.fetch(wrongContentType, env, {})).status, 415);
});

