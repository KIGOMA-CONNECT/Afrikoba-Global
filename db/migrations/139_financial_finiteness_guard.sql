-- 139 | Phase 68 — reject non-finite and out-of-range monetary values.
-- NUMERIC(15,2) maximum: 9999999999999.99
-- NUMERIC(19,4) maximum: 999999999999999.9999
-- NOT VALID skips validation of legacy rows but enforces checks on
-- inserts and updates. Legacy NULL wallet balances may need remediation
-- before their rows can be updated.
DO $$
BEGIN
  ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_wallet_balance_check;
  ALTER TABLE users
    ADD CONSTRAINT users_wallet_balance_check
    CHECK (
      wallet_balance IS NULL
      OR wallet_balance BETWEEN 0 AND 9999999999999.99
    ) NOT VALID;

  ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_locked_balance_check;
  ALTER TABLE users
    ADD CONSTRAINT users_locked_balance_check
    CHECK (
      locked_balance IS NULL
      OR locked_balance BETWEEN 0 AND 9999999999999.99
    ) NOT VALID;

  -- Replace either known legacy name before adding the bounded constraint.
  ALTER TABLE journal_entries
    DROP CONSTRAINT IF EXISTS journal_entries_amount_check;
  ALTER TABLE journal_entries
    DROP CONSTRAINT IF EXISTS journal_entries_amount_check1;
  ALTER TABLE journal_entries
    ADD CONSTRAINT journal_entries_amount_check1
    CHECK (amount BETWEEN 0 AND 999999999999999.9999) NOT VALID;

  ALTER TABLE financial_operations
    DROP CONSTRAINT IF EXISTS financial_operations_amount_check;
  ALTER TABLE financial_operations
    ADD CONSTRAINT financial_operations_amount_check
    CHECK (amount BETWEEN 0 AND 999999999999999.9999) NOT VALID;

  ALTER TABLE financial_audit_log
    DROP CONSTRAINT IF EXISTS financial_audit_log_amount_check;
  ALTER TABLE financial_audit_log
    ADD CONSTRAINT financial_audit_log_amount_check
    CHECK (amount BETWEEN 0 AND 999999999999999.9999) NOT VALID;

  ALTER TABLE financial_audit_log
    DROP CONSTRAINT IF EXISTS financial_audit_log_before_check;
  ALTER TABLE financial_audit_log
    ADD CONSTRAINT financial_audit_log_before_check
    CHECK (
      balance_before IS NULL
      OR balance_before BETWEEN 0 AND 999999999999999.9999
    ) NOT VALID;

  ALTER TABLE financial_audit_log
    DROP CONSTRAINT IF EXISTS financial_audit_log_after_check;
  ALTER TABLE financial_audit_log
    ADD CONSTRAINT financial_audit_log_after_check
    CHECK (
      balance_after IS NULL
      OR balance_after BETWEEN 0 AND 999999999999999.9999
    ) NOT VALID;
END $$;
