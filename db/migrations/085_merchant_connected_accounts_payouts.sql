-- ============================================================================
-- 085 MERCHANT CONNECTED ACCOUNTS & PAYOUTS (Stripe-Connect-style)
-- Merchants link a payout account (MNO phone / bank), accumulate proceeds into
-- a MERCHANT_BALANCE ledger liability (instead of disappearing into SUSPENSE),
-- and request settlements which admins execute against the ledger.
-- ============================================================================

-- Ledger account for accumulated merchant proceeds awaiting payout.
INSERT INTO ledger_accounts (account_code, name, account_type, is_system)
SELECT 'MERCHANT_BALANCE', 'Merchant Proceeds (payout pending)', 'LIABILITY', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE account_code='MERCHANT_BALANCE');

-- Connected (payout-target) account per merchant.
CREATE TABLE IF NOT EXISTS connected_merchant_accounts (
  id                   SERIAL PRIMARY KEY,
  merchant_id          INT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  status               VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, ACTIVE, SUSPENDED
  payout_type          VARCHAR(20) NOT NULL DEFAULT 'MNO_PHONE', -- MNO_PHONE, BANK_ACCOUNT
  payout_reference     VARCHAR(80) NOT NULL,                     -- MNO number or bank account nr
  bank_name            VARCHAR(120),
  account_holder       VARCHAR(120),
  balance              NUMERIC(15,2) NOT NULL DEFAULT 0,          -- projection of MERCHANT_BALANCE holdings
  settlement_hold_days INT NOT NULL DEFAULT 1,
  kyc_verified_at      TIMESTAMPTZ,
  verified_by          INT REFERENCES users(id),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (merchant_id)
);
CREATE INDEX IF NOT EXISTS idx_cma_status ON connected_merchant_accounts(status);

-- Settlement / payout runs requested against a merchant's held balance.
CREATE TABLE IF NOT EXISTS merchant_payouts (
  id               SERIAL PRIMARY KEY,
  payout_reference VARCHAR(40) NOT NULL UNIQUE,
  merchant_id      INT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  account_id       INT REFERENCES connected_merchant_accounts(id) ON DELETE SET NULL,
  gross_amount     NUMERIC(15,2) NOT NULL CHECK (gross_amount > 0),
  fee_percent      NUMERIC(5,2) NOT NULL DEFAULT 1.00,
  fee_amount       NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_amount       NUMERIC(15,2) NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, EXECUTED, FAILED, CANCELLED
  requested_by     INT REFERENCES users(id),
  executed_by      INT REFERENCES users(id),
  executed_at      TIMESTAMPTZ,
  ledger_ref       VARCHAR(40),
  error            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mp_status ON merchant_payouts(status);
CREATE INDEX IF NOT EXISTS idx_mp_merchant ON merchant_payouts(merchant_id);

-- Four-eyes dual control for executing merchant settlements: a payout run
-- (money leaving MERCHANT_BALANCE) is the kind of admin-triggered financial
-- action that benefits from maker-checker on larger amounts.
INSERT INTO four_eyes_policies (action_code, description, required_approvers, approver_roles, enabled, allow_self_approve)
SELECT 'MERCHANT_PAYOUT_EXECUTE', 'Kutekeleza payout ya mjasiriamali (merchant settlement)', 1, ARRAY['ADMIN'], true, false
WHERE NOT EXISTS (SELECT 1 FROM four_eyes_policies WHERE action_code='MERCHANT_PAYOUT_EXECUTE');