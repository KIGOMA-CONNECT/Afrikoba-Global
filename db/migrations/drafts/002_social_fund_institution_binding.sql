-- DRAFT MIGRATION B — Social Fund institution binding (revised from Migration 155)
-- STATUS: DRAFT ONLY — NOT APPLIED. Requires OD-10 implementation authorization and P0 gate.
-- Additive only. No FK yet (hardening in Migration C after reconciliation).

-- 1. Add institution_id (UUID, nullable during transition) to social_fund_cases
ALTER TABLE social_fund_cases
  ADD COLUMN IF NOT EXISTS institution_id UUID;

-- 2. Add institution_id (UUID, nullable during transition) to social_fund_case_permissions
ALTER TABLE social_fund_case_permissions
  ADD COLUMN IF NOT EXISTS institution_id UUID;

-- 3. Index for institution-scoped permission lookups
CREATE INDEX IF NOT EXISTS idx_sf_case_perms_institution
  ON social_fund_case_permissions (institution_id, user_id, permission)
  WHERE revoked_at IS NULL;

-- 4. Index for institution-scoped case queries
CREATE INDEX IF NOT EXISTS idx_sf_cases_institution
  ON social_fund_cases (institution_id);

-- NO BACKFILL in this migration. Legacy reconciliation is a separate auditable step.
-- NO FOREIGN KEY in this migration. FK hardening occurs in Migration C.
