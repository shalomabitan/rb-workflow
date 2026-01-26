-- Zoom Phone Call Tracking Schema

-- Calls table - main call records
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'NEW',
  caller_phone_e164 TEXT,
  caller_name TEXT,
  callee_extension_type TEXT,
  callee_extension_number TEXT,
  callee_name TEXT,
  forwarded_by_extension_type TEXT,
  forwarded_by_extension_number TEXT,
  forwarded_by_name TEXT,
  route_kind TEXT,
  monday_item_id TEXT,
  slack_parent_ts TEXT,
  last_event_id TEXT,
  last_event_ts_ms BIGINT,
  last_event_rank INTEGER,
  created_at_ms BIGINT,
  updated_at_ms BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency table - prevent duplicate event processing
CREATE TABLE IF NOT EXISTS idempotency (
  event_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- Call Queues config - routing configuration
CREATE TABLE IF NOT EXISTS call_queues (
  queue_ext TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  route_kind TEXT NOT NULL, -- MAIN, OVERFLOW, OTHER
  enabled BOOLEAN DEFAULT true
);

-- Special Numbers - answering service, VIP, spam detection
CREATE TABLE IF NOT EXISTS special_numbers (
  phone_e164 TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- ANSWERING_SERVICE, VIP, SPAM, OTHER
  label TEXT,
  enabled BOOLEAN DEFAULT true
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency(expires_at);

-- Auto-cleanup expired idempotency records (optional - run via cron)
-- DELETE FROM idempotency WHERE expires_at < NOW();
