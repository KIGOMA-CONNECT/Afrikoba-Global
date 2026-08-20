-- Migration: VICOBA Social Fund, Penalties, Loan Repayment Schedules
-- Date: 2026-08-19

-- ==========================================
-- 1. CONTRIBUTION SCHEDULES (due dates for hisa)
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_contribution_schedules (
    id SERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    cycle_number INT NOT NULL,
    due_date DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PAID, LATE, OVERDUE
    penalty_amount NUMERIC(15, 2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, cycle_number)
);

-- Track individual member contributions per cycle
CREATE TABLE IF NOT EXISTS vicoba_member_contributions (
    id SERIAL PRIMARY KEY,
    schedule_id INT NOT NULL REFERENCES vicoba_contribution_schedules(id) ON DELETE CASCADE,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id),
    amount NUMERIC(15, 2) NOT NULL,
    shares_count INT DEFAULT 1,
    paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_late BOOLEAN DEFAULT FALSE,
    penalty_paid NUMERIC(15, 2) DEFAULT 0.00,
    UNIQUE(schedule_id, user_id)
);

-- ==========================================
-- 2. PENALTIES TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_penalties (
    id SERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id),
    penalty_type VARCHAR(30) NOT NULL, -- LATE_CONTRIBUTION, LATE_LOAN_REPAYMENT
    amount NUMERIC(15, 2) NOT NULL,
    reason TEXT,
    related_loan_id INT REFERENCES vicoba_loan_requests(id),
    related_schedule_id INT REFERENCES vicoba_contribution_schedules(id),
    status VARCHAR(20) DEFAULT 'UNPAID', -- UNPAID, PAID, WAIVED
    waived_by INT REFERENCES users(id),
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 3. SOCIAL FUND (Msiba / Family Events)
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_social_fund (
    id SERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    total_balance NUMERIC(15, 2) DEFAULT 0.00,
    total_collected NUMERIC(15, 2) DEFAULT 0.00,
    total_disbursed NUMERIC(15, 2) DEFAULT 0.00,
    monthly_contribution NUMERIC(15, 2) NOT NULL, -- how much each member pays monthly
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id)
);

-- Social fund contributions per member per month
CREATE TABLE IF NOT EXISTS vicoba_social_fund_contributions (
    id SERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    fund_id INT NOT NULL REFERENCES vicoba_social_fund(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id),
    amount NUMERIC(15, 2) NOT NULL,
    month VARCHAR(7) NOT NULL, -- YYYY-MM format
    paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(fund_id, user_id, month)
);

-- Social fund disbursement requests (for emergencies: msiba, family events)
CREATE TABLE IF NOT EXISTS vicoba_social_fund_requests (
    id SERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    fund_id INT NOT NULL REFERENCES vicoba_social_fund(id) ON DELETE CASCADE,
    requester_id INT NOT NULL REFERENCES users(id),
    reason_type VARCHAR(30) NOT NULL, -- DEATH, WEDDING, ILLNESS, FUNERAL, FAMILY_EVENT, OTHER
    reason_detail TEXT NOT NULL,
    requested_amount NUMERIC(15, 2) NOT NULL,
    approved_amount NUMERIC(15, 2),
    approved_by INT REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED, DISBURSED
    disbursement_reference VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 4. LOAN REPAYMENT SCHEDULES
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_loan_schedules (
    id SERIAL PRIMARY KEY,
    loan_id INT NOT NULL REFERENCES vicoba_loan_requests(id) ON DELETE CASCADE,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    installment_number INT NOT NULL,
    due_date DATE NOT NULL,
    principal_amount NUMERIC(15, 2) NOT NULL,
    interest_amount NUMERIC(15, 2) NOT NULL,
    total_amount NUMERIC(15, 2) NOT NULL, -- principal + interest
    paid_amount NUMERIC(15, 2) DEFAULT 0.00,
    penalty_amount NUMERIC(15, 2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PAID, LATE, OVERDUE, DEFAULTED
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Loan repayments (actual payments)
CREATE TABLE IF NOT EXISTS vicoba_loan_repayments (
    id SERIAL PRIMARY KEY,
    loan_id INT NOT NULL REFERENCES vicoba_loan_requests(id) ON DELETE CASCADE,
    schedule_id INT REFERENCES vicoba_loan_schedules(id),
    user_id INT NOT NULL REFERENCES users(id),
    amount NUMERIC(15, 2) NOT NULL,
    reference_id VARCHAR(50) NOT NULL,
    payment_method VARCHAR(20) DEFAULT 'WALLET', -- WALLET, CASH
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 5. ALTER EXISTING TABLES
-- ==========================================
-- Add contribution due date to groups
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS contribution_due_day INT DEFAULT 1; -- day of month (1-28)
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS penalty_rate NUMERIC(5, 2) DEFAULT 5.00; -- % penalty per day late
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS max_penalty_percent NUMERIC(5, 2) DEFAULT 20.00; -- max 20% of share value

-- Add loan repayment tracking
ALTER TABLE vicoba_loan_requests ADD COLUMN IF NOT EXISTS total_repaid NUMERIC(15, 2) DEFAULT 0.00;
ALTER TABLE vicoba_loan_requests ADD COLUMN IF NOT EXISTS next_due_date DATE;
ALTER TABLE vicoba_loan_requests ADD COLUMN IF NOT EXISTS outstanding_balance NUMERIC(15, 2) DEFAULT 0.00;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_vicoba_penalties_user ON vicoba_penalties(user_id, status);
CREATE INDEX IF NOT EXISTS idx_vicoba_penalties_group ON vicoba_penalties(group_id, status);
CREATE INDEX IF NOT EXISTS idx_vicoba_loan_schedules_loan ON vicoba_loan_schedules(loan_id, status);
CREATE INDEX IF NOT EXISTS idx_vicoba_loan_schedules_due ON vicoba_loan_schedules(due_date, status);
CREATE INDEX IF NOT EXISTS idx_vicoba_social_fund_group ON vicoba_social_fund(group_id);
CREATE INDEX IF NOT EXISTS idx_vicoba_contribution_schedule_group ON vicoba_contribution_schedules(group_id, status);
