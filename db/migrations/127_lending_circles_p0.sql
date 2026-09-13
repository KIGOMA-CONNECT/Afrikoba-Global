-- ============================================================================
-- 127 LENDING CIRCLES P0
-- Completes the crowdfund lifecycle: funding deadline, cancellation with
-- automatic refunds, disbursement on a dedicated LENDING_POOL ledger account,
-- and a full repayment/payout engine with pro-rata returns to lenders.
--
-- Additive only. Existing columns used by the current app are left untouched.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Dedicated ledger account for the circle lending pool
--    (replaces the shared SUSPENSE account used today) so that lender funds
--    are product-isolated (fn_product_namespace maps 'LENDING%' -> LENDING_CIRCLES)
--    and reconcilable per product.
-- ----------------------------------------------------------------------------
INSERT INTO ledger_accounts (account_code, name, account_type) VALUES
  ('LENDING_POOL', 'Lending Circles Funding Pool', 'LIABILITY'),
  ('LENDING_INTEREST_INCOME', 'Lending Circles Interest Revenue', 'REVENUE')
ON CONFLICT (account_code) DO NOTHING;

-- Extend product namespace mapper to cover the LENDING_POOL / interest accounts.
CREATE OR REPLACE FUNCTION fn_product_namespace(p_code TEXT)
RETURNS VARCHAR(40) AS $$
  SELECT CASE
    WHEN p_code IS NULL THEN NULL
    WHEN p_code = 'VICOBA_GROUP'          OR p_code LIKE 'VICOBA%'     THEN 'VICOBA'
    WHEN p_code = 'ROSICA_POOL'           OR p_code LIKE 'ROSCA%'      THEN 'ROSCA'
    WHEN p_code LIKE 'SACCOS%'                                         THEN 'SACCOS'
    WHEN p_code LIKE 'MARKETPLACE%'                                     THEN 'MARKETPLACE'
    WHEN p_code = 'FAMILY_WALLET'         OR p_code LIKE 'FAMILY%'     THEN 'FAMILY'
    WHEN p_code LIKE 'EVENT_%'                                         THEN 'EVENTS'
    WHEN p_code LIKE 'LENDING_CIRCLE%'    OR p_code LIKE 'CIRCLE%'
         OR p_code LIKE 'CROWD%'                                       THEN 'LENDING_CIRCLES'
    WHEN p_code LIKE 'LENDING_POOL%'       OR p_code LIKE 'LENDING_INTEREST%' THEN 'LENDING_CIRCLES'
    WHEN p_code LIKE 'PROJECT_ACCOUNT%'                                THEN 'PROJECTS'
    WHEN p_code LIKE 'TREASURY%'                                       THEN 'TREASURY'
    ELSE 'WALLET'
  END;
$$ LANGUAGE sql IMMUTABLE;

-- ----------------------------------------------------------------------------
-- 2. Campaign lifecycle columns + status state machine
-- ----------------------------------------------------------------------------
ALTER TABLE crowdfund_campaigns
  ADD COLUMN IF NOT EXISTS funding_deadline    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disbursed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS repaid_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by        INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancel_reason        TEXT,
  ADD COLUMN IF NOT EXISTS defaulted_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outstanding_balance NUMERIC(15,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS total_interest_paid NUMERIC(15,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ DEFAULT NOW();

-- Guard status column: normalize existing values then enforce the valid set.
UPDATE crowdfund_campaigns SET status = 'FUNDING' WHERE status IS NULL OR status = '';

ALTER TABLE crowdfund_campaigns DROP CONSTRAINT IF EXISTS cc_campaigns_status_check;
ALTER TABLE crowdfund_campaigns ADD CONSTRAINT cc_campaigns_status_check CHECK (
  status IN ('FUNDING','FULLY_FUNDED','DISBURSED','REPAID','DEFAULTED','CANCELLED')
);

-- ----------------------------------------------------------------------------
-- 3. Contributions: track status/refunds for cancellation payout
-- ----------------------------------------------------------------------------
ALTER TABLE crowdfund_contributions
  ADD COLUMN IF NOT EXISTS status            VARCHAR(20) DEFAULT 'HELD',
  ADD COLUMN IF NOT EXISTS reference         VARCHAR(64),
  ADD COLUMN IF NOT EXISTS refunded_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_reference  VARCHAR(64);

ALTER TABLE crowdfund_contributions DROP CONSTRAINT IF EXISTS cc_contrib_status_check;
ALTER TABLE crowdfund_contributions ADD CONSTRAINT cc_contrib_status_check CHECK (
  status IN ('HELD','REFUNDED')
);

-- ----------------------------------------------------------------------------
-- 4. Repayments (borrower -> pool) and lender payouts (pool -> lenders)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crowdfund_repayments (
  id               SERIAL PRIMARY KEY,
  campaign_id      INTEGER NOT NULL REFERENCES crowdfund_campaigns(id) ON DELETE CASCADE,
  borrower_user_id INTEGER NOT NULL REFERENCES users(id),
  reference        VARCHAR(64) NOT NULL UNIQUE,
  amount           NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  principal_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  interest_amount  NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  status           VARCHAR(20) DEFAULT 'SUCCESS' CHECK (status IN ('PENDING','SUCCESS','FAILED')),
  paid_at          TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crowdfund_lender_payouts (
  id               SERIAL PRIMARY KEY,
  repayment_id     INTEGER NOT NULL REFERENCES crowdfund_repayments(id) ON DELETE CASCADE,
  campaign_id      INTEGER NOT NULL REFERENCES crowdfund_campaigns(id) ON DELETE CASCADE,
  lender_user_id   INTEGER NOT NULL REFERENCES users(id),
  reference        VARCHAR(64) NOT NULL UNIQUE,
  principal_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  interest_amount  NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  total_amount     NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (total_amount > 0),
  status           VARCHAR(20) DEFAULT 'SUCCESS' CHECK (status IN ('PENDING','SUCCESS','FAILED')),
  paid_at          TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crowdfund_repay_campaign ON crowdfund_repayments(campaign_id);
CREATE INDEX IF NOT EXISTS idx_crowdfund_payouts_campaign ON crowdfund_lender_payouts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_crowdfund_payouts_lender ON crowdfund_lender_payouts(lender_user_id);
CREATE INDEX IF NOT EXISTS idx_crowdfund_contrib_status ON crowdfund_contributions(campaign_id, status);