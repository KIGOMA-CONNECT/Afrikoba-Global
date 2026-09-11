-- ============================================================
-- SACCOS DIGITAL CORE - LOAN MANAGEMENT (increment 17)
-- 1) GUARANTORS / CO-SIGNERS: a borrower nominates active members to
--    underwrite an application (PENDING); each guarantor accepts
--    (ACCEPTED). Approval requires `lending.guaranteesRequired`
--    ACCEPTED guarantees. When `lending.savingsBackingEnabled` is on,
--    each live guarantor's own backing limit (savings + shares x
--    multiple) adds to the borrower's effective lending capacity
--    (snapshotted as `guaranteed_cover`). On disbursal guarantees
--    become ACTIVE (loan_id set); on OVERDUE arrears the guarantor's
--    wallet can be charged for overdue installments (PAID_OUT);
--    REPAID / WRITTEN_OFF loans RELEASE active guarantees. References
--    GNT-* (guarantee row) / GPAY-* intended prefixes unused at row
--    level - guarantee payments use REPI-* installment refs.
--
-- 2) RESTRUCTURE / RESCHEDULE: OWNER/BOARD restructure an ACTIVE loan
--    with outstanding balance. The balance is capitalized as the new
--    principal at `newRatePercent` over `newTermMonths` (flat
--    formula), the amortisation schedule is rebuilt from the unpaid
--    point onward and `schedule_version` increments. RST-* refs.
--
-- 3) WRITE-OFF: OWNER/BOARD write off an ACTIVE loan with
--    outstanding balance: DR `SACCOS<id>_LOAN_LOSS_RESERVES`
--    (utilised provision, min(provisioned, outstanding)) + DR
--    `SACCOS<id>_LOAN_LOSS_EXPENSE` (un-provisioned shortfall) /
--    CR `SACCOS<id>_LOANS_RECEIVABLE`; loan -> WRITTEN_OFF,
--    application -> WRITTEN_OFF, remaining installments cancelled,
--    guarantees released. WO-* refs, unique per loan.
--
-- 4) RECURRING CONTRIBUTIONS / STANDING ORDERS: a member instructs a
--    monthly auto-move (day_of_month 1-28) into savings, an ACTIVE
--    fund, an ACTIVE welfare scheme, or an ACTIVE personal loan.
--    Execution books the standard ledger path (savings deposit /
--    fund contribution / welfare contribution / loan repayment) once
--    per due date; failures retry and deactivate after 3 in a row.
-- -------------------------------------------------------------------
-- NOTE: saccos_loan_installments gains 'CANCELLED' (write-off).
-- ============================================================

-- Allow installments to be cancelled by a loan write-off.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'saccos_loan_installments_status_check'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c2
        WHERE c2.conname = 'saccos_loan_installments_status_check'
          AND pg_get_constraintdef(c2.oid) LIKE '%CANCELLED%'
      )
  ) THEN
    ALTER TABLE saccos_loan_installments
      DROP CONSTRAINT saccos_loan_installments_status_check;
    ALTER TABLE saccos_loan_installments
      ADD CONSTRAINT saccos_loan_installments_status_check
      CHECK (status IN ('PENDING', 'PAID', 'OVERDUE', 'CANCELLED'));
  END IF;
END $$;

-- Guarantor / co-signer support.
CREATE TABLE IF NOT EXISTS saccos_loan_guarantees (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  application_id INT NOT NULL REFERENCES saccos_loan_applications(id) ON DELETE CASCADE,
  loan_id INT REFERENCES saccos_loans(id) ON DELETE CASCADE,           -- set at disbursal
  guarantor_member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,                            -- GNT-*
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',                       -- PENDING, ACCEPTED, ACTIVE, RELEASED, PAID_OUT
  cover_amount NUMERIC(15,2) NOT NULL DEFAULT 0,                       -- guarantor backing limit at acceptance snapshot
  paid_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  created_by INT REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(application_id, guarantor_member_id)
);
CREATE INDEX IF NOT EXISTS idx_saccos_loan_guarantees_app
  ON saccos_loan_guarantees(saccos_id, application_id, status);
CREATE INDEX IF NOT EXISTS idx_saccos_loan_guarantees_loan
  ON saccos_loan_guarantees(loan_id, status);

-- Snapshot a (+) guaranteed cover (sum of live guarantor backing limits).
ALTER TABLE saccos_loan_applications
  ADD COLUMN IF NOT EXISTS guaranteed_cover NUMERIC(15,2) NOT NULL DEFAULT 0;

-- Version stamp for rebuilt amortisation schedules.
ALTER TABLE saccos_loans
  ADD COLUMN IF NOT EXISTS schedule_version INT NOT NULL DEFAULT 1;

-- Track utilisation of a provision by a write-off.
ALTER TABLE saccos_loan_loss_reserves
  ADD COLUMN IF NOT EXISTS utilized_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS saccos_loan_restructures (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  loan_id INT NOT NULL REFERENCES saccos_loans(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,          -- RST-*
  previous_principal NUMERIC(15,2) NOT NULL,
  previous_rate NUMERIC(6,2) NOT NULL,
  previous_term_months INT NOT NULL,
  previous_outstanding NUMERIC(15,2) NOT NULL,
  new_principal NUMERIC(15,2) NOT NULL,
  new_rate NUMERIC(6,2) NOT NULL,
  new_term_months INT NOT NULL,
  new_total NUMERIC(15,2) NOT NULL,
  reason VARCHAR(255),
  authorized_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_loan_restructures_loan
  ON saccos_loan_restructures(loan_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saccos_loan_write_offs (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  loan_id INT NOT NULL UNIQUE REFERENCES saccos_loans(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,          -- WO-*
  previous_outstanding NUMERIC(15,2) NOT NULL,
  reserves_used NUMERIC(15,2) NOT NULL DEFAULT 0,
  expense_used NUMERIC(15,2) NOT NULL DEFAULT 0,
  reason VARCHAR(255) NOT NULL,
  authorized_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_loan_write_offs_saccos
  ON saccos_loan_write_offs(saccos_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saccos_standing_orders (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,          -- SO-*
  target_type VARCHAR(24) NOT NULL CHECK (target_type IN
     ('SAVINGS_DEPOSIT', 'FUND_CONTRIBUTION', 'WELFARE_CONTRIBUTION', 'LOAN_REPAYMENT')),
  target_id INT,                                     -- fund / scheme / loan id (NULL for savings)
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  frequency VARCHAR(12) NOT NULL DEFAULT 'MONTHLY',
  day_of_month INT NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',      -- ACTIVE, DEACTIVATED
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  next_run_at DATE,                                  -- NULL => due on next trigger
  last_run_at TIMESTAMPTZ,
  total_runs INT NOT NULL DEFAULT 0,
  success_runs INT NOT NULL DEFAULT 0,
  fail_runs INT NOT NULL DEFAULT 0,
  last_error VARCHAR(300),
  deactivated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_standing_orders_due
  ON saccos_standing_orders(saccos_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_saccos_standing_orders_member
  ON saccos_standing_orders(member_id, status);