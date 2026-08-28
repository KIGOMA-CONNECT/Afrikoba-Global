-- ============================================================
-- I-SERIES: SAVINGS & CREDIT
-- I1-I5: Savings goals (extended), auto-save, fixed deposits
-- I6-I8: Credit score & limit, micro-loans + installments
-- I9: Loan guarantors | I10: Credit report
-- ============================================================

-- ------------------------------------------------------------
-- Extend transactions.type to cover savings & credit events
-- (DROP/ADD pattern sawa na 018 - hulinda fresh + existing DBs)
-- ------------------------------------------------------------
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type = ANY (ARRAY[
    'DEPOSIT','WITHDRAWAL','TRANSFER',
    'ROSCA_CONTRIBUTION','ROSCA_PAYOUT','ROSCA_LOCK',
    'INVESTMENT','INVESTMENT_PAYOUT',
    'VICOBA_SHARE','VICOBA_LOAN','VICOBA_MAINTENANCE_FEE','VICOBA_PENALTY',
    'VICOBA_SOCIAL_FUND','VICOBA_SOCIAL_FUND_DISBURSEMENT',
    'VICOBA_LOAN_REPAYMENT','VICOBA_PROFIT_PAYOUT',
    'CASH_IN','CASH_OUT','BULK_PAYMENT','REMITTANCE',
    'CASHBACK','SUBSCRIPTION','FEE','REFERRAL_REWARD',
    'SAVINGS_DEPOSIT','SAVINGS_WITHDRAWAL',
    'FIXED_DEPOSIT','FIXED_DEPOSIT_INTEREST','FIXED_DEPOSIT_PENALTY',
    'LOAN_CREDIT','LOAN_REPAYMENT','LOAN_GUARANTEE','LOAN_GUARANTEE_RELEASE'
  ]::text[]));

-- ------------------------------------------------------------
-- I1: Savings goals - add lifecycle status
-- ------------------------------------------------------------
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ACTIVE'; -- ACTIVE, COMPLETED
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS notes TEXT;

-- ------------------------------------------------------------
-- I2: Auto-save rules (hufanya save kwenye goals zilizowekwa)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_save_rules (
  id SERIAL PRIMARY KEY,
  goal_id INT NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frequency VARCHAR(20) NOT NULL, -- DAILY, WEEKLY, MONTHLY
  amount NUMERIC(15,2) NOT NULL,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  run_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- I3: Fixed deposits (maturity + early withdrawal)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_deposits (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(15,2) NOT NULL,
  term_months INT NOT NULL,
  annual_rate NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  maturity_date DATE NOT NULL,
  interest_accrued NUMERIC(15,2) DEFAULT 0,
  penalty_amount NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, MATURED, WITHDRAWN_EARLY
  matured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- I4-I5: Micro loans + installment schedule
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS micro_loans (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(15,2) NOT NULL,
  interest_rate NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  term_months INT NOT NULL DEFAULT 1,
  monthly_installment NUMERIC(15,2) DEFAULT 0,
  due_amount NUMERIC(15,2) DEFAULT 0,
  paid_amount NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, ACTIVE, REPAID, REJECTED
  credit_score_at_apply INT,
  admin_note TEXT,
  guarantor_required BOOLEAN DEFAULT TRUE,
  approved_at TIMESTAMPTZ,
  disbursed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loan_installments (
  id SERIAL PRIMARY KEY,
  loan_id INT NOT NULL REFERENCES micro_loans(id) ON DELETE CASCADE,
  sequence INT NOT NULL,
  due_date DATE NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  paid_amount NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PAID, WAIVED
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(loan_id, sequence)
);

-- ------------------------------------------------------------
-- I6: Credit score & limit (extended)
-- ------------------------------------------------------------
ALTER TABLE credit_scores ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(15,2) DEFAULT 0;

-- ------------------------------------------------------------
-- I9: Loan guarantors (mdhamini atengeneza sehemu ya mkopo)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_guarantors (
  id SERIAL PRIMARY KEY,
  loan_id INT NOT NULL REFERENCES micro_loans(id) ON DELETE CASCADE,
  guarantor_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, ACCEPTED, DECLINED, RELEASED
  decided_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(loan_id, guarantor_id)
);

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_auto_save_rules_user ON auto_save_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_auto_save_rules_goal ON auto_save_rules(goal_id);
CREATE INDEX IF NOT EXISTS idx_auto_save_rules_next ON auto_save_rules(next_run_at, is_active);
CREATE INDEX IF NOT EXISTS idx_fixed_deposits_user ON fixed_deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_fixed_deposits_status ON fixed_deposits(status, maturity_date);
CREATE INDEX IF NOT EXISTS idx_micro_loans_user ON micro_loans(user_id);
CREATE INDEX IF NOT EXISTS idx_micro_loans_status ON micro_loans(status);
CREATE INDEX IF NOT EXISTS idx_loan_installments_loan ON loan_installments(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_installments_status ON loan_installments(loan_id, status);
CREATE INDEX IF NOT EXISTS idx_loan_guarantors_loan ON loan_guarantors(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_guarantors_guarantor ON loan_guarantors(guarantor_id, status);

-- ------------------------------------------------------------
-- H3 fix: invoice_number inapaswa kuwa unique kwenye business
-- PEKEE (H-series ilianza -0001 kwa kila business jipya),
-- si kwenye mfumo mzima. Hii inarahisi kuweka safari ya fresh DB
-- na pia kwenye DB zilizopo (hakuna duplicate per business).
-- ------------------------------------------------------------
ALTER TABLE business_invoices DROP CONSTRAINT IF EXISTS business_invoices_invoice_number_key;
ALTER TABLE business_invoices ADD CONSTRAINT business_invoices_invoice_number_key UNIQUE (business_id, invoice_number);