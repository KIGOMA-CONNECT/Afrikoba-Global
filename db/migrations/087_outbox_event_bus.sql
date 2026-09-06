-- ============================================================
-- 087 - Transaction-aware outbox + event-bus dispatcher
-- Writes that produce side-effects insert an outbox row in the
-- SAME DB transaction; a dispatcher (cron / admin endpoint)
-- claims due rows with SKIP LOCKED and fans them out to
-- registered handlers with exponential backoff + dead-letter.
-- ============================================================

CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(80) NOT NULL,
  aggregate_id VARCHAR(120),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  reference_id VARCHAR(120) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, DELIVERED, FAILED, DEAD
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_claim ON outbox_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_type ON outbox_events(event_type);