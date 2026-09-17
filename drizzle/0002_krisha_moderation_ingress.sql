CREATE TABLE IF NOT EXISTS krisha_moderation_events (
  event_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  city TEXT,
  category TEXT,
  price_kzt REAL,
  rooms REAL,
  area_m2 REAL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS krisha_moderation_subscriptions (
  id TEXT PRIMARY KEY,
  agency_name TEXT NOT NULL,
  city TEXT,
  category TEXT,
  rooms_min REAL,
  rooms_max REAL,
  price_min_kzt REAL,
  price_max_kzt REAL,
  area_min_m2 REAL,
  area_max_m2 REAL,
  telegram_chat_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS krisha_moderation_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES krisha_moderation_events(event_id),
  chat_id TEXT NOT NULL,
  telegram_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  UNIQUE(event_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_krisha_moderation_subscriptions_enabled
  ON krisha_moderation_subscriptions(enabled);
CREATE INDEX IF NOT EXISTS idx_krisha_moderation_outbox_pending
  ON krisha_moderation_outbox(status, next_attempt_at);
