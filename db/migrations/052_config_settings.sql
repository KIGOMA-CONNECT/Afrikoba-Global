-- Config settings for four-eyes high-value gate.
CREATE TABLE IF NOT EXISTS config_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(80) NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default high-value transfer threshold (TZS) requiring a second approver.
INSERT INTO config_settings (key, value) VALUES ('HIGH_VALUE_TRANSFER_THRESHOLD', '5000000')
ON CONFLICT (key) DO NOTHING;
