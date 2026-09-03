-- Payment Links: shareable merchant links that resolve to a requested amount.
CREATE TABLE IF NOT EXISTS payment_links (
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

CREATE INDEX IF NOT EXISTS idx_payment_links_merchant ON payment_links(merchant_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_code ON payment_links(code);