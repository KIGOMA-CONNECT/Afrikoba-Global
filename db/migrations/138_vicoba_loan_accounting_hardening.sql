-- 138 | Phase 66 — VICOBA loan accounting hardening.
-- Enforce database-level idempotency for loan repayments and prevent
-- duplicate installment numbers within the same loan.

ALTER TABLE vicoba_loan_repayments
  ADD CONSTRAINT uq_vicoba_loan_repayments_reference_id
  UNIQUE (reference_id);

ALTER TABLE vicoba_loan_schedules
  ADD CONSTRAINT uq_vicoba_loan_schedules_loan_installment
  UNIQUE (loan_id, installment_number);
