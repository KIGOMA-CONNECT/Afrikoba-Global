-- Migration 064: AI Risk Engine, Recommendation Engine, and Confidence/Explainability
-- Extends the AI governance model register (afri-ai-*) with per-user risk assessments,
-- actionable recommendations, and explainable confidence scores.

-- Risk assessment snapshots per user
CREATE TABLE IF NOT EXISTS ai_risk_assessments (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  risk_score NUMERIC(5,2) NOT NULL,          -- 0-100 (higher = higher risk)
  risk_level VARCHAR(20) NOT NULL,           -- LOW, MEDIUM, HIGH, CRITICAL
  confidence NUMERIC(5,2) NOT NULL,          -- 0-100 model confidence
  factors JSONB DEFAULT '[]'::jsonb,         -- contributing factors with weights
  recommendations JSONB DEFAULT '[]'::jsonb, -- linked mitigation recommendations
  model_version VARCHAR(30) DEFAULT 'afri-risk-1.0',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_risk_user ON ai_risk_assessments(user_id, created_at);

-- Actionable AI recommendations per user
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  category VARCHAR(40) NOT NULL,             -- SAVINGS, BUDGET, CREDIT, RISK, INVESTMENT, GOVERNANCE
  priority VARCHAR(10) NOT NULL DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH, CRITICAL
  title TEXT NOT NULL,
  body TEXT,
  impact_estimate JSONB DEFAULT '{}'::jsonb, -- expected positive impact
  confidence NUMERIC(5,2) NOT NULL,          -- 0-100
  status VARCHAR(20) DEFAULT 'ACTIVE',       -- ACTIVE, ACTED, DISMISSED
  model_version VARCHAR(30) DEFAULT 'afri-reco-1.0',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_reco_user ON ai_recommendations(user_id, status);

-- Explainability ledger: logs the rationale and input features for each AI decision
CREATE TABLE IF NOT EXISTS ai_decision_explanations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  decision_type VARCHAR(40) NOT NULL,        -- RISK, RECOMMENDATION, CREDIT, INSIGHT
  decision_ref INT,                          -- id into the relevant table
  model_version VARCHAR(30) NOT NULL,
  inputs JSONB DEFAULT '{}'::jsonb,          -- input features used
  top_features JSONB DEFAULT '[]'::jsonb,    -- highest-impact features
  explanation TEXT,
  confidence NUMERIC(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_expl_user ON ai_decision_explanations(user_id, created_at);
