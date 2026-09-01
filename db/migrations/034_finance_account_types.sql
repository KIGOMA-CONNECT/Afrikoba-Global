-- 034: Account type corrections for financial engine semantics.
-- SUSPENSE is an internal settlement account that holds customer funds set
-- aside (savings pots, escrow, refunds, disbursements). Under the engine's
-- two-leg journal convention (DR source / CR target) it behaves as a
-- LIABILITY: funds moving in CR it (liability up), funds moving out DR it
-- (liability down). Re-type from ASSET so balances move with correct sign.

UPDATE ledger_accounts
   SET account_type = 'LIABILITY'
 WHERE account_code = 'SUSPENSE'
   AND account_type <> 'LIABILITY';