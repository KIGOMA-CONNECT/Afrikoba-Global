-- Migration 153: Social Fund clearing account provisioning and product attribution
-- GSF-FIN-03: Seed SOCIAL_FUND_CLEARING ledger account
-- GSF-FIN-04: Add SOCIAL_FUND to product namespace function

-- 1. Seed the SOCIAL_FUND_CLEARING account if missing
INSERT INTO ledger_accounts (account_code, name, account_type, currency_code)
SELECT 'SOCIAL_FUND_CLEARING', 'Social Fund Clearing', 'LIABILITY', 'TZS'
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE account_code = 'SOCIAL_FUND_CLEARING');

-- 2. Add SOCIAL_FUND to fn_product_namespace (counterparty account mapping)
CREATE OR REPLACE FUNCTION fn_product_namespace(p_code TEXT)
RETURNS VARCHAR(40) AS $$
  SELECT CASE
    WHEN p_code IS NULL THEN NULL
    WHEN p_code = 'VICOBA_GROUP'          OR p_code LIKE 'VICOBA%'     THEN 'VICOBA'
    WHEN p_code = 'ROSICA_POOL'           OR p_code LIKE 'ROSCA%'      THEN 'ROSCA'
    WHEN p_code LIKE 'SACCOS%'                                         THEN 'SACCOS'
    WHEN p_code LIKE 'MARKETPLACE%'                                     THEN 'MARKETPLACE'
    WHEN p_code = 'FAMILY_WALLET'         OR p_code LIKE 'FAMILY%'     THEN 'FAMILY'
    WHEN p_code LIKE 'EVENT_%'                                         THEN 'EVENTS'
    WHEN p_code LIKE 'LENDING_CIRCLE%'    OR p_code LIKE 'CIRCLE%'
         OR p_code LIKE 'CROWD%'                                      THEN 'LENDING_CIRCLES'
    WHEN p_code LIKE 'PROJECT_ACCOUNT%'                                THEN 'PROJECTS'
    WHEN p_code LIKE 'TREASURY%'                                       THEN 'TREASURY'
    WHEN p_code = 'SOCIAL_FUND_CLEARING'  OR p_code LIKE 'SOCIAL_FUND%' THEN 'SOCIAL_FUND'
    ELSE 'WALLET'
  END;
$$ LANGUAGE sql IMMUTABLE;

-- 3. Add SOCIAL_FUND to fn_product_from_tx_type
CREATE OR REPLACE FUNCTION fn_product_from_tx_type(p_type TEXT)
RETURNS VARCHAR(40) AS $$
  SELECT CASE
    WHEN p_type IS NULL THEN NULL
    WHEN p_type LIKE 'VICOBA\_%'    THEN 'VICOBA'
    WHEN p_type LIKE 'ROSCA\_%'     THEN 'ROSCA'
    WHEN p_type LIKE 'SACCOS\_%'    THEN 'SACCOS'
    WHEN p_type LIKE 'MARKETPLACE\_%' THEN 'MARKETPLACE'
    WHEN p_type LIKE 'FAMILY\_%'    THEN 'FAMILY'
    WHEN p_type LIKE 'EVENT\_%'     THEN 'EVENTS'
    WHEN p_type LIKE 'LENDING\_%' OR p_type LIKE 'CIRCLE\_%' OR p_type LIKE 'CROWD\_%' THEN 'LENDING_CIRCLES'
    WHEN p_type LIKE 'PROJECT\_%'   THEN 'PROJECTS'
    WHEN p_type LIKE 'SOCIAL_FUND\_%' THEN 'SOCIAL_FUND'
    ELSE 'WALLET'
  END;
$$ LANGUAGE sql IMMUTABLE;