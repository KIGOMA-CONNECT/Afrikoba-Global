-- ROLLBACK for draft migration C (FK hardening)
ALTER TABLE social_fund_case_permissions DROP CONSTRAINT IF EXISTS fk_sf_case_perm_institution;
ALTER TABLE social_fund_cases DROP CONSTRAINT IF EXISTS fk_sf_case_institution;
-- If nullability was tightened (owner decision), revert:
-- ALTER TABLE social_fund_cases ALTER COLUMN institution_id DROP NOT NULL;
-- ALTER TABLE social_fund_case_permissions ALTER COLUMN institution_id DROP NOT NULL;
