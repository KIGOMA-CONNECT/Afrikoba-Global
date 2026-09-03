-- Merchant Payment Links: shareable merchant links that resolve to a requested amount.
-- Uses merchant_payment_links (not payment_links, which exists from migration 020).
CREATE TABLE IF NOT EXISTS merchant_payment_links (
  id SERIAL PRIMARY KEY,
  merchant_id INT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL UNIQUE,
  amount NUMERIC(14,2),
  description VARCHAR(200),
  currency VARCHAR(8) DEFAULT 'TZS',
  is_active BOOLEAN DEFAULT TRUE,
  scan_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mpl_merchant ON merchant_payment_links(merchant_id);
CREATE INDEX IF NOT EXISTS idx_mpl_code ON merchant_payment_links(code);