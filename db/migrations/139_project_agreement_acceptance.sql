-- ============================================================================
-- 139 PROJECT AGREEMENT ACCEPTANCE
-- Per-investor acceptance for crowdfunding/project investment agreements.
--
-- project_agreements.accepted_user_id is retained for backward compatibility.
-- New investment governance uses this table because one agreement version may
-- be accepted by many investors independently.
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_agreement_acceptances (
  id            SERIAL PRIMARY KEY,
  agreement_id  INTEGER NOT NULL REFERENCES project_agreements(id) ON DELETE CASCADE,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (agreement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_agreement_acceptance_project_user
  ON project_agreement_acceptances(project_id, user_id);

CREATE INDEX IF NOT EXISTS idx_project_agreement_acceptance_user
  ON project_agreement_acceptances(user_id);
