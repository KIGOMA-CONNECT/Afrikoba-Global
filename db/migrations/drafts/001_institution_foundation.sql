-- DRAFT MIGRATION A — Institution persistence foundation (OD-10 Phase 1)
-- STATUS: DRAFT ONLY — NOT APPLIED. Requires OD-10 implementation authorization and P0 gate.
-- This draft is intentionally separate from Migration 155.

-- 1. institutions (authoritative institution entity)
CREATE TABLE IF NOT EXISTS institutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','RETIRED')),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. institution owners (supports multiple verified owners)
CREATE TABLE IF NOT EXISTS institution_owners (
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  owner_id INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (status IN ('UNVERIFIED','VERIFIED','REVOKED')),
  verified_by INTEGER,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER,
  revocation_reason TEXT,
  PRIMARY KEY (institution_id, owner_id)
);

-- 3. institution resource bindings
CREATE TABLE IF NOT EXISTS institution_resource_bindings (
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(128) NOT NULL,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  bound_by INTEGER,
  evidence TEXT,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_irb_institution ON institution_resource_bindings (institution_id);

-- 4. institution role grants
CREATE TABLE IF NOT EXISTS institution_role_grants (
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  user_id INTEGER NOT NULL,
  permission VARCHAR(128) NOT NULL,
  granted_by INTEGER,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER,
  PRIMARY KEY (institution_id, user_id, permission, granted_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_irg_active
  ON institution_role_grants (institution_id, user_id, permission)
  WHERE revoked_at IS NULL;

-- 5. ownership change requests (four-eyes)
CREATE TABLE IF NOT EXISTS institution_ownership_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  target_owner_id INTEGER NOT NULL,
  change_type VARCHAR(64) NOT NULL,
  requested_by INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS institution_ownership_approvals (
  request_id UUID NOT NULL REFERENCES institution_ownership_requests(id) ON DELETE CASCADE ON UPDATE CASCADE,
  approver_id INTEGER NOT NULL,
  decision VARCHAR(16) NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, approver_id)
);
