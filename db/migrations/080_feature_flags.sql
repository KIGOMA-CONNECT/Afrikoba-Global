-- 080_feature_flags.sql
-- Feature flags + experimentation framework: kill-switches, gradual rollout,
-- role targeting, per-user overrides, and evaluation analytics.

CREATE TABLE IF NOT EXISTS feature_flags (
  id BIGSERIAL PRIMARY KEY,
  flag_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  description TEXT DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  rollout_percent INT NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  audience JSONB NOT NULL DEFAULT '[]'::jsonb,
  override_user_ids BIGINT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flag_evaluations (
  id BIGSERIAL PRIMARY KEY,
  flag_key TEXT NOT NULL,
  user_id BIGINT,
  decision TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flag_evaluations_flag_date ON flag_evaluations(flag_key, created_at);
CREATE INDEX IF NOT EXISTS idx_flag_evaluations_user ON flag_evaluations(user_id);

INSERT INTO feature_flags (flag_key, label, description, enabled, rollout_percent)
VALUES
  ('EVENTS_STAGE5', 'Events Stage 5', 'Social event reminders, deadlines & FX contributions', TRUE, 100),
  ('FRAUD_OPS_DASHBOARD', 'Fraud Operations Centre', 'Admin fraud-ops dashboard aggregation & case workbench', TRUE, 100),
  ('ONBOARDING_V2', 'Onboarding V2', 'Choose-your-services onboarding card on dashboard', TRUE, 100)
ON CONFLICT (flag_key) DO NOTHING;