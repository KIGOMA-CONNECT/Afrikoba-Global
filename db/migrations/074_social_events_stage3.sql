-- Stage 3 (Events): withdrawals & settlement, members & invitations, notifications & reminders

CREATE TABLE IF NOT EXISTS event_withdrawals (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('FUNDRAISING','SAVINGS')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reference_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','PAID','REJECTED','FAILED')),
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_flow_id INT,
  comment TEXT,
  approved_by INT REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_withdrawals_event ON event_withdrawals(event_id);
CREATE INDEX IF NOT EXISTS idx_event_withdrawals_status ON event_withdrawals(status);

CREATE TABLE IF NOT EXISTS event_members (
  event_id INT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER','ADMIN','MEMBER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LEFT')),
  invited_by INT REFERENCES users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_members_user ON event_members(user_id);

CREATE TABLE IF NOT EXISTS event_invites (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  event_id INT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  created_by INT NOT NULL REFERENCES users(id),
  max_uses INT NOT NULL DEFAULT 10,
  uses INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXHAUSTED','DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_invites_event ON event_invites(event_id);

CREATE TABLE IF NOT EXISTS event_reminders (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  commitment_id INT REFERENCES event_commitments(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('COMMITMENT_DUE','EVENT_UPCOMING','SAVINGS_SESSION')),
  channel TEXT NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('IN_APP','SMS','BOTH')),
  status TEXT NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT','FAILED')),
  sent_date DATE NOT NULL,
  reference_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_reminders_event ON event_reminders(event_id);
CREATE INDEX IF NOT EXISTS idx_event_reminders_dedup ON event_reminders(commitment_id, type, sent_date);
CREATE INDEX IF NOT EXISTS idx_event_reminders_type ON event_reminders(type, sent_date);