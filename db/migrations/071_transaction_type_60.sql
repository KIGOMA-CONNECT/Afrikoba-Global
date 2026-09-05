-- 071_transaction_type_60.sql
-- VICOBA_SOCIAL_FUND_DISBURSEMENT (31 chars) na aina nyingine za kisasa
-- hazikubaliki kwenye VARCHAR(30). Panaisha hadi 60.
ALTER TABLE transactions ALTER COLUMN type TYPE VARCHAR(60);