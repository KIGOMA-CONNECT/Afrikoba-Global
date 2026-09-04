-- Migration 062: Governance access control & retention
-- Fine-grained permissions on confidential documents, recordings, transcripts, and
-- action items. Controls who can view confidential group records and retention duration.

-- Extend governance_documents with retention + confidentiality
ALTER TABLE governance_documents ADD COLUMN IF NOT EXISTS retention_days INT DEFAULT NULL;
ALTER TABLE governance_documents ADD COLUMN IF NOT EXISTS confidential BOOLEAN DEFAULT FALSE;

-- Extend governance_transcripts with confidentiality flag
ALTER TABLE governance_transcripts ADD COLUMN IF NOT EXISTS confidential BOOLEAN DEFAULT FALSE;

-- Per-record access grants (overrides for specific members)
CREATE TABLE IF NOT EXISTS governance_access_grants (
  id SERIAL PRIMARY KEY,
  record_type VARCHAR(20) NOT NULL,    -- DOCUMENT, TRANSCRIPT, MEETING, RESOLUTION, ACTION
  record_id INT NOT NULL,
  grant_type VARCHAR(15) NOT NULL,     -- GRANT, DENY
  user_id INT REFERENCES users(id),
  role VARCHAR(40),                    -- ROLE_BASED grant/deny
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_grants_record ON governance_access_grants(record_type, record_id);

-- Retention policy defaults per group
CREATE TABLE IF NOT EXISTS governance_retention_policies (
  id SERIAL PRIMARY KEY,
  group_type VARCHAR(20) NOT NULL DEFAULT 'VICOBA',
  group_id INT NOT NULL,
  record_type VARCHAR(20) NOT NULL,    -- DOCUMENT, TRANSCRIPT, MEETING
  retention_days INT NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_type, group_id, record_type)
);
