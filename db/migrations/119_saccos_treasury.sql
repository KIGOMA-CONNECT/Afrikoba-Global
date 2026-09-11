-- ============================================================
-- SACCOS DIGITAL CORE - TREASURY & LIQUIDITY PANEL (increment 20)
-- Governing risk view computed live from the shared double-entry
-- ledger (per-entity `SACCOS<id>_*` accounts) each time it is
-- read: cash/liquid buckets (operating cash + fund + welfare
-- kitty), loans receivable net of loan-loss reserves, member
-- deposits (savings / investments / funds / welfare), funding
-- ratio (gross loans / member deposits), LLR coverage and the
-- liquidity buffer ratio, with threshold-based alerts drawn
-- from `saccos.config.liquidity` (JSONB, OPT-IN).
--
-- `saccos_treasury_snapshots` is a dated immutable picture of a
-- computed position (TRS-*) so boards can keep a history for
-- audit/regulatory proof; keyed by (saccos_id, as_of) so a
-- re-run on the same day simply refreshes the row.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_treasury_snapshots (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  as_of DATE NOT NULL DEFAULT CURRENT_DATE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,
  snapshot JSONB NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (saccos_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_saccos_treasury_snapshots_org
  ON saccos_treasury_snapshots(saccos_id, as_of DESC);