-- ============================================
-- 128: FX RATE HISTORY (daily samples)
-- --------------------------------------------
-- Feeds the FX rate history chart on the dashboard.
-- One canonical row per (pair, UTC day): the daily job upserts into
-- this table so we never store duplicate daily samples, and every
-- admin rate update also appends a point immediately.
-- `day` is stored explicitly (UTC) so the unique constraint is a
-- plain expression-free index (date_trunc on timestamptz is STABLE
-- and cannot be indexed directly).
-- ============================================

CREATE TABLE IF NOT EXISTS exchange_rate_history (
  id            BIGSERIAL PRIMARY KEY,
  from_currency VARCHAR(3) NOT NULL REFERENCES currencies(code),
  to_currency   VARCHAR(3) NOT NULL REFERENCES currencies(code),
  day           DATE NOT NULL,
  rate          NUMERIC(15,6) NOT NULL,
  source        VARCHAR(50) DEFAULT 'MANUAL',
  sampled_at    TIMESTAMPTZ DEFAULT NOW()
);

-- One sample per pair per day (ON CONFLICT target).
CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_rate_history_day
  ON exchange_rate_history (from_currency, to_currency, day);

CREATE INDEX IF NOT EXISTS idx_exchange_rate_history_pair
  ON exchange_rate_history (from_currency, to_currency, sampled_at);

-- Seed the first sample point from the current rate store so the
-- chart is not empty right after deployment.
INSERT INTO exchange_rate_history (from_currency, to_currency, day, rate, source, sampled_at)
SELECT from_currency, to_currency, NOW()::date, rate, source, NOW()
FROM exchange_rates
WHERE valid_until IS NULL OR valid_until > NOW()
ON CONFLICT (from_currency, to_currency, day) DO NOTHING;