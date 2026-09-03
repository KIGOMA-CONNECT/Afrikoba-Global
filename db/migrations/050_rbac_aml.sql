-- Four-eyes RBAC (maker-checker approvals) + AML case management.
CREATE TABLE IF NOT EXISTS approval_flows (
  id SERIAL PRIMARY KEY,
  action_type VARCHAR(80) NOT NULL,
  ref_type VARCHAR(60),
  ref_id INT,
  requester_id INT NOT NULL REFERENCES users(id),
  data JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_flows_status ON approval_flows(status);
CREATE INDEX IF NOT EXISTS idx_approval_flows_requester ON approval_flows(requester_id);

CREATE TABLE IF NOT EXISTS approval_actions (
  id SERIAL PRIMARY KEY,
  flow_id INT NOT NULL REFERENCES approval_flows(id) ON DELETE CASCADE,
  approver_id INT NOT NULL REFERENCES users(id),
  action VARCHAR(20) NOT NULL, -- APPROVE, REJECT
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_actions_flow ON approval_actions(flow_id);

CREATE TABLE IF NOT EXISTS aml_cases (
  id SERIAL PRIMARY KEY,
  alert_id INT REFERENCES fraud_alerts(id),
  user_id INT REFERENCES users(id),
  case_type VARCHAR(60) NOT NULL DEFAULT 'SUSPICIOUS_ACTIVITY',
  status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, INVESTIGATING, RESOLVED, CLOSED
  risk_level VARCHAR(20) DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH, CRITICAL
  assigned_to INT REFERENCES users(id),
  summary TEXT,
  disposition VARCHAR(60), -- CONFIRMED_FRAUD, FALSE_POSITIVE, REFERRED_TO_LRA, MONITORED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aml_cases_status ON aml_cases(status);
CREATE INDEX IF NOT EXISTS idx_aml_cases_user ON aml_cases(user_id);

CREATE TABLE IF NOT EXISTS aml_case_notes (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES aml_cases(id) ON DELETE CASCADE,
  author_id INT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aml_notes_case ON aml_case_notes(case_id);
