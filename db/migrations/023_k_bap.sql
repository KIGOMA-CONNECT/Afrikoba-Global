-- ============================================================
-- K-SERIES: PARTNER BANKING / BANK-AS-A-SERVICE (BaaS)
-- K1: Partner application + admin approval (API key/secret)
-- K2: Partner funding (admin) | K3: Signed payout rails (HMAC)
-- K4: Idempotent payouts (client request_id) | K5: Webhooks
-- K6: Partner statement & summary
-- ============================================================

-- NOTE: api_secret inahifadhiwa PLANTEXT kwa demo hii (kama vault
-- kwenye mazingira halisi). Signature ni HMAC-SHA256(secret,
-- `${timestamp}\n${body}`).

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'DEPOSIT','WITHDRAWAL','TRANSFER',
    'ROSCA_CONTRIBUTION','ROSCA_PAYOUT','ROSCA_LOCK',
    'INVESTMENT','INVESTMENT_PAYOUT',
    'VICOBA_SHARE','VICOBA_LOAN','VICOBA_MAINTENANCE_FEE','VICOBA_PENALTY',
    'VICOBA_SOCIAL_FUND','VICOBA_SOCIAL_FUND_DISBURSEMENT',
    'VICOBA_LOAN_REPAYMENT','VICOBA_PROFIT_PAYOUT',
    'CASH_IN','CASH_OUT','BULK_PAYMENT','REMITTANCE',
    'CASHBACK','SUBSCRIPTION','FEE','REFERRAL_REWARD',
    'SAVINGS_DEPOSIT','SAVINGS_WITHDRAWAL',
    'FIXED_DEPOSIT','FIXED_DEPOSIT_INTEREST','FIXED_DEPOSIT_PENALTY',
    'LOAN_CREDIT','LOAN_REPAYMENT','LOAN_GUARANTEE','LOAN_GUARANTEE_RELEASE',
    'PARTNER_PAYOUT'
  ]::text[]));

CREATE TABLE IF NOT EXISTS partners (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  contact_email VARCHAR(160) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  country VARCHAR(60) DEFAULT 'TANZANIA',
  webhook_url VARCHAR(255),
  commission_rate NUMERIC(5,2) DEFAULT 0,
  api_key VARCHAR(64) UNIQUE,
  api_secret VARCHAR(128),
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, ACTIVE, SUSPENDED
  balance NUMERIC(15,2) DEFAULT 0,
  monthly_volume NUMERIC(15,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partner_transactions (
  id SERIAL PRIMARY KEY,
  partner_id INT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL, -- FUNDING, PAYOUT, FAILED
  amount NUMERIC(15,2) NOT NULL,
  reference VARCHAR(40) NOT NULL UNIQUE,
  request_id VARCHAR(64),
  phone VARCHAR(30),
  status VARCHAR(20) DEFAULT 'COMPLETED', -- COMPLETED, FAILED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (partner_id, request_id)
);

CREATE TABLE IF NOT EXISTS partner_webhooks (
  id SERIAL PRIMARY KEY,
  partner_id INT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  event VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, DELIVERED, FAILED
  request_ts VARCHAR(14),
  request_body TEXT,
  request_signature VARCHAR(80),
  response_status INT,
  attempts INT DEFAULT 0,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);
CREATE INDEX IF NOT EXISTS idx_partner_txn_partner ON partner_transactions(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_webhook_partner ON partner_webhooks(partner_id, status);