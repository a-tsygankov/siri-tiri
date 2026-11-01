-- Migration 0001: devices, pairing codes, messages, review chain, clips, sync log.
-- D1 migration ids are independent from the local-service SQLite migration numbers.

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  label TEXT NOT NULL,
  component TEXT NOT NULL,
  version TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  paired_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  used_by_device_id TEXT
);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'review', 'episode')),
  event_id TEXT,
  correlation_key TEXT NOT NULL,
  type TEXT,
  source_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'conflict')),
  conflict_reason TEXT
);
CREATE INDEX idx_messages_event ON messages(event_id);
CREATE INDEX idx_messages_received ON messages(received_at);
CREATE INDEX idx_messages_status ON messages(status, received_at);

CREATE TABLE review_chain (
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (event_id, revision)
);

CREATE TABLE clips (
  clip_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  uploaded_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_clips_event ON clips(event_id);

CREATE TABLE sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'clip')),
  ref_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sync_log_created ON sync_log(created_at);
