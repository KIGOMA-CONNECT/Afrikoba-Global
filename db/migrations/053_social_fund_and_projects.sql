-- Migration 053: Afrikoba Social Fund / Msaada + Controlled Project Accounts & Waterfall Distribution

-- ===== 1. SOCIAL FUND / MSAADA =====

CREATE TABLE IF NOT EXISTS social_fund_rules (
  id SERIAL PRIMARY KEY,
  group_id INT, -- links to vicoba or enterprise group if applicable, or platform-wide
  is_compulsory BOOLEAN DEFAULT FALSE,
  contribution_type VARCHAR(20) DEFAULT 'FIXED', -- FIXED, FLEXIBLE
  default_amount NUMERIC(14,2) DEFAULT 0,
  max_cases_per_year INT DEFAULT 12,
  default_deadline_days INT DEFAULT 7,
  allow_anonymous BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS social_fund_cases (
  id SERIAL PRIMARY KEY,
  initiator_id INT NOT NULL REFERENCES users(id),
  context_type VARCHAR(40) NOT NULL, -- FAMILY, WORKPLACE, SCHOOL, BUSINESS, FRIENDS, ASSOCIATION, COMMUNITY
  case_type VARCHAR(40) NOT NULL, -- RAMBIRAMBI, MEDICAL, ACCIDENT, DISASTER, EMERGENCY, OTHER
  beneficiary_name VARCHAR(120) NOT NULL,
  beneficiary_phone VARCHAR(30),
  title VARCHAR(150) NOT NULL,
  description TEXT,
  target_amount NUMERIC(14,2) NOT NULL,
  total_collected NUMERIC(14,2) DEFAULT 0,
  deadline TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, COLLECTING, CLOSED, DISBURSED, CANCELLED
  privacy_mode VARCHAR(20) DEFAULT 'MEMBERS_ONLY', -- PUBLIC, MEMBERS_ONLY, ANONYMOUS_AMOUNTS
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_cases_status ON social_fund_cases(status);
CREATE INDEX IF NOT EXISTS idx_social_cases_type ON social_fund_cases(case_type);

CREATE TABLE IF NOT EXISTS social_fund_contributions (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES social_fund_cases(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(14,2) NOT NULL,
  is_anonymous BOOLEAN DEFAULT FALSE,
  reference_id VARCHAR(50) UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'SUCCESS',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_contrib_case ON social_fund_contributions(case_id);

CREATE TABLE IF NOT EXISTS social_fund_payouts (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES social_fund_cases(id) ON DELETE CASCADE,
  authorized_by INT REFERENCES users(id),
  amount NUMERIC(14,2) NOT NULL,
  recipient_phone VARCHAR(30) NOT NULL,
  reference_id VARCHAR(50) UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, DISBURSED
  disbursed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ===== 2. CONTROLLED PROJECT ACCOUNTS & DECOMPOSITION =====

CREATE TABLE IF NOT EXISTS project_decompositions (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL, -- references projects or business loans
  phase_name VARCHAR(100) NOT NULL,
  work_package VARCHAR(120),
  task_name VARCHAR(150) NOT NULL,
  estimated_cost NUMERIC(15,2) NOT NULL,
  duration_days INT DEFAULT 14,
  milestone_marker BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, IN_PROGRESS, COMPLETED
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS controlled_project_accounts (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL UNIQUE,
  escrow_balance NUMERIC(15,2) DEFAULT 0,
  disbursed_total NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_revenue_waterfall (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL,
  total_revenue NUMERIC(15,2) NOT NULL,
  investor_share_pct NUMERIC(5,2) DEFAULT 60.00,
  owner_share_pct NUMERIC(5,2) DEFAULT 20.00,
  reserve_pct NUMERIC(5,2) DEFAULT 10.00,
  reinvestment_pct NUMERIC(5,2) DEFAULT 10.00,
  distributed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
