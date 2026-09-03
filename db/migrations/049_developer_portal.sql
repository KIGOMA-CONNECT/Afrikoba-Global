-- Developer portal: API keys and webhook delivery log.
-- Uses dedicated dev_* tables (api_keys/webhook_deliveries already exist from 012/017).
CREATE TABLE IF NOT EXISTS dev_api_keys (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  key_hash VARCHAR(128) NOT NULL UNIQUE,
  scopes JSONB DEFAULT '["read"]',
  rate_limit INT DEFAULT 100,
  is_active BOOLEAN DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_api_keys_user ON dev_api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_dev_api_keys_hash ON dev_api_keys(key_hash);

CREATE TABLE IF NOT EXISTS dev_webhook_deliveries (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  event VARCHAR(100) NOT NULL,
  payload JSONB,
  response_status INT,
  response_body TEXT,
  delivered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_webhook_deliveries_user ON dev_webhook_deliveries(user_id);
