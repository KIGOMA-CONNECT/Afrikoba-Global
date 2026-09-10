-- ============================================================
-- SACCOS DIGITAL CORE - SAVINGS (increment 3)
-- Member savings deposits/withdrawals ledgered on the shared
-- double-entry core: deposits DR member wallet (CUSTOMER_WALLET)
-- / CR per-SACCOS LIABILITY SACCOS<id>_SAVINGS_LIABILITY;
-- withdrawals release DR SAVINGS_LIABILITY / CR wallet (engine
-- creditWallet) — immediate (autoApproveWithdrawals) or gated
-- on OWNER/BOARD approval. Balance is a projection over
-- APPROVED releases; pending withdrawals reserve funds and do
-- not move money until approved.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_savings_accounts (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL UNIQUE REFERENCES saccos_members(id) ON DELETE CASCADE,
  account_no VARCHAR(40) NOT NULL UNIQUE,        -- SAV-<saccosId>-<memberNumber>
  account_type VARCHAR(20) NOT NULL DEFAULT 'VOLUNTARY', -- VOLUNTARY, COMPULSORY
  balance NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_savings_accounts_saccos ON saccos_savings_accounts(saccos_id);

CREATE TABLE IF NOT EXISTS saccos_savings_withdrawals (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES saccos_savings_accounts(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,      -- SWD-* (release journal ref)
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  decided_by INT REFERENCES users(id),
  decision_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_savings_withdrawals_acc
  ON saccos_savings_withdrawals(account_id, status);

CREATE TABLE IF NOT EXISTS saccos_savings_movements (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES saccos_savings_accounts(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL,             -- SAV-* deposit | SWD-* withdrawal release
  type VARCHAR(20) NOT NULL CHECK (type IN ('DEPOSIT','WITHDRAWAL')),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED (deposits are APPROVED instantly)
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_savings_movements_acc
  ON saccos_savings_movements(account_id, created_at DESC);