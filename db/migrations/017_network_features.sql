-- F1: Agent network
CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  agent_code VARCHAR(20) NOT NULL UNIQUE,
  business_name VARCHAR(200) NOT NULL,
  owner_name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(100),
  region VARCHAR(100),
  district VARCHAR(100),
  ward VARCHAR(100),
  latitude DECIMAL(10,8),
  longitude DECIMAL(11,8),
  commission_rate NUMERIC(5,2) DEFAULT 1.0,
  daily_limit NUMERIC(15,2) DEFAULT 10000000,
  balance NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, ACTIVE, SUSPENDED, DISABLED
  tier VARCHAR(20) DEFAULT 'BRONZE', -- BRONZE, SILVER, GOLD, PLATINUM
  verified_by INT REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_transactions (
  id SERIAL PRIMARY KEY,
  agent_id INT NOT NULL REFERENCES agents(id),
  customer_phone VARCHAR(20) NOT NULL,
  type VARCHAR(20) NOT NULL, -- CASH_IN, CASH_OUT
  amount NUMERIC(15,2) NOT NULL,
  commission NUMERIC(15,2) DEFAULT 0,
  reference VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_settlements (
  id SERIAL PRIMARY KEY,
  agent_id INT NOT NULL REFERENCES agents(id),
  amount NUMERIC(15,2) NOT NULL,
  type VARCHAR(20) NOT NULL, -- DEPOSIT, WITHDRAWAL
  reference VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  settled_by INT REFERENCES users(id),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- F2: Bulk payments
CREATE TABLE IF NOT EXISTS bulk_payment_batches (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  batch_name VARCHAR(200) NOT NULL,
  total_amount NUMERIC(15,2) NOT NULL,
  recipient_count INT NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PROCESSING, COMPLETED, FAILED
  file_name VARCHAR(200),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bulk_payment_items (
  id SERIAL PRIMARY KEY,
  batch_id INT NOT NULL REFERENCES bulk_payment_batches(id) ON DELETE CASCADE,
  recipient_phone VARCHAR(20) NOT NULL,
  recipient_name VARCHAR(100),
  amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, SUCCESS, FAILED
  failure_reason TEXT,
  transaction_id INT REFERENCES transactions(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- F3: Scheduled payments (table already created in 013; extend with new columns)
ALTER TABLE scheduled_payments ADD COLUMN IF NOT EXISTS recipient_id INT REFERENCES users(id);
ALTER TABLE scheduled_payments ADD COLUMN IF NOT EXISTS type VARCHAR(20); -- TRANSFER, BILL_PAYMENT, WITHDRAWAL
ALTER TABLE scheduled_payments ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE scheduled_payments ADD COLUMN IF NOT EXISTS recurrence VARCHAR(20); -- ONCE, DAILY, WEEKLY, MONTHLY
ALTER TABLE scheduled_payments ADD COLUMN IF NOT EXISTS last_executed TIMESTAMPTZ;
ALTER TABLE scheduled_payments ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ACTIVE'; -- ACTIVE, COMPLETED, CANCELLED, FAILED

-- F4: Cross-border remittances
CREATE TABLE IF NOT EXISTS remittance_corridors (
  id SERIAL PRIMARY KEY,
  from_country VARCHAR(3) NOT NULL,
  to_country VARCHAR(3) NOT NULL,
  from_currency VARCHAR(3) NOT NULL,
  to_currency VARCHAR(3) NOT NULL,
  exchange_rate NUMERIC(15,6) NOT NULL,
  fee_percentage NUMERIC(5,2) DEFAULT 2.0,
  min_amount NUMERIC(15,2) NOT NULL,
  max_amount NUMERIC(15,2) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(from_country, to_country)
);

CREATE TABLE IF NOT EXISTS remittance_transfers (
  id SERIAL PRIMARY KEY,
  sender_id INT NOT NULL REFERENCES users(id),
  recipient_phone VARCHAR(20) NOT NULL,
  recipient_name VARCHAR(100) NOT NULL,
  recipient_country VARCHAR(3) NOT NULL,
  from_amount NUMERIC(15,2) NOT NULL,
  to_amount NUMERIC(15,2) NOT NULL,
  exchange_rate NUMERIC(15,6) NOT NULL,
  fee NUMERIC(15,2) NOT NULL,
  reference VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED
  pickup_code VARCHAR(10),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- F5: Webhook subscriptions
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  url VARCHAR(500) NOT NULL,
  events TEXT[] NOT NULL,
  secret VARCHAR(64) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  last_triggered TIMESTAMPTZ,
  failure_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id SERIAL PRIMARY KEY,
  subscription_id INT NOT NULL REFERENCES webhook_subscriptions(id),
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  status_code INT,
  attempts INT DEFAULT 0,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- F6: Merchant loyalty
CREATE TABLE IF NOT EXISTS merchant_loyalty_programs (
  id SERIAL PRIMARY KEY,
  merchant_id INT NOT NULL REFERENCES merchants(id),
  name VARCHAR(100) NOT NULL,
  points_per_currency NUMERIC(10,4) DEFAULT 1.0,
  redemption_rate NUMERIC(10,4) DEFAULT 100.0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merchant_loyalty_accounts (
  id SERIAL PRIMARY KEY,
  program_id INT NOT NULL REFERENCES merchant_loyalty_programs(id),
  user_id INT NOT NULL REFERENCES users(id),
  points INT DEFAULT 0,
  total_earned INT DEFAULT 0,
  total_redeemed INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(program_id, user_id)
);

-- F8: Enhanced referral program
CREATE TABLE IF NOT EXISTS referral_tiers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  min_referrals INT NOT NULL,
  reward_per_referral NUMERIC(15,2) NOT NULL,
  bonus_threshold INT,
  bonus_amount NUMERIC(15,2),
  is_active BOOLEAN DEFAULT TRUE
);

INSERT INTO referral_tiers (name, min_referrals, reward_per_referral, bonus_threshold, bonus_amount) VALUES
  ('Starter', 0, 1000, NULL, NULL),
  ('Bronze', 5, 1500, 10, 5000),
  ('Silver', 20, 2000, 25, 10000),
  ('Gold', 50, 3000, 50, 25000),
  ('Platinum', 100, 5000, 100, 50000)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS referral_rewards (
  id SERIAL PRIMARY KEY,
  referrer_id INT NOT NULL REFERENCES users(id),
  referred_id INT NOT NULL REFERENCES users(id),
  tier_name VARCHAR(50),
  reward_amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PAID
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- F7: AI insights (stored predictions)
CREATE TABLE IF NOT EXISTS spending_predictions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  month VARCHAR(7) NOT NULL,
  predicted_amount NUMERIC(15,2) NOT NULL,
  confidence NUMERIC(5,2) DEFAULT 0.8,
  model_version VARCHAR(20) DEFAULT '1.0',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_code ON agents(agent_code);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agent_transactions_agent ON agent_transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_bulk_batches_user ON bulk_payment_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_bulk_items_batch ON bulk_payment_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_payments_user ON scheduled_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_payments_due ON scheduled_payments(scheduled_for, status);
CREATE INDEX IF NOT EXISTS idx_remittance_corridors ON remittance_corridors(from_country, to_country);
CREATE INDEX IF NOT EXISTS idx_remittance_transfers_sender ON remittance_transfers(sender_id);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_user ON webhook_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id);
CREATE INDEX IF NOT EXISTS idx_merchant_loyalty_programs ON merchant_loyalty_programs(merchant_id);
CREATE INDEX IF NOT EXISTS idx_merchant_loyalty_accounts ON merchant_loyalty_accounts(program_id, user_id);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer ON referral_rewards(referrer_id);
CREATE INDEX IF NOT EXISTS idx_spending_predictions_user ON spending_predictions(user_id, month);
