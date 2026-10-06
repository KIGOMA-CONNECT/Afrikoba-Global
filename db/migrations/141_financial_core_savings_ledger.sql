-- 141 | Phase 69 — Generic customer savings ledger account.
-- Required by recurrenceService.runAutoSavings().
-- Customer wallet funds are transferred to this liability account.
-- Idempotent: safe if the account already exists.

INSERT INTO ledger_accounts (
  account_code,
  name,
  account_type,
  currency_code,
  is_system
) VALUES (
  'SAVINGS_LEDGER',
  'Customer Savings Liability',
  'LIABILITY',
  'TZS',
  TRUE
)
ON CONFLICT (account_code) DO NOTHING;
