-- ============================================================================
-- 046 AI FINANCIAL INTELLIGENCE LAYER
-- Phase 8: self-hosted bank-grade financial intelligence on top of existing
-- analytics primitives (spending_analytics / smart_alerts / credit_scores).
--  1) ai_insights  - persisted, human-readable recommendations computed from
--                    transaction/behavioural data (spending concentration,
--                    cashflow forecast, savings-rate, budget health, anomalies,
--                    credit readiness, loan relief). Each row is auditable.
--  2) ai_model_register - model/AI governance register (blueprint: "model/AI
--                    governance register not built") documenting which model
--                    version produced which running of insights.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_insights (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  insight_type  VARCHAR(40) NOT NULL,        -- SPEND_CONCENTRATION | CASHFLOW | SAVINGS_RATE | BUDGET_HEALTH | ANOMALY | CREDIT_READINESS | LOAN_RELIEF | DIGEST
  severity      VARCHAR(16) NOT NULL DEFAULT 'info' CHECK (severity IN ('good','info','warning','alert')),
  title         VARCHAR(200),
  body          TEXT,
  metric        NUMERIC(14,2),
  meta          JSONB,
  model_version VARCHAR(20) DEFAULT 'afri-ai-1.0',
  dismissed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_insights_user ON ai_insights(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_insights_user_active ON ai_insights(user_id) WHERE NOT dismissed;

-- Model/AI governance register: one row per generation run.
CREATE TABLE IF NOT EXISTS ai_model_register (
  id              SERIAL PRIMARY KEY,
  model_key       VARCHAR(40) NOT NULL,      -- 'ai-financial-intelligence'
  model_version   VARCHAR(20) NOT NULL,
  generated_by    INT REFERENCES users(id),  -- who triggered the run
  scope_user_id   INT REFERENCES users(id),  -- which user's data was scored
  insight_count   INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
