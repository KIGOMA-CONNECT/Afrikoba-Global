-- ============================================
-- MULTI-CURRENCY SUPPORT
-- ============================================

-- Supported currencies
CREATE TABLE IF NOT EXISTS currencies (
  code        VARCHAR(3) PRIMARY KEY,         -- TZS, USD, KES, UGX, etc.
  name        VARCHAR(50) NOT NULL,
  symbol      VARCHAR(5) NOT NULL,
  decimals    INTEGER DEFAULT 2,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Exchange rates (relative to base currency TZS)
CREATE TABLE IF NOT EXISTS exchange_rates (
  id            SERIAL PRIMARY KEY,
  from_currency VARCHAR(3) NOT NULL REFERENCES currencies(code),
  to_currency   VARCHAR(3) NOT NULL REFERENCES currencies(code),
  rate          NUMERIC(15,6) NOT NULL,
  source        VARCHAR(50) DEFAULT 'MANUAL',
  valid_from    TIMESTAMP DEFAULT NOW(),
  valid_until   TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(from_currency, to_currency, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair ON exchange_rates(from_currency, to_currency);

-- Add currency to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) DEFAULT 'TZS';

-- Seed base currencies
INSERT INTO currencies (code, name, symbol, decimals) VALUES
  ('TZS', 'Tanzanian Shilling', 'TSh', 2),
  ('USD', 'US Dollar', '$', 2),
  ('KES', 'Kenyan Shilling', 'KSh', 2),
  ('UGX', 'Ugandan Shilling', 'UGX', 0),
  ('NGN', 'Nigerian Naira', '₦', 2),
  ('ZAR', 'South African Rand', 'R', 2),
  ('GHS', 'Ghanaian Cedi', 'GH₵', 2)
ON CONFLICT (code) DO NOTHING;

-- Seed base exchange rates (approximate, against TZS)
INSERT INTO exchange_rates (from_currency, to_currency, rate, source) VALUES
  ('TZS', 'USD', 0.00039, 'SEED'),
  ('USD', 'TZS', 2560.0, 'SEED'),
  ('TZS', 'KES', 0.060, 'SEED'),
  ('KES', 'TZS', 16.7, 'SEED'),
  ('TZS', 'UGX', 1.52, 'SEED'),
  ('UGX', 'TZS', 0.658, 'SEED'),
  ('TZS', 'NGN', 0.61, 'SEED'),
  ('NGN', 'TZS', 1.64, 'SEED'),
  ('TZS', 'ZAR', 0.0074, 'SEED'),
  ('ZAR', 'TZS', 135.0, 'SEED'),
  ('TZS', 'GHS', 0.0061, 'SEED'),
  ('GHS', 'TZS', 164.0, 'SEED')
ON CONFLICT DO NOTHING;
