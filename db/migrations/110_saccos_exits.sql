-- ============================================================
-- SACCOS DIGITAL CORE - MEMBER EXIT & SETTLEMENT (increment 10)
-- Closes the membership lifecycle: a member leaving the SACCOS
-- settles their book value in one atomic step before EXIT.
--   - savings  -> DR SACCOS<id>_SAVINGS_LIABILITY / CR CUSTOMER_WALLET
--   - shares   -> DR SACCOS<id>_SHARES_CAPITAL (EQUITY) / CR CUSTOMER_WALLET
--                (holdings.total_value, holdings zeroed)
--   - dividends-> each PENDING payout on DECLARED runs is paid here
--                (DR SACCOS<id>_DIVIDEND_DISTRIBUTED / CR CUSTOMER_WALLET,
--                payout marked PAID so a later board distribution
--                pays only the remaining members)
-- All legs idempotent on claim references (SXC-*-:SAV/:SHR, and the
-- payout's own DIVP-* ref for dividends). Membership then flips to
-- EXITED atomically (owners cannot settle; members act on selves
-- only). One settlement per member (UNIQUE member_id).
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_member_exits (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  member_id INT NOT NULL UNIQUE REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,      -- SXC-*
  savings_settled NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (savings_settled >= 0),
  share_count_settled INT NOT NULL DEFAULT 0 CHECK (share_count_settled >= 0),
  share_redemption_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (share_redemption_amount >= 0),
  dividend_settled NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (dividend_settled >= 0),
  total_settlement NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_settlement >= 0),
  settled_by INT NOT NULL REFERENCES users(id),
  settled_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_member_exits_saccos ON saccos_member_exits(saccos_id, settled_at DESC);