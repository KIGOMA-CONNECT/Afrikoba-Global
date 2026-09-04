-- Migration 068: Step-Up Authentication for sensitive operations
-- Short-lived, single-use step-up tokens issued after fresh TOTP/SMS re-verification,
-- required before high-value actions (treasury approval, payroll payment, large withdrawals).

CREATE TABLE IF NOT EXISTS stepup_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose VARCHAR(40) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(token_hash)
);

CREATE INDEX IF NOT EXISTS idx_stepup_user ON stepup_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_stepup_purge ON stepup_tokens(expires_at) WHERE used_at IS NULL;
