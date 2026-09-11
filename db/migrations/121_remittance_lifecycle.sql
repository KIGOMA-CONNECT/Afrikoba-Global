-- 121: Cross-border remittance lifecycle
--   F4.1 rate-locked quotes (5-min expiry, RMQ-* refs)
--   F4.2 payout instructions (adapter layer: WALLET / MNO / AGENT)
--   F4.3 beneficiary routing enrichment (country, currency, payout method)
--   F4.4 remittance_transfers lifecycle columns (quote, beneficiary, expiry, refund)

-- F4.1: Rate-locked quotes
CREATE TABLE IF NOT EXISTS remittance_quotes (
  id SERIAL PRIMARY KEY,
  reference_id VARCHAR(50) UNIQUE NOT NULL,
  user_id INT NOT NULL REFERENCES users(id),
  from_country VARCHAR(3) NOT NULL,
  to_country VARCHAR(3) NOT NULL,
  from_currency VARCHAR(3) NOT NULL,
  to_currency VARCHAR(3) NOT NULL,
  amount_in NUMERIC(15,2) NOT NULL,
  fee NUMERIC(15,2) NOT NULL,
  fee_percentage NUMERIC(5,2) NOT NULL,
  exchange_rate NUMERIC(15,6) NOT NULL,
  amount_out NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, USED, EXPIRED
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_remittance_quotes_user ON remittance_quotes(user_id);
CREATE INDEX IF NOT EXISTS idx_remittance_quotes_reference ON remittance_quotes(reference_id);

-- F4.2: Payout instructions (adapter layer)
CREATE TABLE IF NOT EXISTS remittance_payouts (
  id SERIAL PRIMARY KEY,
  transfer_id INT NOT NULL REFERENCES remittance_transfers(id),
  payout_method VARCHAR(20) NOT NULL, -- WALLET, MNO, AGENT
  provider VARCHAR(50),
  amount NUMERIC(15,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PROCESSED, FAILED, CANCELLED
  instruction VARCHAR(100),            -- destination phone / nominal account reference
  reference VARCHAR(100),              -- external provider reference
  error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_remittance_payouts_transfer ON remittance_payouts(transfer_id);

-- F4.3: Beneficiary routing enrichment
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS country_code VARCHAR(3);
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3);
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS payout_method VARCHAR(20) DEFAULT 'WALLET';

-- F4.4: remittance_transfers lifecycle columns
ALTER TABLE remittance_transfers ADD COLUMN IF NOT EXISTS quote_id INT REFERENCES remittance_quotes(id);
ALTER TABLE remittance_transfers ADD COLUMN IF NOT EXISTS beneficiary_id INT REFERENCES beneficiaries(id);
ALTER TABLE remittance_transfers ADD COLUMN IF NOT EXISTS payout_method VARCHAR(20) DEFAULT 'MNO';
ALTER TABLE remittance_transfers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE remittance_transfers ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ;
ALTER TABLE remittance_transfers ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE remittance_transfers ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE remittance_transfers ADD COLUMN IF NOT EXISTS refund_reference VARCHAR(100);