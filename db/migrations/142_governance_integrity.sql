-- Migration 142: Governance integrity hardening
-- Scope:
--   1. Secret ballot referential integrity and valid choices
--   2. Governance vote choice integrity
--   3. Governance proposal status integrity
--   4. One latest constitution per group
--   5. One latest resolution per group
--
-- Financial money movement remains outside governance.
-- Governance records decisions; the Financial Control Plane executes money movement.

BEGIN;

-- ---------------------------------------------------------------------------
-- SECRET BALLOT INTEGRITY
-- ---------------------------------------------------------------------------

ALTER TABLE governance_secret_ballot_box
  ADD CONSTRAINT governance_secret_ballot_box_proposal_fk
  FOREIGN KEY (proposal_id)
  REFERENCES governance_proposals(id)
  ON DELETE CASCADE;

ALTER TABLE governance_secret_ballot_box
  ADD CONSTRAINT governance_secret_ballot_box_choice_ck
  CHECK (choice IN ('YES', 'NO', 'ABSTAIN'));

CREATE INDEX IF NOT EXISTS idx_gov_secret_ballot_proposal
  ON governance_secret_ballot_box(proposal_id);

-- ---------------------------------------------------------------------------
-- GOVERNANCE VOTE INTEGRITY
--
-- SECRET is an intentional application-level participation marker.
-- The actual anonymous choice is stored only in governance_secret_ballot_box.
-- ---------------------------------------------------------------------------

ALTER TABLE governance_votes
  ADD CONSTRAINT governance_votes_choice_ck
  CHECK (choice IN ('YES', 'NO', 'ABSTAIN', 'SECRET'));

-- ---------------------------------------------------------------------------
-- PROPOSAL STATE INTEGRITY
-- ---------------------------------------------------------------------------

ALTER TABLE governance_proposals
  ADD CONSTRAINT governance_proposals_status_ck
  CHECK (status IN ('OPEN', 'VOTING', 'PASSED', 'FAILED', 'WITHDRAWN'));

-- ---------------------------------------------------------------------------
-- CONSTITUTION VERSION INTEGRITY
--
-- There must be at most one authoritative latest constitution for a group.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_gov_constitution_latest
  ON governance_constitutions(group_type, group_id)
  WHERE latest = TRUE;

-- ---------------------------------------------------------------------------
-- RESOLUTION VERSION INTEGRITY
--
-- There must be at most one latest resolution for a group.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_gov_resolution_latest
  ON governance_resolutions(group_type, group_id)
  WHERE is_latest = TRUE;

COMMIT;
