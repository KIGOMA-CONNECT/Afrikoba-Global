-- DRAFT MIGRATION D — GSF institutional governance persistence (OD-10 Phase 2 P3)
-- STATUS: DRAFT ONLY — NOT APPLIED. Requires separate authorization for any production use.

-- gsf_institutions removed: canonical identity is `institutions` (draft 001). GSF governance tables reference institutions(id).

CREATE TABLE IF NOT EXISTS gsf_institution_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  evidence_type VARCHAR(64) NOT NULL,
  evidence_ref TEXT NOT NULL,
  submitted_by INTEGER,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_by INTEGER,
  verified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gsf_institution_members (
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL,
  membership_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE'
    CHECK (membership_status IN ('ACTIVE','SUSPENDED','REVOKED')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (institution_id, user_id)
);

CREATE TABLE IF NOT EXISTS gsf_institution_owners (
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (status IN ('UNVERIFIED','VERIFIED','REVOKED')),
  verified_by INTEGER,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER,
  PRIMARY KEY (institution_id, user_id)
);

CREATE TABLE IF NOT EXISTS gsf_governance_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(128) NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS gsf_governance_grants (
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL,
  permission_code VARCHAR(128) NOT NULL REFERENCES gsf_governance_permissions(code),
  granted_by INTEGER,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER,
  PRIMARY KEY (institution_id, user_id, permission_code, granted_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_gsf_grant_active
  ON gsf_governance_grants (institution_id, user_id, permission_code)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS gsf_ownership_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  target_user_id INTEGER NOT NULL,
  change_type VARCHAR(64) NOT NULL,
  requested_by INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED','ESCALATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gsf_ownership_change_approvals (
  request_id UUID NOT NULL REFERENCES gsf_ownership_change_requests(id) ON DELETE CASCADE,
  approver_id INTEGER NOT NULL,
  decision VARCHAR(16) NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, approver_id)
);

CREATE TABLE IF NOT EXISTS gsf_campaign_institution_links (
  campaign_id INTEGER NOT NULL,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  link_status VARCHAR(32) NOT NULL DEFAULT 'UNRESOLVED'
    CHECK (link_status IN ('VERIFIED','UNRESOLVED','INTENTIONALLY_UNBOUND','AMBIGUOUS')),
  evidence TEXT,
  linked_by INTEGER,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id)
);

CREATE TABLE IF NOT EXISTS gsf_governance_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID REFERENCES institutions(id) ON DELETE RESTRICT,
  actor_id INTEGER,
  action VARCHAR(128) NOT NULL,
  resource_type VARCHAR(64),
  resource_id VARCHAR(128),
  outcome VARCHAR(32) NOT NULL,
  correlation_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB
);
