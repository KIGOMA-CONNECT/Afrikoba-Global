-- ============================================================
-- SACCOS DIGITAL CORE - DIVIDENDS (increment 8)
-- Surplus distribution closing the economic loop: the board
-- declares a dividend run (DIV-*) against a CLOSED accounting
-- period (the period is the authoritative source of surplus and
-- can only be used once); eligible shares = ACTIVE members'
-- saccos_share_holdings.share_count. Distribution pays each
-- holder pro-rata (amount = share_count * per_share) to their
-- CUSTOMER_WALLET through an entity-scoped EXPENSE journal on the
-- double-entry core:
--   DR `SACCOS<id>_DIVIDEND_DISTRIBUTED` (EXPENSE)
--   CR CUSTOMER_WALLET (per payout, idempotent on DIVP-*)
-- mirroring the redemption pattern (platform-balanced). A run can
-- be distributed once; re-running only pays still-PENDING payout
-- rows (PAID rows are skipped). Members see their own payouts;
-- cross-entity 404, member RBAC 403, ADMIN oversight, audit trail.
-- Suite 52.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_dividend_runs (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  period_id INT NOT NULL REFERENCES saccos_accounting_periods(id) ON DELETE RESTRICT,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- DIV-*
  title VARCHAR(200),
  per_share NUMERIC(15,2) NOT NULL CHECK (per_share > 0),
  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
  eligible_share_count INT NOT NULL CHECK (eligible_share_count > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'DECLARED', -- DECLARED, DISTRIBUTED
  declared_by INT NOT NULL REFERENCES users(id),
  declared_at TIMESTAMPTZ DEFAULT NOW(),
  distributed_by INT REFERENCES users(id),
  distributed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_div_runs_saccos ON saccos_dividend_runs(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_dividend_payouts (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  run_id INT NOT NULL REFERENCES saccos_dividend_runs(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  share_count INT NOT NULL CHECK (share_count > 0),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- DIVP-*
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, PAID
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (run_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_saccos_div_payouts_run ON saccos_dividend_payouts(run_id, status);