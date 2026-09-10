-- ============================================================
-- SACCOS DIGITAL CORE - SHARES (increment 2)
-- Share subscription / holdings ledgered on the shared
-- double-entry core: DR member wallet (CUSTOMER_WALLET) /
-- CR per-SACCOS EQUITY account (SACCOS<id>_SHARES_CAPITAL).
-- Auto-approved or approval-gated via saccos.config shareStructure
-- {shareValue, minShares, maxShares, autoApprove}. Rejected
-- purchases are refunded via engine creditWallet on a fresh
-- reference (DR equity / CR wallet).
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_share_purchases (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- SCS-* (canonical money ref, journal + financial_operations)
  shares INT NOT NULL CHECK (shares > 0),
  share_price NUMERIC(15,2) NOT NULL,
  total_amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  decided_by INT REFERENCES users(id),
  decision_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_share_purchases_saccos ON saccos_share_purchases(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_share_holdings (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL UNIQUE REFERENCES saccos_members(id) ON DELETE CASCADE,
  share_count INT NOT NULL DEFAULT 0 CHECK (share_count >= 0),
  total_value NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  avg_price NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_share_holdings_saccos ON saccos_share_holdings(saccos_id);