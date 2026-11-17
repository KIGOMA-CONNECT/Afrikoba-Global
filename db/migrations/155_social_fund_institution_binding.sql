-- Migration 155: Social Fund institution binding (DRAFT — NOT APPLIED)
-- MTC-17 Phase B: Institution-scoped authorization
--
-- Purpose: Add institution_id to social_fund_cases and social_fund_case_permissions
-- to enable reliable institution-to-case ownership binding.
--
-- STATUS: DRAFT — requires owner authorization before execution.
-- PREREQUISITE: Institution model must be defined (currently no institution table exists).

-- 1. Add institution_id to social_fund_cases (nullable for backward compat)
ALTER TABLE social_fund_cases ADD COLUMN IF NOT EXISTS institution_id INTEGER;

-- 2. Add institution_id to social_fund_case_permissions
ALTER TABLE social_fund_case_permissions ADD COLUMN IF NOT EXISTS institution_id INTEGER;

-- 3. Create index for institution-scoped permission lookups
CREATE INDEX IF NOT EXISTS idx_sf_case_perms_institution
  ON social_fund_case_permissions (institution_id, user_id, permission)
  WHERE revoked_at IS NULL;

-- 4. Backfill institution_id from context_type (best-effort, not authoritative)
-- NOTE: This is a best-effort backfill. context_type is not a reliable institution identifier.
-- UPDATE social_fund_cases SET institution_id = ... WHERE institution_id IS NULL;

-- 5. Add foreign key constraint (after backfill)
-- ALTER TABLE social_fund_cases ADD CONSTRAINT fk_sf_case_institution
--   FOREIGN KEY (institution_id) REFERENCES institutions(id);

-- NOTE: The institutions table does not yet exist. This migration is a PROPOSAL only.
-- Full implementation requires:
--   - Institution model definition
--   - Institution-to-user membership table
--   - Institution-to-case binding logic
--   - Owner approval for the institution model