-- ============================================================================
-- 039 MARKETPLACE FINANCING (buy now, repay in installments)
--
-- Adds a real financing leg to marketplace orders:
--   * Buyer pays a DOWN PAYMENT, held in MARKETPLACE_ESCROW (existing).
--   * At delivery-confirm the platform settles the down payment AND fronts the
--     financed portion to the seller, booking a receivable on
--     MARKETPLACE_FINANCING (ASSET).
--   * Buyer repays monthly installments (principal -> MARKETPLACE_FINANCING,
--     fee -> FINANCE_INCOME) through the engine, so the ledger stays balanced.
--
-- Governance: origination is hard-gated by the Financial Passport
-- (installment <= 50% disposable capacity AND minimum score), mirroring the
-- credit/eligibility rule used for loans.
-- ============================================================================

INSERT INTO ledger_accounts (account_code, name, account_type, is_system)
SELECT 'MARKETPLACE_FINANCING', 'Marketplace Financing Receivables', 'ASSET', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE account_code='MARKETPLACE_FINANCING');

INSERT INTO ledger_accounts (account_code, name, account_type, is_system)
SELECT 'FINANCE_INCOME', 'Financing Fee Income', 'REVENUE', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE account_code='FINANCE_INCOME');

-- Orders now track exactly how much is actually held in escrow (down payment
-- for financed orders, full total for cash orders).
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS escrow_held_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
UPDATE marketplace_orders SET escrow_held_amount = total_amount WHERE status='ESCROW_HELD' AND escrow_held_amount = 0;

-- Financing agreement per order.
CREATE TABLE IF NOT EXISTS marketplace_financing (
  id              SERIAL PRIMARY KEY,
  order_id        INT NOT NULL UNIQUE REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  buyer_user_id   INT NOT NULL REFERENCES users(id),
  financed_amount NUMERIC(15,2) NOT NULL,          -- principal we front to the seller
  fee_total       NUMERIC(15,2) NOT NULL,          -- financing fee (all instalments)
  term_months     INT NOT NULL CHECK (term_months BETWEEN 1 AND 24),
  monthly_installment NUMERIC(15,2) NOT NULL,      -- principal share + fee share
  status          VARCHAR(12) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE / PAID / CANCELLED / DEFAULTED
  paid_amount     NUMERIC(15,2) NOT NULL DEFAULT 0,      -- principal paid + fee paid (cash basis)
  principal_paid  NUMERIC(15,2) NOT NULL DEFAULT 0,      -- principal repaid (drives recon receivable)
  fee_paid        NUMERIC(15,2) NOT NULL DEFAULT 0,      -- financing fee recognized as income
  next_due_date   DATE NOT NULL,
  disbursed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_financing_buyer ON marketplace_financing(buyer_user_id, status);
CREATE INDEX IF NOT EXISTS idx_mkt_financing_due ON marketplace_financing(status, next_due_date);