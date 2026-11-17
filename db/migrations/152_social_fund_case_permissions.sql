-- Migration 152: Social Fund case permissions (institution-scoped authorization)
-- SF10-01: Campaign status changes require explicit institution-scoped permission.
-- Global ADMIN alone does not substitute for the required permission.

CREATE TABLE IF NOT EXISTS social_fund_case_permissions (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES social_fund_cases(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(50) NOT NULL,
  granted_by INTEGER REFERENCES users(id),
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (case_id, user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_sf_case_perms_user ON social_fund_case_permissions (user_id, permission) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sf_case_perms_case ON social_fund_case_permissions (case_id, permission) WHERE revoked_at IS NULL;

-- View for active permissions (not revoked)
CREATE OR REPLACE VIEW social_fund_active_case_permissions AS
SELECT * FROM social_fund_case_permissions WHERE revoked_at IS NULL;