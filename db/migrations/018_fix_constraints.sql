-- Fix constraints for new network features

-- 1) Extend transactions.type CHECK to include agent/bulk/remittance types
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'DEPOSIT','WITHDRAWAL','TRANSFER',
    'ROSCA_CONTRIBUTION','ROSCA_PAYOUT','ROSCA_LOCK',
    'INVESTMENT','INVESTMENT_PAYOUT',
    'VICOBA_SHARE','VICOBA_LOAN','VICOBA_MAINTENANCE_FEE','VICOBA_PENALTY',
    'VICOBA_SOCIAL_FUND','VICOBA_SOCIAL_FUND_DISBURSEMENT',
    'VICOBA_LOAN_REPAYMENT','VICOBA_PROFIT_PAYOUT',
    'CASH_IN','CASH_OUT','BULK_PAYMENT','REMITTANCE',
    'CASHBACK','SUBSCRIPTION','FEE','REFERRAL_REWARD'
  ]::text[]));

-- 2) Relax scheduled_payments NOT NULLs (new columns scheduled_for/recurrence are used instead)
ALTER TABLE scheduled_payments ALTER COLUMN frequency DROP NOT NULL;
ALTER TABLE scheduled_payments ALTER COLUMN next_execution DROP NOT NULL;
