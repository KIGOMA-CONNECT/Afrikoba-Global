-- Migration 003: M-Koba inspired features for VICOBA
-- Group constitution, share purchasing, profit sharing, 3-tier transfers, meeting attendance, reporting

-- ==========================================
-- GROUP CONSTITUTION / RULES
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_group_constitutions (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE UNIQUE,
  min_shares_per_member INTEGER DEFAULT 1,
  max_shares_per_member INTEGER DEFAULT 100,
  share_price NUMERIC(15,2) DEFAULT 10000.00,
  max_loan_multiplier NUMERIC(5,2) DEFAULT 3.00,
  loan_interest_rate NUMERIC(5,2) DEFAULT 10.00,
  max_repayment_months INTEGER DEFAULT 6,
  fine_per_absence NUMERIC(15,2) DEFAULT 5000.00,
  fine_per_late_arrival NUMERIC(15,2) DEFAULT 2000.00,
  late_arrival_minutes INTEGER DEFAULT 15,
  meeting_day VARCHAR(20) DEFAULT 'SATURDAY',
  meeting_time VARCHAR(10) DEFAULT '10:00',
  meeting_frequency VARCHAR(20) DEFAULT 'WEEKLY',
  min_members INTEGER DEFAULT 5,
  max_members INTEGER DEFAULT 30,
  profit_distribution VARCHAR(20) DEFAULT 'PROPORTIONAL',
  share_rollover BOOLEAN DEFAULT TRUE,
  require_3_tier_approval BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ==========================================
-- SHARE PURCHASES — track individual share purchases
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_share_purchases (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shares_count INTEGER NOT NULL CHECK (shares_count > 0),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  cycle_number INTEGER,
  reference_id VARCHAR(30) UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'COMPLETED',
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_share_purchases_group_user ON vicoba_share_purchases(group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_share_purchases_cycle ON vicoba_share_purchases(group_id, cycle_number);

-- ==========================================
-- PROFIT DISTRIBUTIONS — annual/cycle profit sharing
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_profit_distributions (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
  cycle_number INTEGER NOT NULL,
  total_profit NUMERIC(15,2) NOT NULL,
  total_shares_at_distribution INTEGER NOT NULL,
  per_share_dividend NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  distributed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vicoba_profit_payouts (
  id SERIAL PRIMARY KEY,
  distribution_id INTEGER NOT NULL REFERENCES vicoba_profit_distributions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shares_count INTEGER NOT NULL,
  dividend_amount NUMERIC(15,2) NOT NULL,
  rollover_shares INTEGER DEFAULT 0,
  paid BOOLEAN DEFAULT FALSE,
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ==========================================
-- 3-TIER FUND TRANSFERS (Katibu → Mwekahazina → Mwenyekiti)
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_fund_transfers (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
  initiated_by INTEGER NOT NULL REFERENCES users(id),
  verified_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  transfer_type VARCHAR(30) NOT NULL,
  recipient_type VARCHAR(20) NOT NULL,
  recipient_user_id INTEGER REFERENCES users(id),
  recipient_phone VARCHAR(20),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) DEFAULT 'INITIATED',
  initiator_note TEXT,
  verifier_note TEXT,
  approver_note TEXT,
  reference_id VARCHAR(30) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  verified_at TIMESTAMP,
  approved_at TIMESTAMP,
  completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fund_transfers_group ON vicoba_fund_transfers(group_id, status);

-- ==========================================
-- MEETING ATTENDANCE
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_meeting_attendance (
  id SERIAL PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES vicoba_meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'PRESENT',
  arrived_at TIMESTAMP,
  fine_applied NUMERIC(15,2) DEFAULT 0,
  fine_paid BOOLEAN DEFAULT FALSE,
  fine_penalty_id INTEGER REFERENCES vicoba_penalties(id),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(meeting_id, user_id)
);

-- ==========================================
-- ALTER EXISTING TABLES
-- ==========================================

-- Add share capital tracking to members
ALTER TABLE vicoba_members ADD COLUMN IF NOT EXISTS share_capital NUMERIC(15,2) DEFAULT 0;
ALTER TABLE vicoba_members ADD COLUMN IF NOT EXISTS shares_rollover INTEGER DEFAULT 0;
ALTER TABLE vicoba_members ADD COLUMN IF NOT EXISTS total_profit_earned NUMERIC(15,2) DEFAULT 0;
ALTER TABLE vicoba_members ADD COLUMN IF NOT EXISTS meetings_attended INTEGER DEFAULT 0;
ALTER TABLE vicoba_members ADD COLUMN IF NOT EXISTS meetings_missed INTEGER DEFAULT 0;

-- Add cycle tracking to groups
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS current_cycle INTEGER DEFAULT 1;
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS total_profit_pool NUMERIC(15,2) DEFAULT 0;
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS cycle_start_date DATE;
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS cycle_end_date DATE;
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS total_members_count INTEGER DEFAULT 0;
