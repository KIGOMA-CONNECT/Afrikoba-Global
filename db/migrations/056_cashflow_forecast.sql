-- Migration 056: Cash-flow forecasting & financial anomaly detection tables

CREATE TABLE IF NOT EXISTS cashflow_forecasts (
  id SERIAL PRIMARY KEY,
  forecast_date DATE UNIQUE NOT NULL,
  predicted_inflow NUMERIC(18,2) DEFAULT 0,
  predicted_outflow NUMERIC(18,2) DEFAULT 0,
  net_cashflow NUMERIC(18,2) DEFAULT 0,
  confidence_score NUMERIC(5,2) DEFAULT 80.00,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashflow_date ON cashflow_forecasts(forecast_date);

CREATE TABLE IF NOT EXISTS financial_anomalies (
  id SERIAL PRIMARY KEY,
  anomaly_type VARCHAR(60) NOT NULL,
  severity VARCHAR(20) DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH, CRITICAL
  description TEXT NOT NULL,
  metadata JSONB,
  is_resolved BOOLEAN DEFAULT FALSE,
  resolved_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anomalies_resolved ON financial_anomalies(is_resolved);
