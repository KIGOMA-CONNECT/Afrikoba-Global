-- D1: Smart alerts
CREATE TABLE IF NOT EXISTS smart_alerts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_type VARCHAR(50) NOT NULL, -- BALANCE_LOW, BALANCE_HIGH, LARGE_TRANSACTION, UNUSUAL_ACTIVITY, CONTRIBUTION_DUE, LOAN_DUE, CUSTOM
  threshold NUMERIC(15,2),
  message_template TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  last_triggered TIMESTAMPTZ,
  trigger_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- D2: Debt tracker
CREATE TABLE IF NOT EXISTS debts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL, -- LENT (you lent), OWED (someone owes you)
  counterparty_phone VARCHAR(20) NOT NULL,
  counterparty_name VARCHAR(100),
  amount NUMERIC(15,2) NOT NULL,
  amount_paid NUMERIC(15,2) DEFAULT 0,
  description VARCHAR(255),
  due_date DATE,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PARTIAL, PAID, WRITTEN_OFF
  transaction_id INT REFERENCES transactions(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- D3: Rewards/cashback
CREATE TABLE IF NOT EXISTS rewards (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points INT DEFAULT 0,
  tier VARCHAR(20) DEFAULT 'BRONZE', -- BRONZE, SILVER, GOLD, PLATINUM
  total_earned INT DEFAULT 0,
  total_redeemed INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS reward_transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  type VARCHAR(20) NOT NULL, -- EARN, REDEEM, EXPIRE
  points INT NOT NULL,
  description VARCHAR(255) NOT NULL,
  reference_type VARCHAR(50), -- TRANSFER, DEPOSIT, REFERRAL, CASHBACK
  reference_id INT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- D4: Subscription tracker
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  frequency VARCHAR(20) NOT NULL, -- WEEKLY, MONTHLY, YEARLY
  category VARCHAR(50),
  next_billing DATE NOT NULL,
  last_billing DATE,
  is_active BOOLEAN DEFAULT TRUE,
  auto_pay BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- D5: Financial calendar events
CREATE TABLE IF NOT EXISTS calendar_events (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  event_type VARCHAR(50) NOT NULL, -- CONTRIBUTION_DUE, LOAN_REPAYMENT, SAVINGS_GOAL, CUSTOM
  event_date DATE NOT NULL,
  amount NUMERIC(15,2),
  is_recurring BOOLEAN DEFAULT FALSE,
  recurrence_pattern VARCHAR(50),
  reminder_days INT DEFAULT 1,
  is_completed BOOLEAN DEFAULT FALSE,
  related_id INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- D7: Transaction categories (enhanced)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS auto_category VARCHAR(50);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS notes TEXT;

-- D8: Multi-user business accounts
CREATE TABLE IF NOT EXISTS business_accounts (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES users(id),
  business_name VARCHAR(200) NOT NULL,
  business_type VARCHAR(50),
  registration_number VARCHAR(100),
  tax_id VARCHAR(100),
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(100),
  wallet_id INT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_members (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  role VARCHAR(30) NOT NULL, -- OWNER, ADMIN, ACCOUNTANT, VIEWER
  permissions TEXT[] DEFAULT '{view}',
  is_active BOOLEAN DEFAULT TRUE,
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  joined_at TIMESTAMPTZ,
  UNIQUE(business_id, user_id)
);

CREATE TABLE IF NOT EXISTS business_audit_log (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id),
  user_id INT NOT NULL REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  details JSONB,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- D10: Financial literacy tips
CREATE TABLE IF NOT EXISTS financial_tips (
  id SERIAL PRIMARY KEY,
  category VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  language VARCHAR(5) DEFAULT 'sw',
  is_active BOOLEAN DEFAULT TRUE,
  display_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO financial_tips (category, title, content, language) VALUES
  ('SAVINGS', 'Akiba ndiyo Msingi', 'Weka angalau 10% ya mapato yako kila mwezi kwenye akiba. Anza na kiasi kidogo na ongeza polepole.', 'sw'),
  ('SAVINGS', 'Emergency Fund', 'Hifadhi angalau gharama za miezi 3-6 za maisha. Hii inakulinda dhidi ya matukio yasiyotabirika.', 'sw'),
  ('INVESTMENT', 'Uwekezaji ni Nafasi', 'Usiweka akiba yote benki. Wekeza sehemu kwenye biashara, hisa, au miradi ya P2P kupata mapato ya ziada.', 'sw'),
  ('DEBT', 'Lipa Deni Kwanza', 'Kama una deni, lipa deni lenye riba kubwa zaidi kwanza. Hii inakokoa pesa za riba.', 'sw'),
  ('BUDGET', 'Rusma Rule', 'Tumia kanuni ya 50/30/20: 50% mahitaji, 30% matumizi, 20% akiba na ulipaji wa deni.', 'sw'),
  ('SECURITY', 'Salinadi ya PIN', 'Usishiriki PIN yako na mtu yeyote. Benki haiwezi kuomba PIN yako.', 'sw'),
  ('BUSINESS', 'Fuatilia Mapato na Matumizi', 'Kila biashara inahitaji kufuatilia mapato na matumizi. Tumia programu kama Afrikoba kufanya hivi kiotomatiki.', 'sw'),
  ('VICOFA', 'Ushirikiano ni Nguvu', 'VICOFA inakusaidia kukusanya fedha pamoja na watu wengine. Imara na ushirikiano na uaminifu.', 'sw'),
  ('SAVINGS', 'Round-Up Savings', 'Kila unapofanya ununuzi, akiba kidogo zaidi. K mfano: ununua TSh 9,500, weka TSh 10,000 na akiba TSh 500.', 'sw'),
  ('INVESTMENT', 'Diversify', 'Usiweke pesa zote mahali pamoja. Gawanya uwekezaji wako kwenye fursa tofauti ili kupunguza hatari.', 'sw')
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_smart_alerts_user ON smart_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_smart_alerts_type ON smart_alerts(alert_type, is_active);
CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id);
CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(status);
CREATE INDEX IF NOT EXISTS idx_rewards_user ON rewards(user_id);
CREATE INDEX IF NOT EXISTS idx_reward_transactions_user ON reward_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next ON subscriptions(next_billing, is_active);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(event_date, is_completed);
CREATE INDEX IF NOT EXISTS idx_business_accounts_owner ON business_accounts(owner_id);
CREATE INDEX IF NOT EXISTS idx_business_members_user ON business_members(user_id);
CREATE INDEX IF NOT EXISTS idx_business_audit_log_business ON business_audit_log(business_id);
CREATE INDEX IF NOT EXISTS idx_financial_tips_category ON financial_tips(category, is_active);
