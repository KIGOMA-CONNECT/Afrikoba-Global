-- 137 | Phase 13 — Scheduled drawdown plan: tranche cash management.
-- A commitment layer on top of the existing two-phase disbursement chain.
-- The plan defines up-front tranches (amount, milestone, purpose); requesting a
-- tranche materialises a governed disbursement REQUEST (segregation of duties
-- preserved: owner requests, expert reviews/approves, treasury executes). No
-- money moves in this migration; release reuses project_disbursements.

CREATE TABLE IF NOT EXISTS project_drawdown_plans (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
  currency     VARCHAR(3) NOT NULL DEFAULT 'TZS',
  status       VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE','COMPLETED')),
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id)
);

CREATE TABLE IF NOT EXISTS project_drawdowns (
  id                     SERIAL PRIMARY KEY,
  project_id             INTEGER NOT NULL REFERENCES projects(id),
  plan_id                INTEGER NOT NULL REFERENCES project_drawdown_plans(id),
  sequence               INTEGER NOT NULL,
  amount                 NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  milestone_id           INTEGER REFERENCES project_milestones(id),
  purpose                TEXT,
  status                 VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED'
                         CHECK (status IN ('SCHEDULED','REQUESTED','RELEASED','SKIPPED')),
  disbursement_reference VARCHAR(64),                  -- link to project_disbursements.unique_reference
  requested_by           INTEGER REFERENCES users(id),
  requested_at           TIMESTAMPTZ,
  released_at            TIMESTAMPTZ,
  created_by             INTEGER REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, sequence)
);

CREATE INDEX IF NOT EXISTS ix_project_drawdowns_project
  ON project_drawdowns (project_id, sequence);