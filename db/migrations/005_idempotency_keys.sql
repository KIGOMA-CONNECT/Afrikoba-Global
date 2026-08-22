-- ============================================
-- IDEMPOTENCY KEYS - Prevent double-processing of financial mutations
-- ============================================
-- Client sends Idempotency-Key header on POST requests.
-- First request processed + result cached. Duplicate returns cached result.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_value   VARCHAR(255) PRIMARY KEY,
  user_id     INTEGER,
  status_code INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  expires_at  TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expiry ON idempotency_keys(expires_at);
