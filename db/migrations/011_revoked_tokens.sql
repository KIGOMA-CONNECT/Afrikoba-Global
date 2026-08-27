-- ============================================
-- REVOKED TOKENS (Token Blacklist)
-- ============================================

CREATE TABLE IF NOT EXISTS revoked_tokens (
  id SERIAL PRIMARY KEY,
  token_jti VARCHAR(36) UNIQUE NOT NULL,  -- JWT jti claim
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti ON revoked_tokens(token_jti);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expiry ON revoked_tokens(expires_at);

-- Auto-cleanup expired revoked tokens (run via cron)
-- DELETE FROM revoked_tokens WHERE expires_at < NOW();
