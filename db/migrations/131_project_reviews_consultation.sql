-- ============================================================================
-- 131 PHASE 3: Project Reviews & Consultation Fee
-- AI review (append-only), consultation fee (idempotent), expanded
-- submission form fields, consultation revenue ledger account.
-- ============================================================================

-- Consultation fee ledger account (REVENUE, 4100 chart)
INSERT INTO ledger_accounts (account_code, name, account_type, chart_of_account)
VALUES
  ('PROJECT_CONSULTATION_FEE', 'Project Consultation Fee Revenue', 'REVENUE', 4100)
ON CONFLICT (account_code) DO NOTHING;

-- Expanded submission columns on projects (backward-compatible defaults)
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS business_model TEXT,
  ADD COLUMN IF NOT EXISTS market_analysis TEXT,
  ADD COLUMN IF NOT EXISTS competition_analysis TEXT,
  ADD COLUMN IF NOT EXISTS management_team TEXT,
  ADD COLUMN IF NOT EXISTS use_of_funds TEXT,
  ADD COLUMN IF NOT EXISTS exit_timeline TEXT,
  ADD COLUMN IF NOT EXISTS compliance_certifications TEXT,
  ADD COLUMN IF NOT EXISTS consultation_fee NUMERIC(19,2) NOT NULL DEFAULT 1500000,
  ADD COLUMN IF NOT EXISTS consultation_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_score NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS ai_review_count INTEGER NOT NULL DEFAULT 0;

-- Append-only AI review records (never updated/deleted)
CREATE TABLE IF NOT EXISTS project_ai_reviews (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  score             NUMERIC(5,1) NOT NULL CHECK (score >= 0 AND score <= 100),
  risk_flags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence        NUMERIC(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  model_version     VARCHAR(50) NOT NULL,
  financial_health  JSONB NOT NULL DEFAULT '{}'::jsonb,
  submission_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_action VARCHAR(30) NOT NULL DEFAULT 'REVIEW',
  reviewed_by       INTEGER,
  reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pai_reviews_project ON project_ai_reviews(project_id);
CREATE INDEX IF NOT EXISTS idx_pai_reviews_reviewed ON project_ai_reviews(reviewed_at DESC);

-- Consultation fee payments (idempotent)
CREATE TABLE IF NOT EXISTS project_consultations (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  owner_user_id     INTEGER NOT NULL REFERENCES users(id),
  amount            NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  unique_reference  VARCHAR(120) NOT NULL,
  wallet_txn_id     INTEGER,
  paid_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status            VARCHAR(20) NOT NULL DEFAULT 'PAID'
                    CHECK (status IN ('PAID','REFUNDED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pconsult_ref ON project_consultations(unique_reference);
CREATE INDEX IF NOT EXISTS idx_pconsult_project ON project_consultations(project_id);

-- Project progress reports (for expert submissions)
CREATE TABLE IF NOT EXISTS project_progress_reports (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  submitted_by      INTEGER NOT NULL REFERENCES users(id),
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  summary           TEXT,
  financials        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pproject_report_project ON project_progress_reports(project_id);

-- Waterfall override fields for versioned rules (event timeline tracking)
ALTER TABLE waterfall_allocation_rules
  ADD COLUMN IF NOT EXISTS effective_at TIMESTAMPTZ;

-- Update controlled_project_accounts with consultation_fee reserved
ALTER TABLE controlled_project_accounts
  ADD COLUMN IF NOT EXISTS consultation_fee NUMERIC(19,2) NOT NULL DEFAULT 0;