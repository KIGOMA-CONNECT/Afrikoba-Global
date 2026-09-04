-- Migration 067: Recurrence Automation Scheduler
-- General-purpose recurring task scheduler powering auto-payroll, auto-savings,
-- automatic VICOBA contribution-cycle creation, and standing instructions.

-- Recurrence definitions
CREATE TABLE IF NOT EXISTS recurrence_rules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  task_type VARCHAR(40) NOT NULL,      -- PAYROLL_RUN | AUTO_SAVINGS | CONTRIBUTION_CYCLE | STANDING_INSTRUCTION
  frequency VARCHAR(20) NOT NULL,      -- DAILY, WEEKLY, BIWEEKLY, MONTHLY
  interval_step INT DEFAULT 1,
  day_of_month INT,
  day_of_week INT,                     -- 0=Sunday..6
  payload JSONB DEFAULT '{}'::jsonb,   -- task-specific config (schedule_id, group_id, user_id, amount...)
  next_run_at TIMESTAMPTZ NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  run_count INT DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurrence_next ON recurrence_rules(next_run_at) WHERE enabled;

-- Execution history / audit
CREATE TABLE IF NOT EXISTS recurrence_executions (
  id SERIAL PRIMARY KEY,
  rule_id INT NOT NULL REFERENCES recurrence_rules(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,         -- SUCCESS, FAILED, SKIPPED
  detail JSONB DEFAULT '{}'::jsonb,
  run_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurrence_exec_rule ON recurrence_executions(rule_id, run_at);
