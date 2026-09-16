CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  last_successful_observation TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  source_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price_kzt INTEGER,
  rooms INTEGER,
  area_m2 REAL,
  floor INTEGER,
  floors_total INTEGER,
  address TEXT,
  city TEXT,
  district TEXT,
  residential_complex TEXT,
  seller_label TEXT,
  photo_urls_json TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_price_kzt INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES listings(source_id),
  event_type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(source_id, event_type, fingerprint)
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  rooms_min INTEGER,
  rooms_max INTEGER,
  price_max_kzt INTEGER,
  area_min_m2 REAL,
  telegram_chat_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  source_id TEXT PRIMARY KEY REFERENCES listings(source_id),
  agent_name TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  chat_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_observed_at ON events(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source_id ON events(source_id);
CREATE INDEX IF NOT EXISTS idx_profiles_enabled ON profiles(enabled);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON telegram_outbox(status, next_attempt_at);

