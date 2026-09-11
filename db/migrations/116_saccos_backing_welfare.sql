-- ============================================================
-- SACCOS DIGITAL CORE - SAVINGS-BACKED LENDING + WELFARE FUND
-- (increment 16)
-- 1) Savings-backed loan limits: a loan application captures a
--    collateral backing snapshot (member savings balance + share
--    holdings book value at application time) plus the configured
--    multiple that caps the principal; approve() re-checks the LIVE
--    backing so savings withdrawn after applying voids approval.
-- 2) Member welfare/social fund: an OWNER/BOARD scheme defines a
--    contribution and a fixed payout. A member joins by contributing
--    once per scheme (UNIQUE(scheme_id, member_id), WLC-*) which is
--    ledgered DR CUSTOMER_WALLET / CR `SACCOS<id>_WELFARE_FUND`
--    (LIABILITY). Claims (SUBMITTED -> APPROVED/REJECTED -> PAID)
--    are paid out of the fund via DR fund / CR CUSTOMER_WALLET on an
--    idempotent WLF-* claim-operation (fund balance = contributions
--    - payouts, never negative).
-- ============================================================

ALTER TABLE saccos_loan_applications
  ADD COLUMN IF NOT EXISTS backing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS backing_multiple NUMERIC(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backing_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backing_limit NUMERIC(15,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS saccos_welfare_schemes (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  contribution NUMERIC(15,2) NOT NULL CHECK (contribution > 0),
  payout NUMERIC(15,2) NOT NULL CHECK (payout > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, ARCHIVED
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(saccos_id, name)
);
CREATE INDEX IF NOT EXISTS idx_saccos_welfare_schemes_saccos
  ON saccos_welfare_schemes(saccos_id, status);

CREATE TABLE IF NOT EXISTS saccos_welfare_contributions (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  scheme_id INT NOT NULL REFERENCES saccos_welfare_schemes(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- WLC-* (canonical money ref, journal + financial_operations)
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(scheme_id, member_id)                  -- a member joins a scheme with one contribution
);
CREATE INDEX IF NOT EXISTS idx_saccos_welfare_contributions_saccos
  ON saccos_welfare_contributions(saccos_id, member_id);

CREATE TABLE IF NOT EXISTS saccos_welfare_claims (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  scheme_id INT NOT NULL REFERENCES saccos_welfare_schemes(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  reference_id VARCHAR(24) NOT NULL UNIQUE,     -- WLF-* (claim + payout claim operation idempotency)
  event VARCHAR(100) NOT NULL,
  details TEXT,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED', -- SUBMITTED, APPROVED, REJECTED, PAID
  approved_by INT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  txn_reference VARCHAR(24),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saccos_welfare_claims_saccos
  ON saccos_welfare_claims(saccos_id, status);
CREATE INDEX IF NOT EXISTS idx_saccos_welfare_claims_member
  ON saccos_welfare_claims(saccos_id, member_id, status);