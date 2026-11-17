-- ROLLBACK for draft migration B (Social Fund institution binding)
DROP INDEX IF EXISTS idx_sf_cases_institution;
DROP INDEX IF EXISTS idx_sf_case_perms_institution;
ALTER TABLE social_fund_case_permissions DROP COLUMN IF EXISTS institution_id;
ALTER TABLE social_fund_cases DROP COLUMN IF EXISTS institution_id;
