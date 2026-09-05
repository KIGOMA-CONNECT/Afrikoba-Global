-- =====================================================================
-- 072_social_events.sql
-- AFRIKOBA SOCIAL EVENTS & CONTRIBUTION ENGINE — Stage 1
-- Social Events (harusi/send-off/mahafali/birthday/etc), unified
-- contribution ledger (FUNDRAISING vs SAVINGS), event budget items.
-- =====================================================================

CREATE TABLE IF NOT EXISTS social_events (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  event_type VARCHAR(40) NOT NULL DEFAULT 'OTHER',
  description TEXT,
  -- Nani anamiliki tukio: INDIVIDUAL, COUPLE, FAMILY, CLAN, GROUP, ORGANIZATION
  owner_type VARCHAR(20) DEFAULT 'INDIVIDUAL',
  owner_user_id INT NOT NULL REFERENCES users(id),
  target_amount NUMERIC(15,2) NOT NULL CHECK (target_amount > 0),
  collected_amount NUMERIC(15,2) DEFAULT 0.00,
  savings_amount NUMERIC(15,2) DEFAULT 0.00,
  event_date DATE,
  contribution_deadline DATE,
  -- Mpango wa kuweka kidogo kidogo (optional): kadensi + kiasi cha kila kipindi
  savings_cadence VARCHAR(12), -- DAILY, WEEKLY, BIWEEKLY, MONTHLY, CUSTOM
  savings_session_amount NUMERIC(15,2),
  -- "Digital constitution" — rules za tukio (minimum, suggested, voluntary,
  -- surplus_rule, refund_rule, etc). JSONB ya flexible.
  rules JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'ACTIVE', -- DRAFT, ACTIVE, CLOSED, CANCELLED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_events_owner ON social_events(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_social_events_status ON social_events(status);
CREATE INDEX IF NOT EXISTS idx_social_events_type ON social_events(event_type);

-- Malawi mmoja: miezi ya michango (unified ledger)
CREATE TABLE IF NOT EXISTS event_contributions (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL, -- NULL kwa mchango wa cash/anonymous
  contributor_name VARCHAR(150),
  mode VARCHAR(20) NOT NULL DEFAULT 'FUNDRAISING', -- FUNDRAISING | SAVINGS
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reference_id VARCHAR(50) NOT NULL UNIQUE,
  status VARCHAR(20) DEFAULT 'SUCCESS', -- PENDING, SUCCESS, REFUNDED
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_contributions_event ON event_contributions(event_id);
CREATE INDEX IF NOT EXISTS idx_event_contributions_user ON event_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_event_contributions_mode ON event_contributions(event_id, mode, status);

-- Bajeti ya tukio (kategoria + kiasi)
CREATE TABLE IF NOT EXISTS event_budget_items (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  category VARCHAR(60) NOT NULL,
  description VARCHAR(255),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_budget_event ON event_budget_items(event_id);

-- Chart of accounts: mabwawa ya fedha ya matukio
-- EVENT_POOL    -> mchangiko wa fundraising (changia)
-- EVENT_SAVINGS -> akiba inayowekwa hatua kwa hatua kabla ya tukio
INSERT INTO ledger_accounts (account_code, name, account_type, is_system)
SELECT 'EVENT_POOL', 'Social Event Fundraising Pool', 'LIABILITY', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE account_code = 'EVENT_POOL');

INSERT INTO ledger_accounts (account_code, name, account_type, is_system)
SELECT 'EVENT_SAVINGS', 'Social Event Savings Pool', 'LIABILITY', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE account_code = 'EVENT_SAVINGS');