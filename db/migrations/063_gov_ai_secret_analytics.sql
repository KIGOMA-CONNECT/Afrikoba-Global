-- Migration 063: Deeper AI Secretary + Zero-knowledge anonymous voting + governance analytics

-- Add vote secrecy flag to proposals (anonymous voting)
ALTER TABLE governance_proposals ADD COLUMN IF NOT EXISTS secret_ballot BOOLEAN DEFAULT FALSE;

-- Add structure fields for AI-generated minutes
ALTER TABLE governance_minutes ADD COLUMN IF NOT EXISTS ai_structured JSONB DEFAULT '{}'::jsonb;

-- Governance analytics snapshot for dashboard trends
CREATE TABLE IF NOT EXISTS governance_analytics (
  id SERIAL PRIMARY KEY,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA',
  group_id INT NOT NULL,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_meetings INT DEFAULT 0,
  completed_meetings INT DEFAULT 0,
  avg_attendance_percent NUMERIC(5,2) DEFAULT 0,
  total_resolutions INT DEFAULT 0,
  passed_resolutions INT DEFAULT 0,
  total_action_items INT DEFAULT 0,
  completed_action_items INT DEFAULT 0,
  open_action_items INT DEFAULT 0,
  overdue_action_items INT DEFAULT 0,
  avg_decision_time_hours NUMERIC(10,2) DEFAULT 0,
  is_latest BOOLEAN DEFAULT TRUE,
  UNIQUE(group_type, group_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_gov_analytics_group ON governance_analytics(group_type, group_id, snapshot_date);

-- Anonymous vote receipts (counts only, never who-voted-how)
CREATE TABLE IF NOT EXISTS governance_secret_ballot_box (
  id SERIAL PRIMARY KEY,
  proposal_id INT NOT NULL,
  choice VARCHAR(10) NOT NULL,
  vote_token VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
