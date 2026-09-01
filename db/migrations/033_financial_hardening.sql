-- ============================================================================
-- 033 FINANCIAL HARDENING
-- Idempotency registry, financial state machine (transaction-status guard),
-- and a dedicated financial audit trail.
--
-- 1. financial_operations  - every money operation, keyed by a UNIQUE
--                            reference_id (hard idempotency + attempt tracking)
-- 2. fn_guard_tx_transition - DB-enforced state machine on transactions:
--                            a transaction can never make an illegal transition
--                            (e.g. SUCCESS -> FAILED, or state out of a terminal)
-- 3. financial_audit_log   - immutable per-balance-mutation record (before/after)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. FINANCIAL OPERATIONS REGISTRY (Idempotency + State Machine)
-- Every financial operation is registered once per reference_id. Retrying the
-- same reference returns the existing row instead of re-executing, so a network
-- retry or duplicated webhook can never double-post.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_operations (
  id               BIGSERIAL PRIMARY KEY,
  operation_type   VARCHAR(30) NOT NULL,      -- DEPOSIT, WITHDRAWAL, TRANSFER, HOLD, RELEASE, CAPTURE, ...
  reference_id     VARCHAR(64) NOT NULL,      -- idempotency key (unique per op)
  transaction_id   INTEGER REFERENCES transactions(id),
  user_id          INTEGER REFERENCES users(id),
  amount           NUMERIC(19,4) NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'NEW',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_financial_operation_ref UNIQUE (reference_id)
);

CREATE INDEX IF NOT EXISTS idx_fin_op_type_status ON financial_operations(operation_type, status, created_at);
CREATE INDEX IF NOT EXISTS idx_fin_op_user      ON financial_operations(user_id);

-- ----------------------------------------------------------------------------
-- 2. FINANCIAL STATE MACHINE (transactions.status transitions)
-- Guards against illegal transitions at the DB, so application bugs cannot
-- move a settled transaction backwards or forward into a wrong state.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_guard_tx_transition()
RETURNS TRIGGER AS $$
DECLARE
  legal TEXT[];
BEGIN
  -- Rule table:
  --   PENDING    -> PROCESSING, SUCCESS, FAILED, CANCELLED, REVERSED
  --   PROCESSING -> SUCCESS, FAILED, CANCELLED, REVERSED
  --   SUCCESS, FAILED, CANCELLED, REVERSED are TERMINAL (cannot change)
  -- Re-writing the same status (retry) is allowed as a no-op.
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'PENDING' THEN
    legal := ARRAY['PROCESSING','SUCCESS','FAILED','CANCELLED','REVERSED'];
  ELSIF OLD.status = 'PROCESSING' THEN
    legal := ARRAY['SUCCESS','FAILED','CANCELLED','REVERSED'];
  ELSE
    -- Terminal states: no transitions allowed.
    RAISE EXCEPTION 'ILLEGAL_TRANSITION: % -> % (state is terminal)', OLD.status, NEW.status;
  END IF;

  IF NOT (NEW.status = ANY(legal)) THEN
    RAISE EXCEPTION 'ILLEGAL_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tx_transition ON transactions;
CREATE TRIGGER trg_tx_transition
  BEFORE UPDATE OF status ON transactions
  FOR EACH ROW EXECUTE FUNCTION fn_guard_tx_transition();

-- ----------------------------------------------------------------------------
-- 3. FINANCIAL AUDIT TRAIL
-- Immutable record of every projected-balance mutation. The journal_entries
-- table holds the double-entry truth; this log records the before/after of the
-- user/company projection so any drift can be diffed against the journal.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_audit_log (
  id             BIGSERIAL PRIMARY KEY,
  account_kind   VARCHAR(20) NOT NULL,   -- USER_BALANCE, USER_LOCKED, COMPANY_REVENUE, ...
  account_id     BIGINT,                 -- users.id / revenue row id / group id
  operation      VARCHAR(30) NOT NULL,   -- deposit, hold, release, capture, transfer_debit, transfer_credit
  amount         NUMERIC(19,4) NOT NULL,
  balance_before NUMERIC(19,4),
  balance_after  NUMERIC(19,4),
  reference_id   VARCHAR(64),
  actor          VARCHAR(60) DEFAULT 'engine',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fin_audit_account ON financial_audit_log(account_kind, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_audit_ref     ON financial_audit_log(reference_id);
