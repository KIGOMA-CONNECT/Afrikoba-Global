-- ============================================================
-- 089 MULTI-COUNTRY DEPLOYMENT & REGULATORY LICENSING
-- 1) supported_countries gains regulatory/compliance attributes
--    (calling code for MSISDN->country resolution, per-country
--    daily transfer limits, withholding tax rates, KYC document
--    type per regulator, license status/name, local support).
-- 2) user_daily_transfer_totals — per-country daily transfer
--    tracking to enforce regulator daily limits (UTC CURRENT_DATE,
--    matching the partition convention).
-- 3) GOVERNMENT_WHT ledger account for withheld tax postings.
-- All idempotent.
-- ============================================================

ALTER TABLE supported_countries
  ADD COLUMN IF NOT EXISTS calling_code VARCHAR(8) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS max_daily_transfer_limit NUMERIC(16,2),
  ADD COLUMN IF NOT EXISTS withholding_tax_rate NUMERIC(5,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kyc_doc_type_required VARCHAR(40) NOT NULL DEFAULT 'NATIONAL_ID',
  ADD COLUMN IF NOT EXISTS regulatory_license_status VARCHAR(20) NOT NULL DEFAULT 'SANDBOX',
  ADD COLUMN IF NOT EXISTS regulatory_license_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS local_support_phone VARCHAR(24),
  ADD COLUMN IF NOT EXISTS local_compliance_email VARCHAR(160);

ALTER TABLE supported_countries DROP CONSTRAINT IF EXISTS supported_countries_license_status_check;
ALTER TABLE supported_countries ADD CONSTRAINT supported_countries_license_status_check
  CHECK (regulatory_license_status IN ('SANDBOX','PENDING','LICENSED'));

-- Eliminate the empty calling-code trap (empty matches every dial string).
UPDATE supported_countries SET calling_code = '255' WHERE calling_code = '' AND code = 'TZ';

-- Regulatory posture per active corridor (idempotent).
UPDATE supported_countries SET
  calling_code = CASE code
    WHEN 'TZ' THEN '255' WHEN 'KE' THEN '254' WHEN 'UG' THEN '256' WHEN 'RW' THEN '250'
    WHEN 'BI' THEN '257' WHEN 'ZM' THEN '260' WHEN 'NG' THEN '234' WHEN 'GH' THEN '233'
    ELSE calling_code END,
  max_daily_transfer_limit = CASE code
    WHEN 'TZ' THEN 20000000 WHEN 'KE' THEN 10000000 WHEN 'UG' THEN 10000000 WHEN 'RW' THEN 5000000
    WHEN 'BI' THEN 5000000 WHEN 'ZM' THEN 5000000 WHEN 'NG' THEN 5000000 WHEN 'GH' THEN 5000000
    ELSE max_daily_transfer_limit END,
  withholding_tax_rate = CASE code
    WHEN 'TZ' THEN 0.10 WHEN 'KE' THEN 0.15 WHEN 'UG' THEN 0.15 WHEN 'RW' THEN 0.15
    WHEN 'BI' THEN 0.10 WHEN 'ZM' THEN 0.10 WHEN 'NG' THEN 0.10 WHEN 'GH' THEN 0.10
    ELSE withholding_tax_rate END,
  kyc_doc_type_required = CASE code
    WHEN 'TZ' THEN 'NIDA' WHEN 'KE' THEN 'NATIONAL_ID' WHEN 'UG' THEN 'NIN' WHEN 'RW' THEN 'NATIONAL_ID'
    WHEN 'BI' THEN 'NATIONAL_ID' WHEN 'ZM' THEN 'NRC' WHEN 'NG' THEN 'NIN' WHEN 'GH' THEN 'Ghana Card'
    ELSE kyc_doc_type_required END,
  regulatory_license_status = CASE code
    WHEN 'TZ' THEN 'LICENSED' WHEN 'ZM' THEN 'SANDBOX'
    ELSE 'PENDING' END,
  regulatory_license_name = CASE code
    WHEN 'TZ' THEN 'Bank of Tanzania' WHEN 'KE' THEN 'Central Bank of Kenya'
    WHEN 'UG' THEN 'Bank of Uganda' WHEN 'RW' THEN 'National Bank of Rwanda'
    WHEN 'BI' THEN 'Burundi Bank' WHEN 'ZM' THEN 'Bank of Zambia'
    WHEN 'NG' THEN 'Central Bank of Nigeria' WHEN 'GH' THEN 'Bank of Ghana'
    ELSE regulatory_license_name END,
  local_support_phone = CASE code
    WHEN 'TZ' THEN '+255712000001' WHEN 'KE' THEN '+254712345678' WHEN 'UG' THEN '+256712345678'
    WHEN 'RW' THEN '+250712345678' WHEN 'BI' THEN '+257712345678' WHEN 'ZM' THEN '+260712345678'
    WHEN 'NG' THEN '+234712345678' WHEN 'GH' THEN '+233712345678'
    ELSE local_support_phone END,
  local_compliance_email = CASE code
    WHEN 'TZ' THEN 'compliance@afrikoba.co.tz' WHEN 'KE' THEN 'compliance@afrikoba.co.ke'
    WHEN 'UG' THEN 'compliance@afrikoba.co.ug' WHEN 'RW' THEN 'compliance@afrikoba.co.rw'
    WHEN 'BI' THEN 'compliance@afrikoba.co.bi' WHEN 'ZM' THEN 'compliance@afrikoba.co.zm'
    WHEN 'NG' THEN 'compliance@afrikoba.co.ng' WHEN 'GH' THEN 'compliance@afrikoba.co.gh'
    ELSE local_compliance_email END
WHERE code IN ('TZ','KE','UG','RW','BI','ZM','NG','GH');

-- Per-country daily transfer totals (enforces regulator daily caps).
CREATE TABLE IF NOT EXISTS user_daily_transfer_totals (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_code VARCHAR(2) NOT NULL REFERENCES supported_countries(code) ON DELETE CASCADE,
  txn_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, country_code, txn_date)
);

CREATE INDEX IF NOT EXISTS idx_udtt_user_date ON user_daily_transfer_totals(user_id, txn_date);

-- Withholding-tax payable ledger account (credit side of tax postings).
INSERT INTO ledger_accounts (account_code, name, account_type) VALUES
  ('GOVERNMENT_WHT', 'Government Withholding Tax Payable', 'LIABILITY'),
  ('REMITTANCE_CLEARING', 'Remittance Clearing Account', 'ASSET')
ON CONFLICT (account_code) DO NOTHING;