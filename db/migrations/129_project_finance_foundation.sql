-- ============================================================================
-- 129: PROJECT FINANCE FOUNDATION — SEGREGATED ACCOUNTS, WATERFALL ENGINE,
--       MILESTONE PROOF & EXPERT-GATED DISBURSEMENT
-- ============================================================================
-- Implements the Afrikoba FinOS project-finance foundation:
--   Phase 0 — segregated internal ledger accounts (7)
--   Phase 1 — versioned, freezable waterfall_allocation_rules + per-step
--             waterfall_allocation_records (double-entry, idempotent)
--   Phase 2 — milestone proof columns + two-phase disbursement approval
-- Ledger is the source of truth: every money movement posts balanced
-- journal_entries; no balance is mutated without a journal posting.
-- ============================================================================

-- ===== PHASE 0 — SEGREGATED PROJECT LEDGER ACCOUNTS ========================
-- Internal sub-ledgers (NOT external bank accounts). Each project money store
-- has its own chart-of-accounts code so permissions, audit and reporting are
-- isolated. PROJECT_FUND stays for backward compatibility with legacy flows.
INSERT INTO ledger_accounts (account_code, name, account_type) VALUES
  ('PROJECT_INVESTMENT_ACCOUNT',  'Project Investment Escrow',     'ASSET'),
  ('PROJECT_REVENUE_ACCOUNT',     'Project Revenue Account',       'ASSET'),
  ('PROJECT_TAX_ACCOUNT',         'Project Statutory Tax Account', 'ASSET'),
  ('PROJECT_RESERVE_ACCOUNT',     'Project Reserve Account',       'ASSET'),
  ('PROJECT_DEBT_SERVICE_ACCOUNT','Project Debt Service Account',  'ASSET'),
  ('PROJECT_DIVIDEND_ACCOUNT',    'Project Dividend Account',      'ASSET'),
  ('PROJECT_OPERATING_ACCOUNT',   'Project Operating Account',     'ASSET'),
  ('PROJECT_OWNER_RESIDUAL_ACCOUNT','Project Owner Residual Account','ASSET')
ON CONFLICT (account_code) DO NOTHING;

