-- ============================================================================
-- 038 AFRIKOBA MARKETPLACE
-- Need -> discover -> compare -> finance -> purchase -> pay -> insure -> save
--                                                                 -> review
--
-- Ledger integration:
--   * New account code MARKETPLACE_ESCROW (LIABILITY) - buyer funds held during
--     "paid but not yet delivery-confirmed", settled to the seller on confirm
--     or refunded back to the buyer on cancel. All movements journal through
--     financialEngine (debitWallet -> escrow / creditWallet <- escrow), so the
--     double-entry ledger stays balanced.
--   * price_guide: AI/market-informed price bands per item so a buyer can
--     establish a fair market price even before sellers list anything.
-- ============================================================================

INSERT INTO ledger_accounts (account_code, name, account_type, is_system)
SELECT 'MARKETPLACE_ESCROW', 'Marketplace Escrow', 'LIABILITY', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE account_code='MARKETPLACE_ESCROW');

-- Listing / catalog (open marketplace; a seller is any verified user, optionally
-- backed by a business float).
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id            SERIAL PRIMARY KEY,
  reference     VARCHAR(40) NOT NULL UNIQUE,
  seller_user_id INT NOT NULL REFERENCES users(id),
  business_id   INT REFERENCES business_accounts(id) ON DELETE SET NULL,
  category      VARCHAR(40) NOT NULL,
  title         VARCHAR(140) NOT NULL,
  description   TEXT,
  unit_price    NUMERIC(15,2) NOT NULL CHECK (unit_price >= 0),
  currency_code VARCHAR(3) DEFAULT 'TZS',
  stock_quantity INT NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE / INACTIVE
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_listings_category ON marketplace_listings(category, status);
CREATE INDEX IF NOT EXISTS idx_mkt_listings_seller ON marketplace_listings(seller_user_id);

-- Purchase order. Escrow amount = total_amount while status=ESCROW_HELD.
CREATE TABLE IF NOT EXISTS marketplace_orders (
  id             SERIAL PRIMARY KEY,
  reference      VARCHAR(40) NOT NULL UNIQUE,
  buyer_user_id  INT NOT NULL REFERENCES users(id),
  seller_user_id INT NOT NULL REFERENCES users(id),
  listing_id     INT REFERENCES marketplace_listings(id),
  category       VARCHAR(40) NOT NULL,
  title          VARCHAR(140) NOT NULL,
  unit_price     NUMERIC(15,2) NOT NULL,
  quantity       INT NOT NULL CHECK (quantity > 0),
  total_amount   NUMERIC(15,2) NOT NULL CHECK (total_amount >= 0),
  status         VARCHAR(16) NOT NULL DEFAULT 'ESCROW_HELD', -- ESCROW_HELD / DELIVERED / CONFIRMED / CANCELLED / DISPUTED
  escrow_release_ref VARCHAR(40),
  escrow_released_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_orders_buyer ON marketplace_orders(buyer_user_id, status);
CREATE INDEX IF NOT EXISTS idx_mkt_orders_seller ON marketplace_orders(seller_user_id, status);

-- Reviews (one per confirmed order).
CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id            SERIAL PRIMARY KEY,
  order_id      INT NOT NULL UNIQUE REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  listing_id    INT REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  buyer_user_id INT NOT NULL REFERENCES users(id),
  rating        INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- AI/market-informed price guide keyed by category + normalized item.
CREATE TABLE IF NOT EXISTS marketplace_price_guide (
  id           SERIAL PRIMARY KEY,
  category     VARCHAR(40) NOT NULL,
  item_key     VARCHAR(80) NOT NULL,      -- normalized e.g. 'beans 1kg'
  min_price    NUMERIC(15,2) NOT NULL,
  avg_price    NUMERIC(15,2) NOT NULL,
  max_price    NUMERIC(15,2) NOT NULL,
  sample_count INT NOT NULL DEFAULT 0,
  source       VARCHAR(16) NOT NULL DEFAULT 'MARKET_DATA', -- MARKET_DATA / MERGED
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (category, item_key)
);

-- Starter market data: buyers get a price band immediately, even with 0 listings.
INSERT INTO marketplace_price_guide (category, item_key, min_price, avg_price, max_price, sample_count, source)
VALUES
  ('PRODUCE',   'maize 1kg',        1500, 1800, 2500,  12, 'MARKET_DATA'),
  ('PRODUCE',   'beans 1kg',        2500, 3000, 4000,  10, 'MARKET_DATA'),
  ('PRODUCE',   'rice 1kg',         2800, 3500, 4500,   9, 'MARKET_DATA'),
  ('PRODUCE',   'tomatoes 1kg',     2000, 2500, 3500,  15, 'MARKET_DATA'),
  ('PRODUCE',   'onions 1kg',       1500, 2000, 3000,  14, 'MARKET_DATA'),
  ('GOODS',     'wheelbarrow',    45000, 52000, 65000,   6, 'MARKET_DATA'),
  ('GOODS',     'jerrycan 20l',    8000, 10000, 15000,   5, 'MARKET_DATA'),
  ('GOODS',     'spade/shovel',   12000, 15000, 20000,   4, 'MARKET_DATA'),
  ('FARM_INPUT', 'fertilizer npk', 35000, 40000, 55000,  8, 'MARKET_DATA'),
  ('FARM_INPUT', 'maize seed 10kg', 18000, 22000, 30000, 7, 'MARKET_DATA'),
  ('ENERGY',    'solar lantern',   25000, 30000, 40000,   6, 'MARKET_DATA'),
  ('ENERGY',    'charcoal 1bag',    15000, 18000, 25000,   9, 'MARKET_DATA')
ON CONFLICT (category, item_key) DO NOTHING;