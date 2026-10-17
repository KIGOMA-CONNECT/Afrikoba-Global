-- Migration 143: Governance integrity v2
--
-- Correct resolution lineage, financial execution invariants,
-- and supporting indexes.
--
-- Secret ballot anonymity is preserved.
-- No money movement occurs in this migration.

BEGIN;

ALTER TABLE governance_resolutions
  ADD COLUMN IF NOT EXISTS root_resolution_id INTEGER;

ALTER TABLE governance_resolutions
  ADD COLUMN IF NOT EXISTS parent_resolution_id INTEGER;

UPDATE governance_resolutions
SET root_resolution_id = id
WHERE root_resolution_id IS NULL;

ALTER TABLE governance_resolutions
  ALTER COLUMN root_resolution_id SET NOT NULL;

DROP INDEX IF EXISTS uq_gov_resolution_latest;

ALTER TABLE governance_resolutions
  ADD CONSTRAINT governance_resolutions_root_fk
  FOREIGN KEY (root_resolution_id)
  REFERENCES governance_resolutions(id)
  ON DELETE RESTRICT;

ALTER TABLE governance_resolutions
  ADD CONSTRAINT governance_resolutions_parent_fk
  FOREIGN KEY (parent_resolution_id)
  REFERENCES governance_resolutions(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_gov_resolution_latest_root
  ON governance_resolutions(root_resolution_id)
  WHERE is_latest = TRUE;

CREATE INDEX idx_gov_resolution_root
  ON governance_resolutions(root_resolution_id);

CREATE INDEX idx_gov_resolution_parent
  ON governance_resolutions(parent_resolution_id);

ALTER TABLE governance_resolutions
  ADD CONSTRAINT governance_resolutions_status_ck
  CHECK (
    status IN (
      'DRAFT',
      'PASSED',
      'FAILED',
      'AMENDED',
      'CANCELLED'
    )
  );

ALTER TABLE governance_financial_executions
  ADD CONSTRAINT governance_financial_execution_status_ck
  CHECK (
    status IN (
      'PENDING',
      'EXECUTED',
      'FAILED'
    )
  );

ALTER TABLE governance_financial_executions
  ADD CONSTRAINT governance_financial_execution_amount_ck
  CHECK (amount > 0);

ALTER TABLE governance_financial_executions
  ADD CONSTRAINT governance_fin_exec_provenance_ck
  CHECK (
    status <> 'EXECUTED'
    OR (
      executed_by IS NOT NULL
      AND executed_at IS NOT NULL
      AND ledger_reference IS NOT NULL
      AND length(btrim(ledger_reference)) > 0
    )
  );

CREATE INDEX idx_gov_fin_exec_resolution_status
  ON governance_financial_executions(resolution_id, status);

CREATE INDEX idx_gov_fin_exec_group_status
  ON governance_financial_executions(group_id, status);

CREATE INDEX IF NOT EXISTS idx_gov_secret_ballot_proposal_created
  ON governance_secret_ballot_box(proposal_id, created_at);

CREATE INDEX IF NOT EXISTS idx_gov_votes_proposal_choice
  ON governance_votes(proposal_id, choice);

COMMIT;
