-- ============================================================
-- SACCOS DIGITAL CORE - ACCOUNTING (increment 6)
-- Entity-scoped bookkeeping + financial statements on top of the
-- shared ledger. OWNER/BOARD open an accounting period (PER-*),
-- book internal journals (ACC-*) through it via the double-entry
-- core (claim + postJournal), then close the period into an
-- immutable CLOSED state with a statements snapshot. Booking into
-- a closed period is rejected; CLOSED -> OPEN reopen is the only
-- escape (audit-logged). Statements (chart of accounts, trial
-- balance, income statement, balance sheet) are computed from
-- entity ledger accounts `SACCOS<id>_*` + their journal_entries
-- and are member/ADMIN readable with cross-entity 404.
-- Config (saccos.config.accounting):
--   {requirePeriodForBooking, defaultPeriodDays}
-- Suite 50.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_accounting_periods (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- PER-*
  label VARCHAR(200),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',   -- OPEN, CLOSED
  snapshot JSONB,                               -- statements snapshot at close
  opened_by INT NOT NULL REFERENCES users(id),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_by INT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_acc_period_end CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_saccos_acc_periods_saccos ON saccos_accounting_periods(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_accounting_entries (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  period_id INT REFERENCES saccos_accounting_periods(id) ON DELETE RESTRICT,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- ACC-*
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('EXPENSE','INCOME','MANUAL')),
  description TEXT,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  debit_account_code VARCHAR(64) NOT NULL,
  credit_account_code VARCHAR(64) NOT NULL,
  journal_group VARCHAR(64) NOT NULL,           -- financialEngine entry_group_id
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_acc_entries_saccos ON saccos_accounting_entries(saccos_id, period_id);