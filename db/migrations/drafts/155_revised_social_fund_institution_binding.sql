-- REVISED DRAFT Migration 155 — Social Fund institution binding (UUID-aligned)
-- STATUS: DRAFT ONLY — NOT APPLIED. Supersedes the original INTEGER-based 155 draft.
-- Requires OD-10 implementation authorization and P0 gate.
-- Depends on draft migrations A, B, C and evidence-based legacy reconciliation.

-- This revised draft assumes draft migration B has already added UUID institution_id columns.
-- It adds no new columns; it only documents the intended final binding and constraints.

-- Ensure institution-scoped permission index exists (idempotent).
CREATE INDEX IF NOT EXISTS idx_sf_case_perms_institution
  ON social_fund_case_permissions (institution_id, user_id, permission)
  WHERE revoked_at IS NULL;

-- Ensure institution-scoped case index exists (idempotent).
CREATE INDEX IF NOT EXISTS idx_sf_cases_institution
  ON social_fund_cases (institution_id);

-- FK hardening is performed by draft migration C after reconciliation.
-- No backfill is performed here.

-- NOTE: The original Migration 155 (INTEGER-based) is superseded by this UUID-aligned draft.
-- The original file remains quarantined and must not be executed.
