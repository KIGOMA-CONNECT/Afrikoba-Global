-- Migration 066: Automated Payroll Engine
-- Recurring member/staff compensation: pay schedules, payroll runs, payslips,
-- integrated with the multi-sig treasury and user ledger.

-- Payroll schedules (recurring definitions)
CREATE TABLE IF NOT EXISTS payroll_schedules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  treasury_wallet_id INT NOT NULL REFERENCES treasury_wallets(id) ON DELETE CASCADE,
  frequency VARCHAR(20) NOT NULL DEFAULT 'MONTHLY', -- DAILY, WEEKLY, BIWEEKLY, MONTHLY
  day_of_cycle INT DEFAULT 1,                       -- day of month / week
  status VARCHAR(20) DEFAULT 'ACTIVE',              -- ACTIVE, PAUSED, ARCHIVED
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_sched_wallet ON payroll_schedules(treasury_wallet_id);

-- Schedule entries (who gets paid what)
CREATE TABLE IF NOT EXISTS payroll_schedule_entries (
  id SERIAL PRIMARY KEY,
  schedule_id INT NOT NULL REFERENCES payroll_schedules(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  base_amount NUMERIC(15,2) NOT NULL,
  role VARCHAR(60),
  adjustments JSONB DEFAULT '[]'::jsonb,   -- [{ type: bonus|deduction, amount, label }]
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payroll runs (a single execution cycle)
CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  schedule_id INT NOT NULL REFERENCES payroll_schedules(id) ON DELETE CASCADE,
  treasury_wallet_id INT NOT NULL REFERENCES treasury_wallets(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'DRAFT',       -- DRAFT, PENDING_APPROVAL, APPROVED, PAID, PARTIAL, FAILED
  total_amount NUMERIC(18,2) DEFAULT 0,
  created_by INT REFERENCES users(id),
  approved_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payslips per recipient within a run
CREATE TABLE IF NOT EXISTS payroll_payslips (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  base_amount NUMERIC(15,2) NOT NULL,
  adjustments_total NUMERIC(15,2) DEFAULT 0,
  net_amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',     -- PENDING, PAID, FAILED
  ledger_ref VARCHAR(30),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payslip_run ON payroll_payslips(run_id);
