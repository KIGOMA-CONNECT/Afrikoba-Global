-- 029_afrikoba_yield_feature.sql
-- Yield investment engine tables

CREATE TABLE IF NOT EXISTS yield_plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    annual_rate NUMERIC(5, 2) DEFAULT 13.00,
    min_amount NUMERIC(15, 2) NOT NULL,
    lock_period_months INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_investments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL, -- references users(id)
    plan_id INT REFERENCES yield_plans(id),
    principal_amount NUMERIC(15, 2) NOT NULL,
    monthly_payout_amount NUMERIC(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, MATURED, CANCELLED
    start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    next_payout_date TIMESTAMP NOT NULL,
    maturity_date TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS yield_payout_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investment_id UUID REFERENCES user_investments(id),
    user_id UUID NOT NULL,
    amount_paid NUMERIC(15, 2) NOT NULL,
    payout_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'SUCCESS'
);

CREATE INDEX idx_user_investments_next_payout ON user_investments(next_payout_date) WHERE status = 'ACTIVE';
CREATE INDEX idx_user_investments_maturity ON user_investments(maturity_date) WHERE status = 'ACTIVE';
