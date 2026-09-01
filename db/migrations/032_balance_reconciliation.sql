-- ============================================================================
-- 032 BALANCE RECONCILIATION ENGINE
-- Adds persistent storage for periodic financial reconciliation runs.
--
-- Every run compares the authoritative double-entry ledger (journal_entries)
-- against application-side projections (users.wallet_balance / locked_balance,
-- company_revenue, etc). Divergence between the two means a financial event
-- mutated a balance without going through the journal - exactly what this
-- program exists to surface.
-- ============================================================================

-- A reconciliation run ("as of midnight" or ad-hoc). Summary of the whole
-- comparison: did the aggregate book balance equal the aggregate projection?
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id             BIGSERIAL PRIMARY KEY,
  run_type       VARCHAR(30) NOT NULL DEFAULT 'DAILY',  -- DAILY, MANUAL
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  ws_start       TIMESTAMPTZ,   -- window start (as-of)
  ws_end         TIMESTAMPTZ,   -- window end
  status         VARCHAR(20) NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('RUNNING','COMPLETE','COMPLETE_WITH_DIFF','FAILED')),
  total_checked  INTEGER DEFAULT 0,
  total_matched  INTEGER DEFAULT 0,
  total_missing  INTEGER DEFAULT 0,
  total_diff     INTEGER DEFAULT 0,   -- amount mismatches
  difference     NUMERIC(19,4) DEFAULT 0   -- aggregate absolute diff
);

-- Each checked account/balance from a run: journal balance vs projected balance.
CREATE TABLE IF NOT EXISTS reconciliation_line_items (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  account_code     VARCHAR(40),        -- which ledger/account was checked
  balance_name     VARCHAR(120),       -- human label, e.g. "Sum user wallet_balance"
  state            VARCHAR(20) NOT NULL CHECK (state IN ('MATCHED','MISSING','AMOUNT_MISMATCH')),
  journal_balance  NUMERIC(19,4) DEFAULT 0,  -- authoritative: from journal_entries
  expected_balance NUMERIC(19,4) DEFAULT 0,  -- projection: from app tables
  difference       NUMERIC(19,4) DEFAULT 0,
  detail           JSONB
);

CREATE INDEX IF NOT EXISTS idx_recon_runs_started ON reconciliation_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_line_run  ON reconciliation_line_items(run_id);
