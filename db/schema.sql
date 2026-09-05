-- =====================================================
-- AFRIKOBA GLOBAL - FULL ENGINE DDL (PostgreSQL)
-- Integrated Core Digital Banking, VICOBA, ROSCA, P2P
-- =====================================================

-- ==========================================
-- 1. WATUMIAJI NA KYC (USERS & AUTH)
-- ==========================================
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(120) NOT NULL,
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE,
    password_hash VARCHAR(255),
    pin_hash VARCHAR(255),
    nida_number VARCHAR(20) UNIQUE,
    kyc_level INT DEFAULT 1,            -- 1 = Basic, 2 = Advanced (NIDA verified)
    id_document_url VARCHAR(255),       -- Picha ya Kitambulisho (KYC L2)
    residential_address VARCHAR(255),   -- Anwani ya Makazi (KYC L2)
    role VARCHAR(20) DEFAULT 'MJUMBE',  -- MJUMBE, MWENYEKITI, KATIBU, MWEKAHAZINA, ISSUER, ADMIN
    wallet_balance NUMERIC(15, 2) DEFAULT 0.00 CHECK (wallet_balance >= 0),
    locked_balance NUMERIC(15, 2) DEFAULT 0.00 CHECK (locked_balance >= 0),
    trust_score INT DEFAULT 100,        -- Credit Rating (ROSCA queue allocation)
    currency_code VARCHAR(3) DEFAULT 'TZS',  -- ISO 4217 (Pan-African ready)
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- KYC Documents
CREATE TABLE IF NOT EXISTS kyc_documents (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    document_type VARCHAR(30) NOT NULL,   -- NIDA, PASSPORT, VOTER_ID, BRELA, TIN
    document_url VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, VERIFIED, REJECTED
    verified_by INT REFERENCES users(id),
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- OTP (Beem Africa SMS)
CREATE TABLE IF NOT EXISTS otp_codes (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    phone_number VARCHAR(15) NOT NULL,
    otp_code VARCHAR(10) NOT NULL,
    purpose VARCHAR(30) NOT NULL,       -- LOGIN, PIN_SETUP, TRANSACTION, KYC
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    attempts INT DEFAULT 0,             -- majaribio ya kuingiza OTP (max 5)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 2. WALLET & TRANSACTIONS
-- ==========================================
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    reference_id VARCHAR(50) UNIQUE NOT NULL,
    external_tx_id VARCHAR(100),        -- AzamPay Reference
    user_id INT REFERENCES users(id) ON DELETE RESTRICT,
    wallet_amount NUMERIC(15, 2) NOT NULL,
    commission NUMERIC(15, 2) NOT NULL, -- 1% comm
    total_charged NUMERIC(15, 2) NOT NULL,
    currency_code VARCHAR(3) DEFAULT 'TZS',
    type VARCHAR(60) CHECK (type IN (
        'DEPOSIT', 'WITHDRAWAL', 'TRANSFER',
        'ROSCA_CONTRIBUTION', 'ROSCA_PAYOUT', 'ROSCA_LOCK',
        'INVESTMENT', 'INVESTMENT_PAYOUT',
        'VICOBA_SHARE', 'VICOBA_LOAN', 'VICOBA_MAINTENANCE_FEE'
    )),
    status VARCHAR(20) CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
    failure_reason TEXT,
    meta JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_status ON transactions(user_id, status);

-- Internal wallet-to-wallet ledger (atomic double-entry)
CREATE TABLE IF NOT EXISTS wallet_ledger (
    id SERIAL PRIMARY KEY,
    transaction_id INT REFERENCES transactions(id),
    reference_id VARCHAR(50) NOT NULL,
    from_user_id INT REFERENCES users(id),
    to_user_id INT REFERENCES users(id),
    amount NUMERIC(15, 2) NOT NULL,
    currency_code VARCHAR(3) DEFAULT 'TZS',
    description VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_users ON wallet_ledger(from_user_id, to_user_id);

CREATE TABLE IF NOT EXISTS company_revenue (
    id SERIAL PRIMARY KEY,
    total_commission NUMERIC(15, 2) DEFAULT 0.00,
    total_maintenance_fees NUMERIC(15, 2) DEFAULT 0.00,
    total_platform_fees NUMERIC(15, 2) DEFAULT 0.00,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO company_revenue (id, total_commission, total_maintenance_fees, total_platform_fees)
VALUES (1, 0.00, 0.00, 0.00)
ON CONFLICT (id) DO NOTHING;

-- ==========================================
-- 3. VICOBA MANAGEMENT MODULE
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_groups (
    id SERIAL PRIMARY KEY,
    group_name VARCHAR(150) NOT NULL,
    cycle_type VARCHAR(20) CHECK (cycle_type IN ('WEEKLY', 'MONTHLY')),
    share_value NUMERIC(15, 2) NOT NULL,
    monthly_maintenance_fee NUMERIC(15, 2) DEFAULT 10000.00,
    group_wallet_balance NUMERIC(15, 2) DEFAULT 0.00 CHECK (group_wallet_balance >= 0),
    created_by_user_id INT REFERENCES users(id),
    join_code VARCHAR(12) UNIQUE, -- msimbo wa kujiunga kikundi
    status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, SUSPENDED, CLOSED
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vicoba_members (
    id SERIAL PRIMARY KEY,
    group_id INT REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    role_in_group VARCHAR(20) DEFAULT 'MJUMBE', -- MJUMBE, MWENYEKITI, KATIBU, MWEKAHAZINA
    total_shares INT DEFAULT 0,
    social_fund_balance NUMERIC(15, 2) DEFAULT 0.00,
    contribution_balance NUMERIC(15, 2) DEFAULT 0.00,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, user_id)
);

-- Attendance & Savings (Mahudhurio)
CREATE TABLE IF NOT EXISTS vicoba_meetings (
    id SERIAL PRIMARY KEY,
    group_id INT REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    meeting_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, meeting_date)
);

-- Multi-Signature Loan Requests (Mwenyekiti 1st Approver, Mwekahazina/Katibu 2nd Approver)
CREATE TABLE IF NOT EXISTS vicoba_loan_requests (
    id SERIAL PRIMARY KEY,
    group_id INT REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    applicant_user_id INT REFERENCES users(id),
    requested_amount NUMERIC(15, 2) NOT NULL,
    approved_amount NUMERIC(15, 2) DEFAULT 0.00,
    interest_rate NUMERIC(5, 2) DEFAULT 10.00,
    repayment_months INT DEFAULT 3,
    chairman_approval BOOLEAN DEFAULT FALSE,
    chairman_approved_by INT REFERENCES users(id),
    treasurer_approval BOOLEAN DEFAULT FALSE,
    treasurer_approved_by INT REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, DISBURSED, REJECTED, REPAID
    payout_method VARCHAR(20) DEFAULT 'WALLET', -- WALLET or MNO (mtandao wa simu)
    payout_phone VARCHAR(15),
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 4. ROSCA / MZUNGUKO MODULE
-- ==========================================
CREATE TABLE IF NOT EXISTS rosca_pools (
    id SERIAL PRIMARY KEY,
    pool_name VARCHAR(100) NOT NULL,
    contribution_amount NUMERIC(15, 2) NOT NULL,
    cycle_frequency VARCHAR(20) CHECK (cycle_frequency IN ('WEEKLY', 'MONTHLY')),
    total_members INT NOT NULL,
    pool_type VARCHAR(20) CHECK (pool_type IN ('PUBLIC', 'PRIVATE_KIKOBA')),
    locked_collateral_percent NUMERIC(5, 2) DEFAULT 30.00, -- % ya mchango kwa Locked Collateral
    status VARCHAR(20) DEFAULT 'WAITING_MEMBERS', -- WAITING_MEMBERS, ACTIVE, COMPLETED
    current_cycle INT DEFAULT 1,
    created_by_user_id INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rosca_members (
    id SERIAL PRIMARY KEY,
    pool_id INT REFERENCES rosca_pools(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    assigned_queue_number INT,
    has_received_payout BOOLEAN DEFAULT FALSE,
    received_payout_amount NUMERIC(15, 2) DEFAULT 0.00,
    contributions_ok INT DEFAULT 0,
    contributions_missed INT DEFAULT 0,
    on_time_streak INT DEFAULT 0,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pool_id, user_id)
);

CREATE TABLE IF NOT EXISTS rosca_schedules (
    id SERIAL PRIMARY KEY,
    pool_id INT REFERENCES rosca_pools(id) ON DELETE CASCADE,
    cycle_number INT NOT NULL,
    recipient_user_id INT REFERENCES users(id),
    scheduled_date DATE NOT NULL,
    contribution_amount NUMERIC(15, 2) NOT NULL,
    total_payout_amount NUMERIC(15, 2) NOT NULL,
    comm_amount NUMERIC(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, COLLECTED, DISBURSED, SKIPPED
    disbursed_at TIMESTAMP,
    UNIQUE(pool_id, cycle_number)
);

-- ROSCA Trust History (trust_score derived from contribution reliability)
CREATE TABLE IF NOT EXISTS rosca_trust_history (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pool_id INT REFERENCES rosca_pools(id) ON DELETE CASCADE,
    cycle_number INT,
    delta NUMERIC(5, 1) NOT NULL,
    score_after NUMERIC(6, 2) NOT NULL,
    reason VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 5. P2P CROWDFUNDING & INVESTMENTS
-- ==========================================
CREATE TABLE IF NOT EXISTS investment_projects (
    id SERIAL PRIMARY KEY,
    owner_user_id INT REFERENCES users(id),
    title VARCHAR(150) NOT NULL,
    sector VARCHAR(50) NOT NULL, -- KILIMO, LOGISTICS, MANUFACTURING, SMES
    description TEXT NOT NULL,
    target_amount NUMERIC(15, 2) NOT NULL,
    raised_amount NUMERIC(15, 2) DEFAULT 0.00,
    share_price NUMERIC(15, 2) NOT NULL,
    roi_percentage NUMERIC(5, 2) NOT NULL,
    tenure_months INT NOT NULL,
    payback_start_months INT NOT NULL,
    business_plan TEXT,                      -- TAINFUND: Level 1 one-pager + Level 2 pitch
    team_info TEXT,                          -- TAINFUND: team background
    business_registration_url VARCHAR(255),  -- TAINFUND: KYC Level 3 docs (BRELA/TIN)
    financial_projection_url VARCHAR(255),   -- TAINFUND: financial due diligence
    min_investment_amount NUMERIC(15, 2) DEFAULT 50000.00,  -- TAINFUND: minimum ticket
    max_investment_per_investor NUMERIC(15, 2),            -- TAINFUND: diversification cap
    currency_code VARCHAR(3) DEFAULT 'TZS',
    status VARCHAR(20) DEFAULT 'SUBMITTED', -- SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, ACTIVE, FUNDED, COMPLETED, CLOSED
    rejection_reason TEXT,                   -- TAINFUND: feedback to issuer
    approved_at TIMESTAMP,
    approved_by INT REFERENCES users(id),
    audit_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4-Step Due Diligence Audit Trail
CREATE TABLE IF NOT EXISTS project_audit_steps (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES investment_projects(id) ON DELETE CASCADE,
    step_name VARCHAR(80) NOT NULL, -- KYC_KYB_VERIFICATION, FINANCIAL_AUDIT, ESCROW_SETUP, LEGAL_PRE_APPROVAL
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PASSED, FAILED
    notes TEXT,
    verified_by INT REFERENCES users(id),
    verified_at TIMESTAMP
);

-- Escrow Milestones (fedha zinazotolewa kwa awamu)
CREATE TABLE IF NOT EXISTS escrow_milestones (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES investment_projects(id) ON DELETE CASCADE,
    milestone_number INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'LOCKED', -- LOCKED, RELEASED
    released_at TIMESTAMP,
    released_by INT REFERENCES users(id),
    evidence_url VARCHAR(255),
    UNIQUE(project_id, milestone_number)
);

-- Project Business Accounts (Revenue Splitting)
CREATE TABLE IF NOT EXISTS project_business_wallets (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES investment_projects(id) UNIQUE,
    total_revenue_collected NUMERIC(15, 2) DEFAULT 0.00,
    operational_balance NUMERIC(15, 2) DEFAULT 0.00,
    investor_reserved_balance NUMERIC(15, 2) DEFAULT 0.00,
    platform_commission_balance NUMERIC(15, 2) DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS project_settlement_rules (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES investment_projects(id) UNIQUE,
    reinvestment_percentage NUMERIC(5, 2) DEFAULT 70.00,
    investor_payout_percentage NUMERIC(5, 2) DEFAULT 28.00,
    platform_comm_percentage NUMERIC(5, 2) DEFAULT 2.00,
    payout_cycle VARCHAR(20) DEFAULT 'MONTHLY'
);

CREATE TABLE IF NOT EXISTS investments (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES investment_projects(id) ON DELETE CASCADE,
    investor_user_id INT REFERENCES users(id),
    shares_bought INT NOT NULL,
    total_amount NUMERIC(15, 2) NOT NULL,
    contract_pdf_url VARCHAR(255),
    contract_signed_at TIMESTAMP,
    signer_ip VARCHAR(45),
    signer_phone VARCHAR(15),
    signer_nida VARCHAR(20),
    status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, REPAID, DEFAULTED
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Revenue split runs (Automated Split Payment Engine log)
CREATE TABLE IF NOT EXISTS revenue_split_runs (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES investment_projects(id) ON DELETE CASCADE,
    period_month INT NOT NULL,
    period_year INT NOT NULL,
    total_revenue NUMERIC(15, 2) NOT NULL,
    operational_share NUMERIC(15, 2) NOT NULL,
    investor_share NUMERIC(15, 2) NOT NULL,
    platform_share NUMERIC(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'PROCESSED',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, period_month, period_year)
);

-- ==========================================
-- 6. AUDIT & SECURITY LOGS
-- ==========================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id INT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    meta JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- SERVICE SUBSCRIPTIONS (choose-your-services model)
-- ==========================================
CREATE TABLE IF NOT EXISTS user_service_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_key VARCHAR(30) NOT NULL, -- WALLET, VICOBA, ROSCA, P2P, KILIMO
    status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, SUSPENDED
    subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, service_key)
);
CREATE INDEX IF NOT EXISTS idx_user_service_user ON user_service_subscriptions(user_id);

-- ==========================================
-- VICOBA INVITATIONS (chairman invites via SMS -> members accept with join code)
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_invites (
    id SERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    phone_number VARCHAR(15) NOT NULL,
    status VARCHAR(20) DEFAULT 'SENT', -- SENT, ACCEPTED, EXPIRED
    joined_user_id INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_vicoba_invites_group_phone UNIQUE (group_id, phone_number)
);
CREATE INDEX IF NOT EXISTS idx_vicoba_invites_phone ON vicoba_invites(phone_number, status);

-- ==========================================
-- TRIGGERS: updated_at maintenance
-- ==========================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
