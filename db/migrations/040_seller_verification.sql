-- ============================================================================
-- 040 SELLER VERIFICATION (Afrikoba Verified Seller badge)
--
-- The marketplace stays OPEN, but every seller earns a passport-governed
-- badge computed from the AFRIKOBA ID (identity + financial health) and their
-- marketplace behaviour (sales history, reputation, dispute record).
--
-- Verification is computed on-demand and cached for 24h (a daily cron scans
-- all sellers and refreshes the cache). The read path is a plain LEFT JOIN so
-- listing queries stay O(1) and never recompute.
-- ============================================================================

CREATE TABLE IF NOT EXISTS seller_verification (
  user_id    INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verified   BOOLEAN NOT NULL DEFAULT FALSE,
  tier       VARCHAR(24) NOT NULL DEFAULT 'UNVERIFIED', -- AFRIKOBA_VERIFIED / ESTABLISHED / UNVERIFIED
  factors    JSONB NOT NULL DEFAULT '[]'::jsonb,        -- [{key,label,ok,detail}...]
  rated_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seller_verif_tier ON seller_verification(tier);