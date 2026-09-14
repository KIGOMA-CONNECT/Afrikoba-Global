-- 133 | Phase 5 — Advanced Project Funding: deadline, expiry, refunds, cap table
-- Adds funding deadline to projects; refund tracking on investments.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS funding_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS funding_expired_at TIMESTAMPTZ;

ALTER TABLE project_investments
  ADD COLUMN IF NOT EXISTS refund_reference VARCHAR(64),
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

-- refund_reference must be unique so re-claims are idempotent
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_investment_refund_reference
  ON project_investments (refund_reference)
  WHERE refund_reference IS NOT NULL;

-- Fast lookups for the expire sweep and investor refund queries
CREATE INDEX IF NOT EXISTS ix_projects_funding_deadline
  ON projects (funding_deadline)
  WHERE funding_deadline IS NOT NULL AND status IN ('FUNDING');

CREATE INDEX IF NOT EXISTS ix_project_investments_project_status
  ON project_investments (project_id, status);