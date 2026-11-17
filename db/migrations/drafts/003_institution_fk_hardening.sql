-- DRAFT MIGRATION C — Institution FK hardening (post-reconciliation)
-- STATUS: DRAFT ONLY — NOT APPLIED.
-- Preconditions: all institution_id values either NULL (unresolved/unbound) or valid FK targets;
-- no orphan rows; owner decision to tighten nullability if applicable.

-- 1. FK from social_fund_cases.institution_id -> institutions(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_sf_case_institution'
  ) THEN
    ALTER TABLE social_fund_cases
      ADD CONSTRAINT fk_sf_case_institution
      FOREIGN KEY (institution_id) REFERENCES institutions(id)
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. FK from social_fund_case_permissions.institution_id -> institutions(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_sf_case_perm_institution'
  ) THEN
    ALTER TABLE social_fund_case_permissions
      ADD CONSTRAINT fk_sf_case_perm_institution
      FOREIGN KEY (institution_id) REFERENCES institutions(id)
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. Optional: tighten nullability only after reconciliation is complete and verified.
-- ALTER TABLE social_fund_cases ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE social_fund_case_permissions ALTER COLUMN institution_id SET NOT NULL;
-- (requires owner decision + completed evidence-based binding)
