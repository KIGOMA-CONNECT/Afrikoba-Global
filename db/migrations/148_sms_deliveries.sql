-- 148 - SMS delivery ledger (Phase 71 / Step D).
-- One row per idempotency key (e.g. an outbox reference_id). The row is
-- written as PENDING and committed BEFORE any provider call, so a crash or an
-- ambiguous provider outcome can never lead to a blind resend.
-- Privacy: no full phone number and no SMS text are stored; only a SHA-256 of
-- the normalised phone, its last 4 digits, and a SHA-256 of the body.
-- Status meanings:
--   PENDING  claimed, provider outcome not yet recorded
--   SENT     a provider accepted the message (or simulated outside production)
--   FAILED   every provider definitely rejected / was unreachable; a new attempt is allowed
--   UNKNOWN  outcome ambiguous (timeout, 5xx, stale PENDING); never resent automatically
-- The migration runner manages transaction boundaries (no BEGIN/COMMIT here).
-- Rollback: see docs/phase71-backlog.md.

CREATE TABLE IF NOT EXISTS sms_deliveries (
  id                  BIGSERIAL PRIMARY KEY,
  idempotency_key     VARCHAR(200) NOT NULL UNIQUE,
  phone_hash          CHAR(64)     NOT NULL,
  phone_last4         VARCHAR(4),
  body_hash           CHAR(64)     NOT NULL,
  status              VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                      CONSTRAINT sms_deliveries_status_check
                      CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'UNKNOWN')),
  provider            VARCHAR(20),
  provider_message_id VARCHAR(200),
  simulated           BOOLEAN      NOT NULL DEFAULT FALSE,
  attempts            INT          NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Reconciliation queries (UNKNOWN / stale PENDING by age).
CREATE INDEX IF NOT EXISTS idx_sms_deliveries_status_updated
  ON sms_deliveries (status, updated_at);
