-- ============================================================
-- I18N + MULTI-COUNTRY + UNIFIED FX LEDGER
-- 1) users.country_code (carrier-country derived from E.164 dial)
-- 2) transactions.fx_rate + fx_base_currency (multi-currency audit)
-- 3) transactions.type CHECK expanded (CURRENCY_CONVERT / CURRENCY_TOPUP)
-- 4) unify FX stores: seed EUR/GBP/RWF into currencies + exchange_rates
--    (rates sourced from the pre-existing fx_rates store), so conversion
--    always uses ONE table (exchange_rates) via the app's FX service.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) DEFAULT 'TZ';

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(15,6);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fx_base_currency VARCHAR(3) DEFAULT 'TZS';

-- Extend transactions.type CHECK (Postgres: re-create constraint) — idempotent
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'DEPOSIT', 'WITHDRAWAL', 'TRANSFER',
  'ROSCA_CONTRIBUTION', 'ROSCA_PAYOUT', 'ROSCA_LOCK',
  'INVESTMENT', 'INVESTMENT_PAYOUT',
  'VICOBA_SHARE', 'VICOBA_LOAN', 'VICOBA_MAINTENANCE_FEE',
  'VICOBA_PENALTY', 'VICOBA_SOCIAL_FUND', 'VICOBA_SOCIAL_FUND_DISBURSEMENT',
  'VICOBA_LOAN_REPAYMENT', 'VICOBA_PROFIT_PAYOUT',
  'CASH_IN', 'CASH_OUT', 'BULK_PAYMENT', 'REMITTANCE', 'CASHBACK',
  'SUBSCRIPTION', 'FEE', 'REFERRAL_REWARD',
  'SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL',
  'FIXED_DEPOSIT', 'FIXED_DEPOSIT_INTEREST', 'FIXED_DEPOSIT_PENALTY',
  'LOAN_CREDIT', 'LOAN_REPAYMENT', 'LOAN_GUARANTEE', 'LOAN_GUARANTEE_RELEASE',
  'PARTNER_PAYOUT',
  'CURRENCY_CONVERT', 'CURRENCY_TOPUP'
));

-- Add EUR / GBP / RWF (present in fx_rates but missing from currencies/exchange_rates)
INSERT INTO currencies (code, name, symbol, decimals) VALUES
  ('EUR', 'Euro', '€', 2),
  ('GBP', 'British Pound', '£', 2),
  ('RWF', 'Rwandan Franc', 'R₣', 0)
ON CONFLICT (code) DO NOTHING;

-- Unify: seed exchange_rates entries for EUR/GBP/RWF relative to TZS
INSERT INTO exchange_rates (from_currency, to_currency, rate, source) VALUES
  ('TZS', 'EUR', 0.000357, 'MIGRATE'),
  ('EUR', 'TZS', 2800.0,   'MIGRATE'),
  ('TZS', 'GBP', 0.0003125,'MIGRATE'),
  ('GBP', 'TZS', 3200.0,   'MIGRATE'),
  ('TZS', 'RWF', 0.47619,  'MIGRATE'),
  ('RWF', 'TZS', 2.1,      'MIGRATE')
ON CONFLICT (from_currency, to_currency, valid_from) DO NOTHING;