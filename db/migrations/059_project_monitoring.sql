-- Migration 059: Project monitoring, cost variance, and schedule tracking tables

CREATE TABLE IF NOT EXISTS project_monitoring (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL,
  baseline_budget NUMERIC(18,2) DEFAULT 0,       -- approved budget
  actual_cost NUMERIC(18,2) DEFAULT 0,            -- cumulative actual spend
  planned_value NUMERIC(18,2) DEFAULT 0,          -- budgeted cost of work scheduled
  earned_value NUMERIC(18,2) DEFAULT 0,           -- budgeted cost of work performed
  planned_duration_days INT DEFAULT 0,
  elapsed_days INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'ON_TRACK',          -- ON_TRACK, AT_RISK, OVER_BUDGET, BEHIND_SCHEDULE, COMPLETED
  last_reviewed_by INT REFERENCES users(id),
  snapshot_taken_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_monitor_proj ON project_monitoring(project_id);
CREATE INDEX IF NOT EXISTS idx_project_monitor_status ON project_monitoring(status);

CREATE TABLE IF NOT EXISTS project_milestones (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL,
  milestone_name VARCHAR(150) NOT NULL,
  planned_date DATE NOT NULL,
  actual_date DATE,
  planned_budget NUMERIC(18,2) DEFAULT 0,
  actual_cost NUMERIC(18,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PENDING',           -- PENDING, IN_PROGRESS, COMPLETED, DELAYED
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_milestone_proj ON project_milestones(project_id);
