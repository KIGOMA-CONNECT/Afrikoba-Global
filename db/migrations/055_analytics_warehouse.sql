-- Migration 055: Analytics Data Warehouse Daily Aggregates Table

CREATE TABLE IF NOT EXISTS analytics_daily_aggregates (
  id SERIAL PRIMARY KEY,
  aggregate_date DATE UNIQUE NOT NULL,
  total_transactions INT DEFAULT 0,
  total_volume NUMERIC(18,2) DEFAULT 0,
  total_fees NUMERIC(15,2) DEFAULT 0,
  active_users INT DEFAULT 0,
  new_users INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_agg_date ON analytics_daily_aggregates(aggregate_date);
