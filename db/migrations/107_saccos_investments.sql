-- ============================================================
-- SACCOS DIGITAL CORE - INVESTMENTS (increment 7, FINAL)
-- Entity-scoped term investments for members. OWNER/BOARD define
-- investment products (INVP-*), members subscribe (INV-*) and are
-- auto-approved or OWNER/BOARD-approved (config.investments.auto
-- Approve). Subscription moves funds via `debitWallet`:
--   DR CUSTOMER_WALLET / CR per-entity LIABILITY
--   `SACCOS<id>_INVESTMENTS_LIABILITY`
-- with a `SACCOS_INVESTMENT_SUBSCRIPTION` txn. At maturity
-- (flat rate: interest = principal * rate% * termMonths/12) the
-- member redeems (RED-*) idempotently through a 3-leg journal:
--   DR INVESTMENTS_LIABILITY (principal)
--   DR `SACCOS<id>_INVESTMENT_INTEREST_EXPENSE` (EXPENSE, interest)
--   CR CUSTOMER_WALLET (principal + interest)
-- holding wallet FOR UPDATE. Redeem before maturity is rejected;
-- rejections after approval return funds via `creditWallet` on a
-- fresh -R reference. Config (saccos.config.investments):
--   {autoApprove, minAmount, maxAmount, defaultAnnualRatePercent,
--    defaultTermMonths}
-- Cross-entity isolation 404, member RBAC 403, ADMIN oversight,
-- audit trail. Suite 51.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_investment_products (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- INVP-*
  name VARCHAR(120) NOT NULL,
  min_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  max_amount NUMERIC(18,2),
  annual_rate_percent NUMERIC(6,2) NOT NULL CHECK (annual_rate_percent >= 0),
  term_months INT NOT NULL CHECK (term_months > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, ARCHIVED
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_inv_products_saccos ON saccos_investment_products(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_investments (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES saccos_investment_products(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- INV-*
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  annual_rate_percent NUMERIC(6,2) NOT NULL,
  term_months INT NOT NULL CHECK (term_months > 0),
  expected_interest NUMERIC(18,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, ACTIVE, MATURED, REJECTED, CLOSED
  maturity_date DATE,
  subscribed_at TIMESTAMPTZ,
  decided_by INT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_investments_saccos ON saccos_investments(saccos_id, status);