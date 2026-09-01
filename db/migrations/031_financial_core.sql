-- ============================================================================
-- 031 FINANCIAL CORE v1.0
-- Double-entry ledger, official accounts, idempotency hardening, and
-- transaction state-machine expansion for AFRIKOBA.
--
-- Goal: move from "feature -> direct UPDATE balance" toward
--       "transaction -> immutable journal -> balance projection".
--
-- This migration is backward-compatible: existing wallet_ledger / users
-- balances remain the user-facing projection. The journal_entries table
-- becomes the authoritative accounting record going forward.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. LEDGER ACCOUNTS (Chart of Accounts)
-- Tracks every distinct money store in the system so double-entry postings
-- have explicit, typed accounts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id            SERIAL PRIMARY KEY,
  account_code  VARCHAR(40) UNIQUE NOT NULL,
  name          VARCHAR(120) NOT NULL,
  account_type  VARCHAR(20) NOT NULL CHECK (
                    account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')
                ),
  parent_id     INTEGER REFERENCES ledger_accounts(id),
  currency_code VARCHAR(3)  DEFAULT 'TZS',
  is_system     BOOLEAN     DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the core chart of accounts.
INSERT INTO ledger_accounts (account_code, name, account_type) VALUES
  ('CUSTOMER_WALLET',   'Customer Wallet Liability',      'LIABILITY'),
  ('MNO_CLEARING',      'Mobile Money Clearing Account',  'ASSET'),
  ('PLATFORM_FEES',     'Platform Fee Revenue',           'REVENUE'),
  ('COMMISSION',        'Commission Revenue',             'REVENUE'),
  ('SUSPENSE',          'Suspense / Unidentified Funds',  'ASSET'),
  ('CARD_HOLD',         'Card Authorization Holds',       'LIABILITY'),
  ('FAMILY_WALLET',     'Family Wallet Liability',        'LIABILITY'),
  ('VICOBA_GROUP',      'VICOBA Group Wallet Liability',  'LIABILITY'),
  ('ROSICA_POOL',       'ROSCA Pool Liability',           'LIABILITY'),
  ('AGENT_BALANCE',     'Agent Float Liability',          'LIABILITY'),
  ('PARTNER_BALANCE',   'Partner Balance Liability',      'LIABILITY'),
  ('REFERRAL_REWARD',   'Referral Reward Expense',        'EXPENSE'),
  ('YIELD_LIABILITY',   'Afrikoba Yield Liability',       'LIABILITY'),
  ('INTEREST_INCOME',   'Yield/Interest Income',          'REVENUE')
ON CONFLICT (account_code) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. JOURNAL ENTRIES (Double-Entry Ledger)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
  id               BIGSERIAL PRIMARY KEY,
  entry_group_id   VARCHAR(64) NOT NULL,          -- groups the DR/CR rows of one posting
  transaction_id   INTEGER REFERENCES transactions(id),
  account_id       INTEGER NOT NULL REFERENCES ledger_accounts(id),
  direction        VARCHAR(4) NOT NULL CHECK (direction IN ('DR','CR')),
  amount           NUMERIC(19,4) NOT NULL CHECK (amount >= 0),
  currency_code    VARCHAR(3) DEFAULT 'TZS',
  reference_id     VARCHAR(50),
  description      TEXT,
  posted_by        VARCHAR(40),                    -- who/what posted (e.g. system:cron)
  posted_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_group ON journal_entries(entry_group_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_tx    ON journal_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_acct  ON journal_entries(account_id, posted_at DESC);

-- Guarantee every entry_group is balanced (sum DR == sum CR) at the DB level.
-- Implemented as a DEFERRABLE CONSTRAINT TRIGGER so it validates at COMMIT time
-- (after all DR/CR rows of a group have been inserted) rather than after each
-- individual row, which would falsely reject the first DR row of a balanced pair.
CREATE OR REPLACE FUNCTION fn_assert_balanced_group()
RETURNS TRIGGER AS $$
DECLARE
  dr NUMERIC(19,4);
  cr NUMERIC(19,4);
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0),
         COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)
    INTO dr, cr
  FROM journal_entries
  WHERE entry_group_id = NEW.entry_group_id;
  IF dr <> cr THEN
    RAISE EXCEPTION 'BALANCED_LEDGER_VIOLATION: group % DR=% CR=%', NEW.entry_group_id, dr, cr;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_balanced ON journal_entries;
CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_assert_balanced_group();

-- ----------------------------------------------------------------------------
-- 3. HARDEN wallet_ledger idempotency (duplicate entry prevention)
-- The whole point of a ledger is one immutable effect per financial event.
-- ----------------------------------------------------------------------------
-- Remove any existing duplicates before adding the unique constraint.
DELETE FROM wallet_ledger a
USING wallet_ledger b
WHERE a.id < b.id
  AND COALESCE(a.reference_id,'') = COALESCE(b.reference_id,'')
  AND COALESCE(a.transaction_id,0) = COALESCE(b.transaction_id,0);

-- Only add the unique constraint if duplicates were the only problem and it
-- does not already exist. We create a unique index to also cover NULLs safely.
DROP INDEX IF EXISTS idx_wallet_ledger_unique_ref;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_unique_ref
  ON wallet_ledger (reference_id, COALESCE(transaction_id, 0));

-- ----------------------------------------------------------------------------
-- 4. EXPAND TRANSACTION STATE MACHINE
-- Current CHECK only allows PENDING/SUCCESS/FAILED. Real financial flows need
-- PROCESSING, CANCELLED, REVERSED and per-flow transitions.
-- ----------------------------------------------------------------------------
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (
  status IN ('PENDING','PROCESSING','SUCCESS','FAILED','CANCELLED','REVERSED')
);

-- Add columns used by the financial core.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS available_balance  NUMERIC(15,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS locked_balance     NUMERIC(15,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reversed_at        TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reversed_ref       VARCHAR(50);

-- ----------------------------------------------------------------------------
-- 5. FINANCIAL RECONCILIATION EXCEPTIONS
-- Every mismatch (dual, missing external, amount mismatch, stale) is recorded
-- here rather than silently resolved. The "reconciliation difference = 0"
-- goal requires these to be explicit.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id              BIGSERIAL PRIMARY KEY,
  exception_type  VARCHAR(40) NOT NULL,   -- DUAL_CREDIT, MISSING_EXTERNAL, AMOUNT_MISMATCH, STALE_WITHDRAWAL, ...
  reference_id    VARCHAR(50),
  transaction_id  INTEGER,
  status          VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','UNDER_INVESTIGATION','RESOLVED','IGNORED')),
  detail          JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     VARCHAR(80)
);

CREATE INDEX IF NOT EXISTS idx_recon_exceptions_status ON reconciliation_exceptions(status, created_at);

-- ----------------------------------------------------------------------------
-- 6. FINANCIAL INVARIANT CHECK (ad-hoc but stored)
-- A daily job can run these to assert the platform is balanced.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_financial_invariants()
RETURNS TABLE (check_name TEXT, ok BOOLEAN, note TEXT) AS $$
BEGIN
  -- Invariant: no negative available balances on customer wallets
  RETURN QUERY
    SELECT 'no_negative_wallets'::TEXT,
           NOT EXISTS (SELECT 1 FROM users WHERE wallet_balance < 0 OR locked_balance < 0),
           'users balances non-negative';

  -- Invariant: every balanced journal group (should always hold by trigger)
  RETURN QUERY
    SELECT 'journal_balanced'::TEXT,
           NOT EXISTS (
             SELECT entry_group_id FROM (
               SELECT entry_group_id,
                      COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0) dr,
                      COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0) cr
               FROM journal_entries GROUP BY entry_group_id
             ) g WHERE g.dr <> g.cr
           ),
           'all journal groups balanced';
END;
$$ LANGUAGE plpgsql;
