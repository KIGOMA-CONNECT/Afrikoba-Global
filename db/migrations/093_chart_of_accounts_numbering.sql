-- ============================================================
-- 093 CHART OF ACCOUNTS FORMAL NUMBERING (1000/2000/3000/4000/5000)
-- Mirrors the blueprint's formal account-numbering hierarchy onto the
-- existing ledger_accounts (which until now used only named codes like
-- CUSTOMER_WALLET, MNO_CLEARING ...). Every live account code gains a
-- standardised 4-digit chart number:
--   1000-1999 ASSETS
--   2000-2999 LIABILITIES
--   3000-3999 EQUITY
--   4000-4999 REVENUE / INCOME
--   5000-5999 EXPENSES
-- Numbering is stable (additive) so existing journal postings referencing
-- account_id are unaffected; chart_number is purely a classification
-- mirror used by Ops reporting and cross-platform reconciliation.
-- ============================================================

ALTER TABLE ledger_accounts
  ADD COLUMN IF NOT EXISTS chart_number INT;

-- Assign formal chart numbers per current account code, keyed on account_type.
DO $$
DECLARE a RECORD;
BEGIN
  FOR a IN
    SELECT account_code, account_type FROM ledger_accounts
  LOOP
    CASE a.account_type
      WHEN 'ASSET' THEN
        UPDATE ledger_accounts SET chart_number = (
          CASE a.account_code
            WHEN 'MNO_CLEARING'            THEN 1010
            WHEN 'MARKETPLACE_FINANCING'   THEN 1110
            WHEN 'PROJECT_REVENUE_RECEIVABLE' THEN 1120
            WHEN 'REMITTANCE_CLEARING'     THEN 1210
            WHEN 'TREASURY'                THEN 1310
            ELSE NULL
          END
        ) WHERE account_code = a.account_code;
      WHEN 'LIABILITY' THEN
        UPDATE ledger_accounts SET chart_number = (
          CASE a.account_code
            WHEN 'CUSTOMER_WALLET'  THEN 2010
            WHEN 'CARD_HOLD'        THEN 2110
            WHEN 'FAMILY_WALLET'    THEN 2120
            WHEN 'VICOBA_GROUP'     THEN 2210
            WHEN 'ROSICA_POOL'      THEN 2220
            WHEN 'AGENT_BALANCE'    THEN 2230
            WHEN 'PARTNER_BALANCE'  THEN 2240
            WHEN 'YIELD_LIABILITY'  THEN 2310
            WHEN 'BUSINESS_WALLET'  THEN 2320
            WHEN 'MARKETPLACE_ESCROW' THEN 2410
            WHEN 'PROJECT_FUND'     THEN 2420
            WHEN 'EVENT_POOL'       THEN 2430
            WHEN 'EVENT_SAVINGS'    THEN 2440
            WHEN 'MERCHANT_BALANCE' THEN 2510
            WHEN 'SUSPENSE'         THEN 2610
            WHEN 'GOVERNMENT_WHT'   THEN 2710
            ELSE NULL
          END
        ) WHERE account_code = a.account_code;
      WHEN 'REVENUE' THEN
        UPDATE ledger_accounts SET chart_number = (
          CASE a.account_code
            WHEN 'PLATFORM_FEES'    THEN 4010
            WHEN 'COMMISSION'       THEN 4020
            WHEN 'INTEREST_INCOME'  THEN 4110
            WHEN 'FINANCE_INCOME'   THEN 4120
            ELSE NULL
          END
        ) WHERE account_code = a.account_code;
      WHEN 'EXPENSE' THEN
        UPDATE ledger_accounts SET chart_number = (
          CASE a.account_code
            WHEN 'REFERRAL_REWARD'  THEN 5110
            ELSE NULL
          END
        ) WHERE account_code = a.account_code;
      ELSE NULL;
    END CASE;
  END LOOP;
END $$;

-- Guard: every chart number must sit in the range implied by its account type.
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS chk_ledger_chart_range;
ALTER TABLE ledger_accounts ADD CONSTRAINT chk_ledger_chart_range CHECK (
  (account_type = 'ASSET'      AND (chart_number IS NULL OR (chart_number >= 1000 AND chart_number < 2000)))
  OR (account_type = 'LIABILITY' AND (chart_number IS NULL OR (chart_number >= 2000 AND chart_number < 3000)))
  OR (account_type = 'EQUITY'   AND (chart_number IS NULL OR (chart_number >= 3000 AND chart_number < 4000)))
  OR (account_type = 'REVENUE'  AND (chart_number IS NULL OR (chart_number >= 4000 AND chart_number < 5000)))
  OR (account_type = 'EXPENSE'  AND (chart_number IS NULL OR (chart_number >= 5000 AND chart_number < 6000)))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ledger_chart_number
  ON ledger_accounts(chart_number) WHERE chart_number IS NOT NULL;
