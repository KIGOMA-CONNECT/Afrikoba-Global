-- ============================================================
-- SACCOS DIGITAL CORE - LOAN INSTALLMENTS & INTEREST ACCRUAL
-- (increment 12)
-- Extends the credit module with a per-loan repayment schedule.
-- Installments are generated deterministically from the disbursed
-- loan (term_months rows, principal_part + interest_part summing
-- exactly to principal and total_repayable - principal) with the
-- interest leg posted to the per-entity SACCOS<id>_INTEREST_INCOME
-- REVENUE account so interest is recognised on the shared ledger.
-- Installments must be paid in order (earlier instalments first);
-- each payment is idempotent behind a REPI-* reference claim.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_loan_installments (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  loan_id INT NOT NULL REFERENCES saccos_loans(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  installment_no INT NOT NULL,
  due_date DATE NOT NULL,
  principal_part NUMERIC(15,2) NOT NULL,
  interest_part NUMERIC(15,2) NOT NULL,
  total NUMERIC(15,2) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PAID', 'OVERDUE')),
  paid_at TIMESTAMPTZ,
  reference_id VARCHAR(32) UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (loan_id, installment_no)
);

CREATE INDEX IF NOT EXISTS idx_saccos_loan_installments_loan
  ON saccos_loan_installments (loan_id, installment_no);
CREATE INDEX IF NOT EXISTS idx_saccos_loan_installments_status
  ON saccos_loan_installments (saccos_id, status);