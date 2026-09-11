-- ============================================================
-- SACCOS DIGITAL CORE - MEMBER STATEMENTS & REGULATORY REPORTS
-- (increment 11)
-- Adds a persisted regulatory/management snapshot table. The
-- reporting service computes aggregates live from the shared
-- double-entry ledger (per-entity SACCOS<id>_* codes) + the
-- saccos tables, then upserts a snapshot keyed by (saccos_id,
-- as_of) so regulators and boards see a dated, immutable picture.
-- Statements themselves are computed routes (no storage).
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_regulatory_reports (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  as_of DATE NOT NULL DEFAULT CURRENT_DATE,
  period_id INT REFERENCES saccos_accounting_periods(id),
  member_count_active INT NOT NULL DEFAULT 0,
  member_count_invited INT NOT NULL DEFAULT 0,
  member_count_suspended INT NOT NULL DEFAULT 0,
  member_count_exited INT NOT NULL DEFAULT 0,
  share_count_total INT NOT NULL DEFAULT 0,
  share_value_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  savings_liability NUMERIC(15,2) NOT NULL DEFAULT 0,
  investment_liability NUMERIC(15,2) NOT NULL DEFAULT 0,
  fund_balances NUMERIC(15,2) NOT NULL DEFAULT 0,
  loan_principal_outstanding NUMERIC(15,2) NOT NULL DEFAULT 0,
  loan_loss_reserves NUMERIC(15,2) NOT NULL DEFAULT 0,
  dividend_distributed NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_revenue NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_expense NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_income NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_exit_settlements NUMERIC(15,2) NOT NULL DEFAULT 0,
  generated_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (saccos_id, as_of)
);