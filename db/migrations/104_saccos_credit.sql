-- ============================================================
-- SACCOS DIGITAL CORE - CREDIT (increment 4)
-- Member loan applications -> approval -> disbursement -> flat
-- repayment, ledgered on the shared double-entry core:
--   disburse  -> DR SACCOS<id>_LOANS_RECEIVABLE (ASSET) / CR CUSTOMER_WALLET
--   repay     -> DR CUSTOMER_WALLET / CR SACCOS<id>_LOANS_RECEIVABLE (principal)
--                              / CR SACCOS<id>_INTEREST_INCOME (REVENUE, interest)
-- Flat interest: total_repayable = principal * (1 + rate% * termMonths/12).
-- Repayment splits principal/interest proportionally to the loan
-- mix so every journal weighs out. Loan closes (CLOSED) when the
-- outstanding balance reaches zero; application marks REPAID.
-- Isolation: per-SACCOS ASSET/REVENUE codes; non-member reads 404.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_loan_applications (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- SCL-*
  requested_amount NUMERIC(15,2) NOT NULL CHECK (requested_amount > 0),
  purpose VARCHAR(255),
  term_months INT NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED, DISBURSED, REPAID
  requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
  decided_by INT REFERENCES users(id),
  decision_at TIMESTAMPTZ,
  disbursed_at TIMESTAMPTZ,
  repaid_at TIMESTAMPTZ,
  loan_id INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_loan_apps_saccos ON saccos_loan_applications(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_loans (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  application_id INT NOT NULL UNIQUE REFERENCES saccos_loan_applications(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- LNS-* (disbursement journal ref)
  principal NUMERIC(15,2) NOT NULL CHECK (principal > 0),
  interest_rate NUMERIC(6,2) NOT NULL DEFAULT 0,
  total_repayable NUMERIC(15,2) NOT NULL CHECK (total_repayable > 0),
  amount_outstanding NUMERIC(15,2) NOT NULL CHECK (amount_outstanding >= 0),
  term_months INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, ACTIVE, CLOSED
  disbursed_at TIMESTAMPTZ,
  repaid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_loans_saccos ON saccos_loans(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_loan_repayments (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  loan_id INT NOT NULL REFERENCES saccos_loans(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- REP-* (repayment journal ref)
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  principal_part NUMERIC(15,2) NOT NULL DEFAULT 0,
  interest_part NUMERIC(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'APPROVED',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_loan_repayments_loan ON saccos_loan_repayments(loan_id);