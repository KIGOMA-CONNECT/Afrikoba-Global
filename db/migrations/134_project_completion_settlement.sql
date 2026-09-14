-- 134 | Phase 6 — Project lifecycle completion & final settlement
-- Adds completion timestamp to projects and an append-only settlement record.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Append-only final settlement snapshot (at most one per project).
CREATE TABLE IF NOT EXISTS project_settlements (
  id                  SERIAL PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  invested_total      NUMERIC(18,2) NOT NULL DEFAULT 0,
  escrow_balance      NUMERIC(18,2) NOT NULL DEFAULT 0,
  returned_to_investors NUMERIC(18,2) NOT NULL DEFAULT 0,
  owner_received      NUMERIC(18,2) NOT NULL DEFAULT 0,
  reserve_released    NUMERIC(18,2) NOT NULL DEFAULT 0,
  revenue_total       NUMERIC(18,2) NOT NULL DEFAULT 0,
  dividend_allocated  NUMERIC(18,2) NOT NULL DEFAULT 0,
  dividend_pending    NUMERIC(18,2) NOT NULL DEFAULT 0,
  milestone_total     INTEGER NOT NULL DEFAULT 0,
  milestone_completed INTEGER NOT NULL DEFAULT 0,
  summary             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS ix_project_settlements_project
  ON project_settlements (project_id);