-- 081_four_eyes_experiments.sql
-- Role-based four-eyes (dual-control maker-checker with role enforcement)
-- + A/B experimentation engine layered on feature flags.

CREATE TABLE IF NOT EXISTS four_eyes_policies (
  id BIGSERIAL PRIMARY KEY,
  action_code TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  required_approvers INT NOT NULL DEFAULT 1 CHECK (required_approvers BETWEEN 1 AND 3),
  approver_roles TEXT[] NOT NULL DEFAULT '{ADMIN}',
  allow_self_approve BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS four_eyes_requests (
  id BIGSERIAL PRIMARY KEY,
  action_code TEXT NOT NULL,
  requester_id BIGINT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','EXECUTED','FAILED','CANCELLED')),
  executed_by BIGINT,
  execution_result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS four_eyes_approvals (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES four_eyes_requests(id) ON DELETE CASCADE,
  approver_id BIGINT NOT NULL,
  approver_role TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, approver_id)
);

CREATE INDEX IF NOT EXISTS idx_four_eyes_requests_status ON four_eyes_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_four_eyes_requests_requester ON four_eyes_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_four_eyes_approvals_request ON four_eyes_approvals(request_id);

CREATE TABLE IF NOT EXISTS experiments (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  flag_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','RUNNING','PAUSED','STOPPED','ARCHIVED')),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  variants JSONB NOT NULL DEFAULT '[{"key":"control","weight":50},{"key":"treatment","weight":50}]'::jsonb,
  audience JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{"primary":null,"secondary":[]}'::jsonb,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  id BIGSERIAL PRIMARY KEY,
  experiment_id BIGINT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  variant TEXT NOT NULL,
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (experiment_id, user_id)
);

CREATE TABLE IF NOT EXISTS experiment_events (
  id BIGSERIAL PRIMARY KEY,
  experiment_id BIGINT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id BIGINT,
  variant TEXT NOT NULL,
  event_name TEXT NOT NULL,
  value NUMERIC(18,4) NOT NULL DEFAULT 0,
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_experiment_events_exp_name ON experiment_events(experiment_id, event_name, created_at);
CREATE INDEX IF NOT EXISTS idx_experiment_assignments_exp ON experiment_assignments(experiment_id);

INSERT INTO feature_flags (flag_key, label, description, enabled, rollout_percent)
VALUES
  ('FOUR_EYES', 'Role-based four-eyes', 'Dual-control maker-checker for sensitive admin actions', TRUE, 100),
  ('EXPERIMENTS', 'A/B Experiments', 'A/B experimentation engine on top of feature flags', TRUE, 100)
ON CONFLICT (flag_key) DO NOTHING;

INSERT INTO four_eyes_policies (action_code, description, required_approvers, approver_roles)
VALUES
  ('ADMIN_PROMOTE_ROLE', 'Promote a user to a higher privilege role', 1, '{ADMIN}'),
  ('ADMIN_DEMOTE_ROLE', 'Demote a user from a privilege role', 1, '{ADMIN}'),
  ('ADMIN_LARGE_REFUND', 'Issue a large wallet refund (dual control)', 1, '{ADMIN}')
ON CONFLICT (action_code) DO NOTHING;