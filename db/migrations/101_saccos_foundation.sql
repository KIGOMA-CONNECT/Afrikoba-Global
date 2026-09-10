-- ============================================================
-- SACCOS DIGITAL CORE - FOUNDATION (increment 1)
-- Organization registration + config-driven setup + compliance
-- boundary + membership lifecycle.
-- Architectural rules honoured:
--   * Consumes existing identity: saccos_members.user_id →
--     users(id). No second identity layer.
--   * Entity-scoped: every row carries saccos_id; no cross-SACCOS
--     access without membership/RBAC.
--   * Ledger stays in the shared double-entry core (money movement
--     arrives with later increments: shares/savings/loans).
--   * Config-driven: membership rules, share structure, loan
--     products, approval levels are JSONB on saccos.config.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos (
  id SERIAL PRIMARY KEY,
  code VARCHAR(16) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL UNIQUE,
  registration_number VARCHAR(64),
  country_code VARCHAR(2) DEFAULT 'TZ',
  status VARCHAR(20) DEFAULT 'DRAFT',        -- DRAFT, ACTIVE, SUSPENDED
  config JSONB NOT NULL DEFAULT '{}'::jsonb, -- membership rules, share structure, loan products, approval levels
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saccos_compliance (
  saccos_id INT PRIMARY KEY REFERENCES saccos(id) ON DELETE CASCADE,
  legal_entity TEXT,
  regulatory_status VARCHAR(40) DEFAULT 'TECH_INFRA', -- TECH_INFRA | OPERATOR | PARTNER
  licence VARCHAR(80),
  permitted_activities TEXT[] DEFAULT '{}',
  custody_model TEXT,
  banking_partner TEXT,
  kyc_aml_level VARCHAR(40) DEFAULT 'STANDARD',
  reporting_requirements TEXT[] DEFAULT '{}',
  data_protection TEXT,
  product_restrictions TEXT[] DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saccos_members (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'MEMBER', -- OWNER, BOARD, MEMBER
  member_number VARCHAR(24) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'INVITED', -- INVITED, ACTIVE, SUSPENDED, EXITED
  membership_category VARCHAR(40) DEFAULT 'REGULAR',
  invited_by INT REFERENCES users(id),
  admission_date DATE,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (saccos_id, user_id),
  UNIQUE (saccos_id, member_number)
);

CREATE INDEX IF NOT EXISTS idx_saccos_members_acc  ON saccos_members(saccos_id, status);
CREATE INDEX IF NOT EXISTS idx_saccos_members_user ON saccos_members(user_id);

-- Operational flag (server only mounts /saccos routes when SACCOS_ENABLED=true;
-- flag row gives ops-console visibility of the gate).
INSERT INTO feature_flags (flag_key, label, description, enabled, rollout_percent) VALUES
  ('SACCOS_ENABLED', 'SACCOS Digital Core', 'SACCOS organization + membership foundation (increment 1).', false, 0)
ON CONFLICT (flag_key) DO NOTHING;