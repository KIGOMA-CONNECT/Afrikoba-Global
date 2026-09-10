-- ============================================================
-- SACCOS DIGITAL CORE - GOVERNANCE (increment 5)
-- Entity-scoped collective decisioning on top of the SACCOS
-- membership model: OWNER/BOARD propose resolutions, members
-- vote FOR/AGAINST/ABSTAIN while a resolution is OPEN, and the
-- chair closes it into PASSED (quorum reached + decision
-- threshold met) or REJECTED (quorum missed or threshold not
-- met) or CANCELLED. Config (saccos.config.governance):
--   {allowMemberVoting, quorumPercent, decisionThresholdPercent,
--    votingDays}
-- quorumPercent  = share of ACTIVE members who must cast a vote
-- decisionThresholdPercent = share of cast votes that must be FOR
-- No money flows here -> no journal; every state change and vote
-- is an audit_logs row. Per-SACCOS scoping only: non-members
-- 404, cross-entity reads/votes 404, plain MEMBER cannot create/
-- open/close/cancel (SACCOS_RBAC). Suite 49.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_resolutions (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- RES-*
  created_by INT NOT NULL REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(50) DEFAULT 'GENERAL',       -- GENERAL, FINANCE, LOANS, INVESTMENT, MEMBERSHIP
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',  -- DRAFT, OPEN, PASSED, REJECTED, CANCELLED
  voting_deadline TIMESTAMPTZ,
  quorum_percent NUMERIC(5,2) NOT NULL DEFAULT 50,
  decision_threshold_percent NUMERIC(5,2) NOT NULL DEFAULT 60,
  opened_by INT REFERENCES users(id),
  opened_at TIMESTAMPTZ,
  closed_by INT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_resolutions_saccos ON saccos_resolutions(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_resolution_votes (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  resolution_id INT NOT NULL REFERENCES saccos_resolutions(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  choice VARCHAR(10) NOT NULL CHECK (choice IN ('FOR','AGAINST','ABSTAIN')),
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (resolution_id, member_id)             -- one vote per member per resolution
);
CREATE INDEX IF NOT EXISTS idx_saccos_resolution_votes_res ON saccos_resolution_votes(resolution_id);