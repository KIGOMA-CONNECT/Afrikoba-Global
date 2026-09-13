-- ============================================================================
-- 126 PRODUCT ISOLATION
--
-- Namespace every ledger record by product so that money belonging to
-- VICOBA, Lending Circles, ROSCA, SACCO, Marketplace, Family Finance and the
-- core Wallet can never be mixed in queries, reports or reconciliation.
--
-- Design principles (additive only, does not change existing behaviour):
--   * product_type  -> coarse namespace derived from the counterparty account
--                      (journal_entries) / type string (transactions) /
--                      reference prefix (wallet_ledger).
--   * product_ref   -> fine-grained entity id when meaningful (e.g. group_id,
--                      pool_id, order_id, wallet_id). Populated by services
--                      via financialEngine; NULL-tolerant everywhere else.
--   * NOT NULL is NOT enforced on purpose: reverse/legacy/suspense flows that
--     cannot be attributed fall back to 'WALLET' namespace rather than being
--     dropped or failing inserts. Isolation queries use explicit product_type
--     filters so unattributed rows surface -- never silently merge.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Columns (additive)
-- ----------------------------------------------------------------------------
ALTER TABLE transactions        ADD COLUMN IF NOT EXISTS product_type VARCHAR(40);
ALTER TABLE transactions        ADD COLUMN IF NOT EXISTS product_ref   VARCHAR(64);
ALTER TABLE journal_entries     ADD COLUMN IF NOT EXISTS product_type VARCHAR(40);
ALTER TABLE journal_entries     ADD COLUMN IF NOT EXISTS product_ref   VARCHAR(64);
ALTER TABLE wallet_ledger       ADD COLUMN IF NOT EXISTS product_type VARCHAR(40);
ALTER TABLE wallet_ledger       ADD COLUMN IF NOT EXISTS product_ref   VARCHAR(64);

-- ----------------------------------------------------------------------------
-- 2. Canonical product namespace
-- ----------------------------------------------------------------------------
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
    ELSE 'WALLET'
  END;
$$ LANGUAGE sql IMMUTABLE;

-- product namespace from a transactions.type string
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
    WHEN p_type LIKE 'INVESTMENT%'  THEN 'INVESTMENTS'
    ELSE 'WALLET'
  END;
$$ LANGUAGE sql IMMUTABLE;

-- product namespace from a reference_id prefix (wallet_ledger legacy rows)
CREATE OR REPLACE FUNCTION fn_product_from_ref(p_ref TEXT)
RETURNS VARCHAR(40) AS $$
  DECLARE l TEXT;
  BEGIN
    l := lower(p_ref);
    RETURN CASE
      WHEN l IS NULL THEN NULL
      WHEN l LIKE 'vc%' OR l LIKE 'mk:%' OR l LIKE '%:wg%' OR l LIKE '%:gw%' OR l LIKE '%:ws%' OR l LIKE '%:vs%' THEN 'VICOBA'
      WHEN l LIKE 'rl%' OR l LIKE 'rp%' OR l LIKE '%:po%' OR l LIKE '%:lk%' THEN 'ROSCA'
      WHEN l LIKE 'saccos%' OR l LIKE 'wlf%' OR l LIKE 'sav%' OR l LIKE 'acc-%' OR l LIKE 'lns%' OR l LIKE 'rep-%' THEN 'SACCOS'
      WHEN l LIKE 'mkt%' OR l LIKE 'mktord%' OR l LIKE 'mktfin%' THEN 'MARKETPLACE'
      WHEN l LIKE 'fc%' OR l LIKE 'ft%' OR l LIKE 'ct%' OR l LIKE 'ru%' THEN 'FAMILY'
      WHEN l LIKE 'cf%' OR l LIKE 'cfd%' OR l LIKE 'cc%' THEN 'LENDING_CIRCLES'
      WHEN l LIKE 'evt%' OR l LIKE 'ev-%' THEN 'EVENTS'
      WHEN l LIKE 'prj%' OR l LIKE 'proj%' THEN 'PROJECTS'
      ELSE 'WALLET'
    END;
  END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ----------------------------------------------------------------------------
-- 3. Backfill existing rows
-- ----------------------------------------------------------------------------
-- journal_entries: namespace from the counterparty ledger account
UPDATE journal_entries je
   SET product_type = fn_product_namespace(la.account_code)
  FROM ledger_accounts la
 WHERE la.id = je.account_id
   AND je.product_type IS NULL;

