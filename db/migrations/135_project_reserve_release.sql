-- 135 | Phase 7 — Close-out: owner reserve release (append-only, idempotent)
-- Tracks the double-entry release of a COMPLETED project's accrued
-- DISTRIBUTION_RESERVE to the project owner, so owner_received reflects
-- real cash in the close-out report.

CREATE TABLE IF NOT EXISTS project_reserve_releases (
  id             SERIAL PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  settlement_id  INTEGER REFERENCES project_settlements(id),
  reserve_type   VARCHAR(40) NOT NULL DEFAULT 'DISTRIBUTION_RESERVE',
  amount         NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  released_to    INTEGER NOT NULL REFERENCES users(id),
  reference      VARCHAR(64) NOT NULL UNIQUE,
  status         VARCHAR(20) NOT NULL DEFAULT 'RELEASED' CHECK (status IN ('RELEASED')),
  created_by     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, reserve_type)
);

CREATE INDEX IF NOT EXISTS ix_project_reserve_releases_project
  ON project_reserve_releases (project_id);