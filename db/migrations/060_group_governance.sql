-- Migration 060: Afrikoba Digital Group Governance & Collaboration Engine
-- Meetings, agenda, attendance, chat channels, voting, resolutions,
-- action items, minutes, documents, constitution, transcripts.

CREATE TABLE IF NOT EXISTS governance_meetings (
  id SERIAL PRIMARY KEY,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA', -- VICOBA, COOPERATIVE, SACCO, ASSOCIATION, ALUMNI, WORKPLACE, INVESTMENT, PARTNERSHIP, COMMUNITY
  group_id INT NOT NULL, -- references vicoba_groups.id (or other group type actors)
  title VARCHAR(200) NOT NULL,
  description TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'SCHEDULED', -- SCHEDULED, ONGOING, COMPLETED, CANCELLED
  channel VARCHAR(30) DEFAULT 'MEETING',
  meeting_format VARCHAR(20) DEFAULT 'VIDEO', -- VIDEO, AUDIO, HYBRID
  recording_consent BOOLEAN DEFAULT FALSE,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_meeting_group ON governance_meetings(group_type, group_id, scheduled_at);

CREATE TABLE IF NOT EXISTS governance_attendees (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES governance_meetings(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'INVITED', -- INVITED, ACCEPTED, DECLINED, ATTENDED
  attended_at TIMESTAMPTZ,
  response_at TIMESTAMPTZ,
  UNIQUE(meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_gov_att_meeting ON governance_attendees(meeting_id);

CREATE TABLE IF NOT EXISTS governance_agenda_items (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES governance_meetings(id) ON DELETE CASCADE,
  position INT DEFAULT 1,
  title VARCHAR(250) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'PENDING' -- PENDING, DISCUSSED, DECIDED
);

CREATE INDEX IF NOT EXISTS idx_gov_agenda_meeting ON governance_agenda_items(meeting_id);

CREATE TABLE IF NOT EXISTS governance_channels (
  id SERIAL PRIMARY KEY,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA',
  group_id INT NOT NULL,
  name VARCHAR(60) NOT NULL, -- General, Finance, Loans, Investment, Social Fund, Project, Announcements, Meeting
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_type, group_id, name)
);

CREATE INDEX IF NOT EXISTS idx_gov_channel_group ON governance_channels(group_type, group_id);

CREATE TABLE IF NOT EXISTS governance_chat_messages (
  id SERIAL PRIMARY KEY,
  channel_id INT NOT NULL REFERENCES governance_channels(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_msg_channel ON governance_chat_messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS governance_documents (
  id SERIAL PRIMARY KEY,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA',
  group_id INT NOT NULL,
  doc_category VARCHAR(60) NOT NULL, -- CONSTITUTION, MEMBERS, MEETINGS, MINUTES, RESOLUTIONS, VOTING, FINANCIAL, LOANS, PROJECT, SOCIAL_FUND, CONTRACTS, POLICIES, ANNOUNCEMENTS, AUDIT
  title VARCHAR(200) NOT NULL,
  body TEXT,
  file_path TEXT,
  access_level VARCHAR(20) DEFAULT 'MEMBERS', -- MEMBERS, OFFICERS, PUBLIC
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_doc_group ON governance_documents(group_type, group_id, doc_category);

CREATE TABLE IF NOT EXISTS governance_constitutions (
  id SERIAL PRIMARY KEY,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA',
  group_id INT NOT NULL,
  rules JSONB DEFAULT '{}'::jsonb, -- { quorum_required, voting_threshold, etc. }
  version INT DEFAULT 1,
  latest BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_proposals (
  id SERIAL PRIMARY KEY,
  meeting_id INT REFERENCES governance_meetings(id) ON DELETE SET NULL,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA',
  group_id INT NOT NULL,
  title VARCHAR(250) NOT NULL,
  description TEXT,
  proposed_by INT NOT NULL REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, VOTING, PASSED, FAILED, WITHDRAWN
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_prop_meeting ON governance_proposals(meeting_id);
CREATE INDEX IF NOT EXISTS idx_gov_prop_group ON governance_proposals(group_type, group_id);

CREATE TABLE IF NOT EXISTS governance_votes (
  id SERIAL PRIMARY KEY,
  proposal_id INT NOT NULL REFERENCES governance_proposals(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  choice VARCHAR(10) NOT NULL, -- YES, NO, ABSTAIN
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(proposal_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_gov_vote_prop ON governance_votes(proposal_id);

CREATE TABLE IF NOT EXISTS governance_resolutions (
  id SERIAL PRIMARY KEY,
  meeting_id INT REFERENCES governance_meetings(id) ON DELETE SET NULL,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA',
  group_id INT NOT NULL,
  proposal_id INT REFERENCES governance_proposals(id),
  title VARCHAR(250) NOT NULL,
  body TEXT NOT NULL,
  resolution_number VARCHAR(30),
  version INT DEFAULT 1,
  is_latest BOOLEAN DEFAULT TRUE,
  status VARCHAR(20) DEFAULT 'PASSED', -- PASSED, AMENDED, SUPERSEDED
  financial_action_type VARCHAR(40), -- LOAN_APPROVAL, CONTRIBUTION_CHANGE, EMERGENCY_FUND, INVESTMENT, etc.
  financial_amount NUMERIC(18,2),
  linked_to_workflow BOOLEAN DEFAULT FALSE,
  passed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_reso_group ON governance_resolutions(group_type, group_id);
CREATE INDEX IF NOT EXISTS idx_gov_reso_meeting ON governance_resolutions(meeting_id);

CREATE TABLE IF NOT EXISTS governance_action_items (
  id SERIAL PRIMARY KEY,
  resolution_id INT REFERENCES governance_resolutions(id) ON DELETE SET NULL,
  meeting_id INT REFERENCES governance_meetings(id) ON DELETE SET NULL,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA',
  group_id INT NOT NULL,
  role_or_member VARCHAR(100) NOT NULL, -- Treasury, Secretary, Member X
  responsible_user_id INT REFERENCES users(id),
  task TEXT NOT NULL,
  deadline DATE,
  status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, IN_PROGRESS, FOLLOW_UP, COMPLETED, OVERDUE
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_action_group ON governance_action_items(group_type, group_id);

CREATE TABLE IF NOT EXISTS governance_minutes (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES governance_meetings(id) ON DELETE CASCADE,
  draft JSONB DEFAULT '{}'::jsonb,       -- AI-generated draft
  official JSONB DEFAULT '{}'::jsonb,     -- human-confirmed final
  status VARCHAR(20) DEFAULT 'DRAFT',     -- DRAFT, PENDING_REVIEW, CONFIRMED
  reviewed_by INT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_min_meeting ON governance_minutes(meeting_id);

CREATE TABLE IF NOT EXISTS governance_transcripts (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES governance_meetings(id) ON DELETE CASCADE,
  transcript TEXT,
  summary TEXT,
  ai_status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PROCESSED
  recording_url TEXT,
  retention_days INT DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_tr_meeting ON governance_transcripts(meeting_id);
