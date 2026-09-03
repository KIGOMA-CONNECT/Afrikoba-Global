-- Country / regulator abstraction for cross-border payments.
CREATE TABLE IF NOT EXISTS supported_countries (
  id SERIAL PRIMARY KEY,
  code VARCHAR(4) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  currency VARCHAR(8) NOT NULL,
  region VARCHAR(50) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  min_fee NUMERIC(14,2) DEFAULT 0,
  percent_fee NUMERIC(5,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supported_countries_region ON supported_countries(region);

-- Seed East-African Community + common corridors
INSERT INTO supported_countries (code, name, currency, region, min_fee, percent_fee) VALUES
  ('TZ', 'Tanzania', 'TZS', 'East Africa', 0, 0),
  ('KE', 'Kenya', 'KES', 'East Africa', 500, 0.0100),
  ('UG', 'Uganda', 'UGX', 'East Africa', 500, 0.0100),
  ('RW', 'Rwanda', 'RWF', 'East Africa', 500, 0.0100),
  ('BI', 'Burundi', 'BIF', 'East Africa', 500, 0.0100),
  ('ZM', 'Zambia', 'ZMW', 'Southern Africa', 1000, 0.0150),
  ('NG', 'Nigeria', 'NGN', 'West Africa', 1000, 0.0150),
  ('GH', 'Ghana', 'GHS', 'West Africa', 1000, 0.0150)
ON CONFLICT (code) DO NOTHING;