-- ===== PHASE 1 — WATERFALL ALLOCATION RULES (VERSIONED, FREEZABLE) =========
CREATE TABLE IF NOT EXISTS waterfall_allocation_rules (
  id                            SERIAL PRIMARY KEY,
  project_id                    INTEGER NOT NULL REFERENCES projects(id),
  version                       INTEGER NOT NULL DEFAULT 1,
  status                        VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT','PROPOSED','ACTIVE','FROZEN','SUPERSEDED')),
  tax_percentage                NUMERIC(5,2) DEFAULT 0 CHECK (tax_percentage >= 0 AND tax_percentage <= 100),
  opex_percentage               NUMERIC(5,2) DEFAULT 0 CHECK (opex_percentage >= 0 AND opex_percentage <= 100),
  payroll_percentage            NUMERIC(5,2) DEFAULT 0 CHECK (payroll_percentage >= 0 AND payroll_percentage <= 100),
  debt_service_percentage       NUMERIC(5,2) DEFAULT 0 CHECK (debt_service_percentage >= 0 AND debt_service_percentage <= 100),
  reserve_fund_percentage       NUMERIC(5,2) DEFAULT 0 CHECK (reserve_fund_percentage >= 0 AND reserve_fund_percentage <= 100),
  investor_dividend_percentage  NUMERIC(5,2) DEFAULT 0 CHECK (investor_dividend_percentage >= 0 AND investor_dividend_percentage <= 100),
  owner_residual_percentage     NUMERIC(5,2) DEFAULT 0 CHECK (owner_residual_percentage >= 0 AND owner_residual_percentage <= 100),
  proposed_by                   INTEGER REFERENCES users(id),
  proposed_at                   TIMESTAMPTZ,
  approved_by                   INTEGER REFERENCES users(id),
  approved_at                   TIMESTAMPTZ,
  effective_date                DATE,
  supersedes_rule_id            INTEGER REFERENCES waterfall_allocation_rules(id),
  change_reason                 TEXT,
  created_at                    TIMESTAMPTZ DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waterfall_project ON waterfall_allocation_rules(project_id, version);

-- Sum must be exactly 100.
CREATE OR REPLACE FUNCTION check_waterfall_sum()
RETURNS TRIGGER AS $$
DECLARE
  total NUMERIC;
BEGIN
  total := COALESCE(NEW.tax_percentage,0) + COALESCE(NEW.opex_percentage,0)
         + COALESCE(NEW.payroll_percentage,0) + COALESCE(NEW.debt_service_percentage,0)
         + COALESCE(NEW.reserve_fund_percentage,0) + COALESCE(NEW.investor_dividend_percentage,0)
         + COALESCE(NEW.owner_residual_percentage,0);
  IF NEW.status IN ('PROPOSED','ACTIVE','FROZEN') AND total <> 100 THEN
    RAISE EXCEPTION 'Waterfall percentages must sum to 100 (got %)', total;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_waterfall_sum ON waterfall_allocation_rules;
CREATE TRIGGER trg_waterfall_sum
  BEFORE INSERT OR UPDATE ON waterfall_allocation_rules
  FOR EACH ROW EXECUTE FUNCTION check_waterfall_sum();

-- ===== PHASE 1 — WATERFALL ALLOCATION RECORDS (ONE ROW PER STEP) ===========
-- Every waterfall step on every process-incoming run is recorded here with the
-- full lineage: rule version, revenue txn, source→destination accounts, ledger
-- group id and reconciliation status. Append-only.
CREATE TABLE IF NOT EXISTS waterfall_allocation_records (
  id                      BIGSERIAL PRIMARY KEY,
  project_id              INTEGER NOT NULL REFERENCES projects(id),
  rule_id                 INTEGER NOT NULL REFERENCES waterfall_allocation_rules(id),
  rule_version            INTEGER NOT NULL,
  allocation_step         VARCHAR(40) NOT NULL,
  priority                SMALLINT NOT NULL,
  revenue_transaction_id  INTEGER,                        -- transactions.id of incoming revenue
  revenue_reference       VARCHAR(64) NOT NULL,           -- idempotency key of the revenue event
  source_account_code     VARCHAR(40) NOT NULL,
  destination_account_code VARCHAR(40) NOT NULL,
  calculation_basis       VARCHAR(20) NOT NULL,           -- PERCENTAGE / FIXED / PRIORITY / THRESHOLD
  percentage              NUMERIC(7,4),
  amount                  NUMERIC(19,2) NOT NULL CHECK (amount >= 0),
  currency                VARCHAR(3) DEFAULT 'TZS',
  approval_reference      VARCHAR(64),                    -- approving expert reference when applicable
  ledger_group_id         VARCHAR(64),                    -- journal_entries.entry_group_id
  reconciliation_status   VARCHAR(20) DEFAULT 'PENDING'
                          CHECK (reconciliation_status IN ('PENDING','RECONCILED','DISPUTED')),
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waterfall_records_project ON waterfall_allocation_records(project_id, revenue_reference);
CREATE INDEX IF NOT EXISTS idx_waterfall_records_rule    ON waterfall_allocation_records(rule_id);

-- ===== PHASE 2 — MILESTONE PROOF SUBMISSION & EXPERT REVIEW ================
ALTER TABLE project_milestones
  ADD COLUMN IF NOT EXISTS proof_documents JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS proof_notes TEXT,
  ADD COLUMN IF NOT EXISTS proof_submitted_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS proof_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expert_reviewer_id INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS expert_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expert_comment TEXT,
  ADD COLUMN IF NOT EXISTS ai_verification JSONB,
  ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ;

-- Extend milestone status enum (was NOT_STARTED/IN_PROGRESS/COMPLETED).
ALTER TABLE project_milestones DROP CONSTRAINT IF EXISTS project_milestones_status_check;
ALTER TABLE project_milestones ADD CONSTRAINT project_milestones_status_check
  CHECK (status IN ('NOT_STARTED','IN_PROGRESS','REPORT_SUBMITTED',
                     'EXPERT_REVIEW','COMPLETED','REJECTED'));

-- ===== PHASE 2 — TWO-PHASE DISBURSEMENT APPROVAL (SEGREGATION OF DUTIES) ===
-- request (owner/manager) -> expert review -> approve -> authorize -> execute.
ALTER TABLE project_disbursements
  ADD COLUMN IF NOT EXISTS requested_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expert_comment TEXT,
  ADD COLUMN IF NOT EXISTS authorized_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reject_reason TEXT,
  ADD COLUMN IF NOT EXISTS milestone_proof_ref VARCHAR(64),
  ADD COLUMN IF NOT EXISTS executed_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

-- Extend disbursement status enum (was PENDING/AUTHORIZED/RELEASED/REJECTED).
ALTER TABLE project_disbursements DROP CONSTRAINT IF EXISTS project_disbursements_status_check;
ALTER TABLE project_disbursements ADD CONSTRAINT project_disbursements_status_check
  CHECK (status IN ('PENDING','REQUESTED','REVIEWED','AUTHORIZED','RELEASED','REJECTED'));

-- ===== PHASE 0 — CONTROLLED PROJECT ACCOUNT BALANCE TRACKING ==============
ALTER TABLE controlled_project_accounts
  ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS funding_target NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Sync remaining_balance from escrow_balance for existing rows.
UPDATE controlled_project_accounts SET remaining_balance = escrow_balance
WHERE remaining_balance = 0 AND escrow_balance > 0;