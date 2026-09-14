-- 132 | Phase 4 — Transparency & Notifications: per-investor dividend entitlements & payouts
-- Append-only investor payout ledger keyed by an idempotency reference so each
-- dividend allocation maps to exactly one entitlement row per investor.

CREATE TABLE IF NOT EXISTS project_investor_payouts (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  allocation_id     INTEGER REFERENCES waterfall_allocation_records(id),
  investor_user_id  INTEGER NOT NULL REFERENCES users(id),
  entitlement       NUMERIC(19,2) NOT NULL CHECK (entitlement >= 0),
  payout_reference  VARCHAR(120) NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PAID')),
  paid_at           TIMESTAMPTZ,
  payout_setting_reference VARCHAR(120),          -- batch reference of the payout run
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_investor_payout_reference
  ON project_investor_payouts (payout_reference);
CREATE INDEX IF NOT EXISTS ix_project_payouts_project_status
  ON project_investor_payouts (project_id, status);
CREATE INDEX IF NOT EXISTS ix_project_payouts_investor
  ON project_investor_payouts (investor_user_id);