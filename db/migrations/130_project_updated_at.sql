-- ============================================================================
-- 130: ADD updated_at TO PROJECT MILESTONES & DISBURSEMENTS
-- project_milestones / project_disbursements (044) lacked updated_at; the
-- finance governance service sets updated_at on approval transitions.
-- ============================================================================
ALTER TABLE project_milestones
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE project_disbursements
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();