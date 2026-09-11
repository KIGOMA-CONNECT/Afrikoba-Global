-- ============================================================
-- SACCOS DIGITAL CORE - SAVINGS INTEREST ACCRUAL & POSTING
-- (increment 15)
-- Periodic (one cycle per calendar month) interest on member
-- savings, closing the savings<->credit economic loop.
--   - Rate source: saccos.config.savings.interestRatePercent
--     (ANNUAL %). Monthly interest =
--       ROUND(balance * rate_percent / (100 * 12), 2).
--   - prepareCycle (OWNER/BOARD) snapshots ACTIVE members with a
--     positive savings balance into PENDING awards
--     (basis_balance + interest recorded) on a period-unique
--     cycle; re-preparing the same month recomputes the awards.
--   - postCycle (OWNER/BOARD, idempotent) posts a balanced
--     journal DR SACCOS<id>_SAVINGS_INTEREST_EXPENSE (EXPENSE)
--     / CR SACCOS<id>_SAVINGS_LIABILITY (LIABILITY) totalling the
--     awards, credits each member's account + an 'INTEREST'
--     APPROVED movement, and flips the cycle POSTED.
-- Members read their own interest history; sums reconcile to the
-- liability exactly (total_interest = SUM of rounded awards).
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_savings_interest_cycles (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  period DATE NOT NULL,
  rate_percent NUMERIC(8,4) NOT NULL,
  total_interest NUMERIC(16,2) NOT NULL DEFAULT 0,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'POSTED')),
  posted_at TIMESTAMPTZ,
  posted_by INT REFERENCES users(id),
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (saccos_id, period)
);

CREATE TABLE IF NOT EXISTS saccos_savings_interest_awards (
  id SERIAL PRIMARY KEY,
  cycle_id INT NOT NULL REFERENCES saccos_savings_interest_cycles(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES saccos_savings_accounts(id) ON DELETE CASCADE,
  basis_balance NUMERIC(16,2) NOT NULL,
  interest NUMERIC(16,2) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'POSTED')),
  txn_reference VARCHAR(40),
  posted_at TIMESTAMPTZ,
  UNIQUE (cycle_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_saccos_savings_interest_cycles_saccos
  ON saccos_savings_interest_cycles (saccos_id, period);
CREATE INDEX IF NOT EXISTS idx_saccos_savings_interest_awards_cycle
  ON saccos_savings_interest_awards (cycle_id);

-- Allow INTEREST movements on the savings ledger (103 limited
-- movements to DEPOSIT/WITHDRAWAL). The column-level CHECK is
-- auto-named {table}_{column}_check by PostgreSQL.
ALTER TABLE IF EXISTS saccos_savings_movements
  DROP CONSTRAINT IF EXISTS saccos_savings_movements_type_check;
ALTER TABLE IF EXISTS saccos_savings_movements
  ADD CONSTRAINT saccos_savings_movements_type_check
  CHECK (type IN ('DEPOSIT', 'WITHDRAWAL', 'INTEREST'));