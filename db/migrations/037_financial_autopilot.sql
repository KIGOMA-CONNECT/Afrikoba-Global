-- ============================================================================
-- 037 FINANCIAL AUTOPILOT PLANS
-- A user's opted-in, automatically-executed savings objective driven by the
-- Financial Passport.
--
-- Governance & safety:
--   * The monthly allocation is SNAPSHOTTED at activation so the user can see
--     exactly what they opted into; it does not silently change every run.
--   * Autopilot SKIPS a run (never fails) if the wallet lacks funds or the
--     passport shows disposable capacity has dropped below the allocation.
--   * Every execution journals through financialEngine with a UNIQUE per-period
--     reference (AUTOPILOT:<plan>:<YYYYMM>) so retries can never double-move
--     money (idempotency guaranteed by the ledger).
-- ============================================================================

CREATE TABLE IF NOT EXISTS autopilot_plans (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id          INT REFERENCES savings_goals(id) ON DELETE CASCADE,
  target_amount    NUMERIC(15,2) NOT NULL,
  monthly_allocation NUMERIC(15,2) NOT NULL,
  frequency        VARCHAR(10) NOT NULL DEFAULT 'MONTHLY',
  status           VARCHAR(12) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE / PAUSED / COMPLETED
  last_executed_at TIMESTAMPTZ,
  total_saved      NUMERIC(15,2) NOT NULL DEFAULT 0,
  skip_count       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_due ON autopilot_plans(status, frequency, last_executed_at);