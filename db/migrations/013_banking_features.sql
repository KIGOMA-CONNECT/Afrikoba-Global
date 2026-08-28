-- B1: Transaction limits per user
CREATE TABLE IF NOT EXISTS transaction_limits (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  limit_type VARCHAR(50) NOT NULL, -- DAILY, MONTHLY, PER_TRANSACTION
  transaction_type VARCHAR(50) NOT NULL, -- TRANSFER, WITHDRAWAL, DEPOSIT, ALL
  max_amount NUMERIC(15,2) NOT NULL,
  used_amount NUMERIC(15,2) DEFAULT 0,
  period_start TIMESTAMPTZ DEFAULT NOW(),
  period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, limit_type, transaction_type)
);

-- Default limits for all users (TSh amounts)
INSERT INTO transaction_limits (user_id, limit_type, transaction_type, max_amount, period_end)
SELECT u.id, l.limit_type, l.tx_type, l.amount, 
  CASE l.limit_type
    WHEN 'DAILY' THEN NOW() + INTERVAL '1 day'
    WHEN 'MONTHLY' THEN NOW() + INTERVAL '1 month'
    WHEN 'PER_TRANSACTION' THEN NULL
  END
FROM users u
CROSS JOIN (VALUES
  ('DAILY', 'ALL', 5000000),
  ('MONTHLY', 'ALL', 100000000),
  ('PER_TRANSACTION', 'ALL', 2000000),
  ('DAILY', 'WITHDRAWAL', 2000000),
  ('PER_TRANSACTION', 'WITHDRAWAL', 1000000)
) AS l(limit_type, tx_type, amount)
ON CONFLICT DO NOTHING;

-- B2: Beneficiaries
CREATE TABLE IF NOT EXISTS beneficiaries (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  nickname VARCHAR(50),
  is_favorite BOOLEAN DEFAULT FALSE,
  usage_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, phone)
);

-- B3: Transaction disputes
CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  transaction_id INT REFERENCES transactions(id),
  reason VARCHAR(50) NOT NULL, -- UNAUTHORIZED, WRONG_AMOUNT, DUPLICATE, NOT_RECEIVED, FRAUD, OTHER
  description TEXT NOT NULL,
  amount_disputed NUMERIC(15,2) NOT NULL,
  status VARCHAR(30) DEFAULT 'OPEN', -- OPEN, UNDER_REVIEW, RESOLVED, REJECTED
  resolution TEXT,
  resolved_by INT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  evidence_urls TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- B4: Savings goals
CREATE TABLE IF NOT EXISTS savings_goals (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  target_amount NUMERIC(15,2) NOT NULL,
  current_amount NUMERIC(15,2) DEFAULT 0,
  deadline DATE,
  icon VARCHAR(50) DEFAULT 'target',
  color VARCHAR(20) DEFAULT '#4CAF50',
  is_completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  auto_save_amount NUMERIC(15,2),
  auto_save_frequency VARCHAR(20), -- DAILY, WEEKLY, MONTHLY
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- B5: Scheduled/recurring payments
CREATE TABLE IF NOT EXISTS scheduled_payments (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  beneficiary_id INT REFERENCES beneficiaries(id),
  recipient_phone VARCHAR(20) NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  description VARCHAR(255),
  frequency VARCHAR(20) NOT NULL, -- ONCE, DAILY, WEEKLY, MONTHLY, YEARLY
  next_execution DATE NOT NULL,
  last_execution DATE,
  end_date DATE,
  execution_count INT DEFAULT 0,
  max_executions INT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- B7: Trusted devices
CREATE TABLE IF NOT EXISTS trusted_devices (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_fingerprint VARCHAR(64) NOT NULL,
  device_name VARCHAR(100),
  device_type VARCHAR(50), -- MOBILE, TABLET, DESKTOP
  os VARCHAR(50),
  browser VARCHAR(50),
  ip_address VARCHAR(45),
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, device_fingerprint)
);

-- B8: Active sessions
CREATE TABLE IF NOT EXISTS active_sessions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash VARCHAR(64) NOT NULL,
  device_fingerprint VARCHAR(64),
  device_name VARCHAR(100),
  ip_address VARCHAR(45),
  user_agent TEXT,
  location VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B9: Fraud detection alerts
CREATE TABLE IF NOT EXISTS fraud_alerts (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  alert_type VARCHAR(50) NOT NULL, -- VELOCITY, AMOUNT, LOCATION, DEVICE, TIME, PATTERN
  severity VARCHAR(20) NOT NULL, -- LOW, MEDIUM, HIGH, CRITICAL
  description TEXT NOT NULL,
  transaction_id INT REFERENCES transactions(id),
  ip_address VARCHAR(45),
  device_fingerprint VARCHAR(64),
  is_resolved BOOLEAN DEFAULT FALSE,
  resolved_by INT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B10: Spending categories
CREATE TABLE IF NOT EXISTS spending_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  icon VARCHAR(50),
  color VARCHAR(20)
);

INSERT INTO spending_categories (name, icon, color) VALUES
  ('Food & Dining', 'utensils', '#FF5722'),
  ('Transport', 'car', '#2196F3'),
  ('Utilities', 'bolt', '#FFC107'),
  ('Education', 'book', '#9C27B0'),
  ('Healthcare', 'heart', '#E91E63'),
  ('Shopping', 'shopping-bag', '#00BCD4'),
  ('Entertainment', 'film', '#FF9800'),
  ('Savings', 'piggy-bank', '#4CAF50'),
  ('Business', 'briefcase', '#607D8B'),
  ('Other', 'more-horizontal', '#9E9E9E')
ON CONFLICT DO NOTHING;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_id INT REFERENCES spending_categories(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_id INT REFERENCES disputes(id);

CREATE INDEX IF NOT EXISTS idx_transaction_limits_user ON transaction_limits(user_id);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_user ON beneficiaries(user_id);
CREATE INDEX IF NOT EXISTS idx_disputes_user ON disputes(user_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_savings_goals_user ON savings_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_payments_user ON scheduled_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_payments_next ON scheduled_payments(next_execution, is_active);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_token ON active_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_user ON fraud_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_severity ON fraud_alerts(severity, is_resolved);
