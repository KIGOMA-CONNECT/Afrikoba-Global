-- 035: Phase 10 ledger coverage — business float liability account.
-- business_accounts.balance is a spendable float the platform holds for each
-- business. Under the engine's two-leg convention (DR source / CR target) it
-- behaves as a LIABILITY: customer money moving into a business CR it, float
-- leaving (withdraw, payroll, supplier, loan repay) DRs it.

INSERT INTO ledger_accounts (account_code, name, account_type) VALUES
  ('BUSINESS_WALLET', 'Business Float Liability', 'LIABILITY')
ON CONFLICT (account_code) DO NOTHING;