-- transactions: namespace from the type string
UPDATE transactions
   SET product_type = fn_product_from_tx_type(type)
 WHERE product_type IS NULL;

-- wallet_ledger: namespace from the linked transaction, else reference prefix
UPDATE wallet_ledger wl
   SET product_type = COALESCE(
         (SELECT t.product_type FROM transactions t WHERE t.id = wl.transaction_id),
         fn_product_from_ref(wl.reference_id)
       )
 WHERE wl.product_type IS NULL;

-- ----------------------------------------------------------------------------
-- 4. Auto-attribution triggers (defensive: attribute when a caller omits it)
--    product_type is never overwritten if already set; product_ref left to
--    services that know the entity id.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_attr_journal_product() RETURNS TRIGGER AS $$
  DECLARE acct VARCHAR(40);
  BEGIN
    IF NEW.product_type IS NULL THEN
      SELECT account_code INTO acct FROM ledger_accounts WHERE id = NEW.account_id;
      NEW.product_type := fn_product_namespace(acct);
    END IF;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_attr_journal_product ON journal_entries;
CREATE TRIGGER trg_attr_journal_product
  BEFORE INSERT OR UPDATE OF product_type ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_attr_journal_product();

CREATE OR REPLACE FUNCTION fn_attr_tx_product() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.product_type IS NULL THEN
      NEW.product_type := fn_product_from_tx_type(NEW.type);
    END IF;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_attr_tx_product ON transactions;
CREATE TRIGGER trg_attr_tx_product
  BEFORE INSERT OR UPDATE OF product_type ON transactions
  FOR EACH ROW EXECUTE FUNCTION fn_attr_tx_product();

CREATE OR REPLACE FUNCTION fn_attr_wallet_ledger_product() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.product_type IS NULL THEN
      IF NEW.transaction_id IS NOT NULL THEN
        SELECT t.product_type INTO NEW.product_type
          FROM transactions t WHERE t.id = NEW.transaction_id LIMIT 1;
      END IF;
      IF NEW.product_type IS NULL THEN
        NEW.product_type := fn_product_from_ref(NEW.reference_id);
      END IF;
    END IF;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_attr_wallet_ledger_product ON wallet_ledger;
CREATE TRIGGER trg_attr_wallet_ledger_product
  BEFORE INSERT OR UPDATE OF product_type ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION fn_attr_wallet_ledger_product();

-- ----------------------------------------------------------------------------
-- 5. Indexes for per-product queries / reconciliation
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_journal_entries_product;
CREATE INDEX idx_journal_entries_product
  ON journal_entries (product_type, posted_at DESC)
  WHERE product_type IS NOT NULL;

DROP INDEX IF EXISTS idx_journal_entries_product_ref;
CREATE INDEX idx_journal_entries_product_ref
  ON journal_entries (product_type, product_ref, posted_at DESC)
  WHERE product_type IS NOT NULL;

DROP INDEX IF EXISTS idx_transactions_product;
CREATE INDEX idx_transactions_product
  ON transactions (product_type)
  WHERE product_type IS NOT NULL;

DROP INDEX IF EXISTS idx_wallet_ledger_product;
CREATE INDEX idx_wallet_ledger_product
  ON wallet_ledger (product_type)
  WHERE product_type IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 6. Per-product ledger summary (net flow + open volume per namespace)
--    filtrable by product_type. The CUSTOMER_WALLET leg is excluded from the
--    per-product gross so the numbers reflect each product's own books
--    (e.g. VICOBA net = funds held in VICOBA_GROUP accounts).
--    Suspense/CLEARING are aggregated under the respective namespace when the
--    account is product-scoped (e.g. VICOBA_GROUP), otherwise 'WALLET'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_product_ledger_summary AS
SELECT
  je.product_type,
  COALESCE(SUM(CASE WHEN je.direction = 'DR' THEN je.amount ELSE 0 END), 0) AS total_dr,
  COALESCE(SUM(CASE WHEN je.direction = 'CR' THEN je.amount ELSE 0 END), 0) AS total_cr,
  COUNT(*)::BIGINT AS entry_rows,
  COALESCE(SUM(CASE WHEN je.direction = 'CR' THEN je.amount ELSE -je.amount END), 0) AS net_balance
FROM journal_entries je
JOIN ledger_accounts la ON la.id = je.account_id
WHERE je.product_type IS NOT NULL
  AND la.account_code <> 'CUSTOMER_WALLET'
GROUP BY je.product_type
ORDER BY je.product_type;