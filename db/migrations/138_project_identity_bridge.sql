-- 138_project_identity_bridge.sql
-- Bridges legacy P2P investment_projects to authoritative Project Finance projects.
-- Existing records remain unmapped until explicitly reconciled.

ALTER TABLE investment_projects
  ADD COLUMN authoritative_project_id INTEGER NULL;

ALTER TABLE investment_projects
  ADD CONSTRAINT investment_projects_authoritative_project_id_fkey
  FOREIGN KEY (authoritative_project_id)
  REFERENCES projects(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX investment_projects_authoritative_project_id_uq
  ON investment_projects(authoritative_project_id)
  WHERE authoritative_project_id IS NOT NULL;
