-- ============================================================
-- AFRIKOBA PHASE 23: BUDGETING & SPEND CONTROL
-- 1) budgets - user-defined monthly spending cap per category.
--    period_key (YYYY-MM) so a budget belongs to a specific month.
-- 2) budget_alerts - generated when a category crosses a usage
--    threshold so the user (and Financial Health engine) can see
--    over-budget pressure at a glance.
-- ============================================================

CREATE TABLE IF NOT EXISTS budgets (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INT REFERENCES spending_categories(id) ON DELETE CASCADE,
    period_key VARCHAR(7) NOT NULL,            -- e.g. '2026-09'
    amount NUMERIC(15, 2) NOT NULL CHECK (amount >= 0),
    notes VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, category_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_budgets_user_period ON budgets(user_id, period_key);
CREATE INDEX IF NOT EXISTS idx_budgets_category ON budgets(category_id);

CREATE TABLE IF NOT EXISTS budget_alerts (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    budget_id INT REFERENCES budgets(id) ON DELETE CASCADE,
    period_key VARCHAR(7) NOT NULL,
    category_id INT,
    threshold_pct NUMERIC(5,2) NOT NULL,       -- e.g. 100 = over budget
    spent NUMERIC(15, 2) NOT NULL,
    budget_amount NUMERIC(15, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ACKNOWLEDGED','DISMISSED')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_budget_alerts_user_status ON budget_alerts(user_id, status);
