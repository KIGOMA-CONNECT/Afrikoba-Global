-- ============================================================
-- SACCOS DIGITAL CORE - OVERDUE ARREARS & LATE-FEE ACCRUAL
-- (increment 13)
-- Completes the OVERDUE lifecycle of saccos_loan_installments
-- (migration 112 introduced the status but nothing ever set it).
-- Adds per-installment late-fee fields materialised by the
-- arrears pass: once an installment's due date passes the grace
-- period it is flipped PENDING -> OVERDUE with days_late and a
-- late fee = total * lateFeePercent% * ceil(days_late/30) that is
-- posted to the per-entity SACCOS<id>_LATE_FEE_INCOME REVENUE
-- account when the installment is finally paid.
-- Config lives in saccos.config.lending:
--   { graceDays, lateFeePercent } (default 0 days / 2% per month).
-- ============================================================

ALTER TABLE saccos_loan_installments
  ADD COLUMN IF NOT EXISTS days_late INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_fee NUMERIC(15,2) NOT NULL DEFAULT 0;