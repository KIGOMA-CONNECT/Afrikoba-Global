-- 136 | Phase 10 — Liquidation & Final Close
-- Terminal lifecycle step: a COMPLETED project whose close-out is fully settled
-- (reserve + residual released, dividends paid, escrow returned) can be
-- liquidated. This archives it as LIQUIDATED and snapshots the final P&L
-- distribution so the record survives independent of the live ledger.

-- Extend the allowed project lifecycle states.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (
  status IN ('DRAFT','SUBMITTED','INITIAL_REVIEW','DUE_DILIGENCE','RISK_ASSESSMENT',
             'GOVERNANCE_REVIEW','APPROVED','REJECTED','PUBLISHED','FUNDING',
             'ACTIVE','COMPLETED','CANCELLED','EXPIRED','LIQUIDATED')
);

CREATE TABLE IF NOT EXISTS project_liquidations (
  id                            SERIAL PRIMARY KEY,
  project_id                    INTEGER NOT NULL UNIQUE REFERENCES projects(id),
  settlement_id                 INTEGER REFERENCES project_settlements(id),
  reference                     VARCHAR(64) NOT NULL UNIQUE,
  status                        VARCHAR(20) NOT NULL DEFAULT 'LIQUIDATED' CHECK (status IN ('LIQUIDATED')),
  funds_invested_total          NUMERIC(18,2) NOT NULL DEFAULT 0,
  revenue_total                 NUMERIC(18,2) NOT NULL DEFAULT 0,
  disbursed_to_owner            NUMERIC(18,2) NOT NULL DEFAULT 0,
  dividends_paid_to_investors   NUMERIC(18,2) NOT NULL DEFAULT 0,
  escrow_returned_to_investors  NUMERIC(18,2) NOT NULL DEFAULT 0,
  reserve_released_to_owner     NUMERIC(18,2) NOT NULL DEFAULT 0,
  residual_released_to_owner    NUMERIC(18,2) NOT NULL DEFAULT 0,
  owner_received_total          NUMERIC(18,2) NOT NULL DEFAULT 0,
  investor_received_total       NUMERIC(18,2) NOT NULL DEFAULT 0,
  investor_net                  NUMERIC(18,2) NOT NULL DEFAULT 0,
  investor_net_pct              NUMERIC(8,2) NOT NULL DEFAULT 0,
  summary                       JSONB,
  created_by                    INTEGER,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_project_liquidations_created
  ON project_liquidations (created_at);