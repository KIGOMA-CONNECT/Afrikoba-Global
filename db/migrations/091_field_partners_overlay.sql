-- ============================================================
-- 091 FIELD PARTNER OVERLAY (Kiva-style)
-- Field partners (orgs already seeded in migration 069) gain a
-- staff owner linked to a platform user (role FIELD_PARTNER), an
-- operator contact, and a lendable pool projection mirrored on the
-- PARTNER_BALANCE ledger account. A new loan book overlays the
-- crowdfund/lending-circle engine: borrowers are onboarded as
-- platform users, disburse=DR PARTNER_BALANCE → CR CUSTOMER_WALLET,
-- repay=DR CUSTOMER_WALLET → CR PARTNER_BALANCE, both idempotent.
-- ============================================================

ALTER TABLE field_partners
  ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
  ADD COLUMN IF NOT EXISTS operator_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS available_balance NUMERIC(15,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS uniq_field_partners_user_id
  ON field_partners(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS field_partner_loans (
  id SERIAL PRIMARY KEY,
  field_partner_id INT NOT NULL REFERENCES field_partners(id),
  borrower_user_id INT NOT NULL REFERENCES users(id),
  loan_reference VARCHAR(40) NOT NULL UNIQUE,
  purpose VARCHAR(50) DEFAULT 'GENERAL', -- GENERAL, AGRICULTURE, EDUCATION, BUSINESS, LIVESTOCK, HEALTH
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  interest_rate NUMERIC(5,2) DEFAULT 0.00,
  term_months INT DEFAULT 12,
  total_due NUMERIC(15,2) NOT NULL CHECK (total_due > 0),
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, DISBURSED, REPAID, DEFAULTED, CANCELLED
  disbursed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS field_partner_repayments (
  id SERIAL PRIMARY KEY,
  loan_id INT NOT NULL REFERENCES field_partner_loans(id) ON DELETE CASCADE,
  borrower_user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reference VARCHAR(40) NOT NULL UNIQUE,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fp_loans_partner ON field_partner_loans(field_partner_id, status);
CREATE INDEX IF NOT EXISTS idx_fp_loans_borrower ON field_partner_loans(borrower_user_id, status);
CREATE INDEX IF NOT EXISTS idx_fp_repayments_loan ON field_partner_repayments(loan_id);