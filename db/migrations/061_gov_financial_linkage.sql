-- Migration 061: Governance → Financial Decision Linkage
-- Ties approved resolutions to financial workflow execution and ledger records,
-- so every financial action has an immutable governance authorization.

CREATE TABLE IF NOT EXISTS governance_financial_executions (
  id SERIAL PRIMARY KEY,
  resolution_id INT NOT NULL REFERENCES governance_resolutions(id) ON DELETE CASCADE,
  group_id INT NOT NULL,
  financial_action_type VARCHAR(40) NOT NULL, -- LOAN_APPROVAL, CONTRIBUTION_CHANGE, PAYOUT, EMERGENCY_FUND, INVESTMENT
  target_entity_type VARCHAR(30),             -- VICOBA_LOAN, CONTRIBUTION_SCHEDULE, SOCIAL_FUND, TRANSFER
  target_entity_id INT,
  amount NUMERIC(18,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',       -- PENDING, EXECUTED, FAILED
  ledger_reference VARCHAR(50),
  executed_by INT REFERENCES users(id),
  executed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_fin_exec_reso ON governance_financial_executions(resolution_id);
CREATE INDEX IF NOT EXISTS idx_gov_fin_exec_group ON governance_financial_executions(group_id, status);
