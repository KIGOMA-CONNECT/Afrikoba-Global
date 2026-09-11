-- ============================================================
-- SACCOS DIGITAL CORE - FUND MANAGEMENT + LOAN-LOSS RESERVES
-- (increment 9)
-- Two economic features on the shared double-entry ledger:
--
-- 1) Fund buckets (saccos_funds). OWNER/BOARD carve per-SACCOS
--    LIABILITY accounts `SACCOS<id>_FUND_<CODE>`; ACTIVE members
--    contribute into them (debitWallet DR CUSTOMER_WALLET / CR
--    fund account, txn SACCOS_FUND_CONTRIBUTION); OWNER/BOARD
--    transfer balance between funds (DR from-fund / CR to-fund,
--    FTF-*, balanced journal). Funds with a non-zero residual
--    balance cannot be archived.
--
-- 2) Loan-loss reserves (saccos_loan_loss_reserves). OWNER/BOARD
--    provision expected credit losses on a disbursed SACCOS loan:
--    DR `SACCOS<id>_LOAN_LOSS_EXPENSE` (EXPENSE) /
--    CR `SACCOS<id>_LOAN_LOSS_RESERVES` (LIABILITY), once per
--    loan (UNIQUE(saccos_id, loan_id)), LLR-*. Release reverses
--    the journal when the risk clears. Because statements are
--    computed from the ledger, a provision flows straight into
--    the income statement's expenses.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_funds (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,      -- FND-*
  code VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  purpose VARCHAR(500),
  account_code VARCHAR(64) NOT NULL UNIQUE,      -- SACCOS<id>_FUND_<CODE>
  target_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (target_amount >= 0),
  minimum_balance NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (minimum_balance >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE, ARCHIVED
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (saccos_id, code)
);
CREATE INDEX IF NOT EXISTS idx_saccos_funds_saccos ON saccos_funds(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_fund_contributions (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  fund_id INT NOT NULL REFERENCES saccos_funds(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,      -- FNC-* (wallet debit journal ref)
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_fund_contributions_member
  ON saccos_fund_contributions(member_id, fund_id);

CREATE TABLE IF NOT EXISTS saccos_fund_transfers (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,      -- FTF-* (journal ref)
  from_fund_id INT NOT NULL REFERENCES saccos_funds(id) ON DELETE CASCADE,
  to_fund_id INT NOT NULL REFERENCES saccos_funds(id) ON DELETE CASCADE,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'EXECUTED',
  authorized_by INT REFERENCES users(id),
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_fund_transfers_saccos
  ON saccos_fund_transfers(saccos_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS saccos_loan_loss_reserves (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  loan_id INT NOT NULL UNIQUE REFERENCES saccos_loans(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,      -- LLR-* (provision journal ref)
  provision_amount NUMERIC(15,2) NOT NULL CHECK (provision_amount > 0),
  provision_rate_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'PROVISIONED', -- PROVISIONED, RELEASED
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  UNIQUE (saccos_id, loan_id)
);
CREATE INDEX IF NOT EXISTS idx_saccos_llr_saccos ON saccos_loan_loss_reserves(saccos_id, status);