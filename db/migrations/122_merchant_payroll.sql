-- ============================================================================
-- 122 MERCHANT PAYROLL COMPLETION
-- Aligns payroll_schedules + payroll_runs to a merchant-funded, gross/net
-- payroll model; per-payslip tax/deductions breakdown; worker snapshots.
-- Idempotent against BOTH the fresh-CI 066 shape and a legacy payroll_runs
-- shape (business_id / period / employee_count) that 066 could not replace.
-- ============================================================================

-- Schedules: add merchant funding + currency + tax config
ALTER TABLE payroll_schedules
  ADD COLUMN IF NOT EXISTS merchant_id INT REFERENCES merchants(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NOT NULL DEFAULT 'TZS',
  ADD COLUMN IF NOT EXISTS tax_brackets JSONB;

ALTER TABLE payroll_schedules ALTER COLUMN treasury_wallet_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_sched_merchant ON payroll_schedules(merchant_id);

-- Schedule entries: mark taxable
ALTER TABLE payroll_schedule_entries
  ADD COLUMN IF NOT EXISTS taxable BOOLEAN NOT NULL DEFAULT TRUE;

-- Runs: 066 target shape + merchant funding columns
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS schedule_id INT REFERENCES payroll_schedules(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS treasury_wallet_id INT REFERENCES treasury_wallets(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS merchant_id INT REFERENCES merchants(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS funding_source VARCHAR(20) NOT NULL DEFAULT 'TREASURY',
  ADD COLUMN IF NOT EXISTS period_start DATE,
  ADD COLUMN IF NOT EXISTS period_end DATE,
  ADD COLUMN IF NOT EXISTS net_total NUMERIC(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_total NUMERIC(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_by INT REFERENCES users(id);

ALTER TABLE payroll_runs ALTER COLUMN treasury_wallet_id DROP NOT NULL;

-- Legacy payroll_runs columns (old v1 design) removed where present
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS business_id;
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS employee_count;
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS period;

-- Payslips: gross/tax/deductions breakdown + worker snapshot
ALTER TABLE payroll_payslips
  ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deductions_total NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employee_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS employee_phone VARCHAR(40);