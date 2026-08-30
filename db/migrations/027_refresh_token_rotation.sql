-- 027_refresh_token_rotation.sql
-- Refresh tokens zinahifadhiwa DB ili:
--  - kila refresh ijaende → rotate (token mpya, old imefutwa)
--  - reuse ya token ya zamani → revoke ALL user sessions (reuse detection)
--  - logout ya kawaida → revoke refresh token husika
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);