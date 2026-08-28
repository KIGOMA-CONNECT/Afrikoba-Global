-- E1: QR code payments
CREATE TABLE IF NOT EXISTS qr_codes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  code VARCHAR(50) NOT NULL UNIQUE,
  amount NUMERIC(15,2),
  description VARCHAR(255),
  type VARCHAR(20) DEFAULT 'STATIC', -- STATIC, DYNAMIC
  is_active BOOLEAN DEFAULT TRUE,
  scan_count INT DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qr_payments (
  id SERIAL PRIMARY KEY,
  qr_code_id INT REFERENCES qr_codes(id),
  payer_id INT NOT NULL REFERENCES users(id),
  payee_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- E2: In-app messaging
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) DEFAULT 'DIRECT', -- DIRECT, GROUP
  name VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  role VARCHAR(20) DEFAULT 'MEMBER',
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  is_muted BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'TEXT', -- TEXT, IMAGE, PAYMENT, SYSTEM
  metadata JSONB,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- E3: Bill payments
CREATE TABLE IF NOT EXISTS billers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL, -- ELECTRICITY, WATER, INTERNET, TV, GOVERNMENT
  icon VARCHAR(50),
  account_number_field VARCHAR(100) DEFAULT 'account_number',
  min_amount NUMERIC(15,2) DEFAULT 1000,
  max_amount NUMERIC(15,2) DEFAULT 50000000,
  fee_type VARCHAR(20) DEFAULT 'FIXED', -- FIXED, PERCENTAGE, NONE
  fee_value NUMERIC(15,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  api_provider VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bill_payments (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  biller_id INT NOT NULL REFERENCES billers(id),
  account_number VARCHAR(100) NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  fee NUMERIC(15,2) DEFAULT 0,
  total_charged NUMERIC(15,2) NOT NULL,
  reference VARCHAR(100),
  status VARCHAR(20) DEFAULT 'PENDING',
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- E4: Airtime/data purchase
CREATE TABLE IF NOT EXISTS airtime_purchases (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  phone VARCHAR(20) NOT NULL,
  provider VARCHAR(20) NOT NULL, -- VODACOM, AIRTEL, TIGO, HALOPESA
  product_type VARCHAR(20) NOT NULL, -- AIRTIME, DATA, BUNDLE
  amount NUMERIC(15,2) NOT NULL,
  reference VARCHAR(100),
  status VARCHAR(20) DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- E6: 2FA backup codes
CREATE TABLE IF NOT EXISTS backup_codes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash VARCHAR(64) NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- E7: Group savings challenges
CREATE TABLE IF NOT EXISTS savings_challenges (
  id SERIAL PRIMARY KEY,
  group_id INT, -- Can link to VICOBA or M-Koba
  creator_id INT NOT NULL REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  target_amount NUMERIC(15,2) NOT NULL,
  current_amount NUMERIC(15,2) DEFAULT 0,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  frequency VARCHAR(20) NOT NULL, -- DAILY, WEEKLY, MONTHLY
  per_contribution NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS savings_challenge_members (
  id SERIAL PRIMARY KEY,
  challenge_id INT NOT NULL REFERENCES savings_challenges(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  total_contributed NUMERIC(15,2) DEFAULT 0,
  contributions_count INT DEFAULT 0,
  streak INT DEFAULT 0,
  best_streak INT DEFAULT 0,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(challenge_id, user_id)
);

CREATE TABLE IF NOT EXISTS challenge_contributions (
  id SERIAL PRIMARY KEY,
  challenge_id INT NOT NULL REFERENCES savings_challenges(id),
  user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL,
  day_number INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- E8: Micro-insurance
CREATE TABLE IF NOT EXISTS insurance_products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(50) NOT NULL, -- HEALTH, LIFE, PROPERTY, CROP, BUSINESS
  premium_monthly NUMERIC(15,2) NOT NULL,
  coverage_amount NUMERIC(15,2) NOT NULL,
  min_age INT DEFAULT 18,
  max_age INT DEFAULT 65,
  waiting_period_days INT DEFAULT 30,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS insurance_policies (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  product_id INT NOT NULL REFERENCES insurance_products(id),
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, LAPSED, CLAIMED, EXPIRED
  premium_paid NUMERIC(15,2) DEFAULT 0,
  next_premium_date DATE,
  coverage_start DATE NOT NULL,
  coverage_end DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO billers (name, category, icon, fee_type, fee_value) VALUES
  ('TANESCO', 'ELECTRICITY', 'zap', 'FIXED', 1000),
  ('DAWASCO', 'WATER', 'droplet', 'FIXED', 500),
  ('DCCM', 'WATER', 'droplet', 'FIXED', 500),
  ('Vodacom', 'INTERNET', 'wifi', 'NONE', 0),
  ('Airtel', 'INTERNET', 'wifi', 'NONE', 0),
  ('Tigo', 'INTERNET', 'wifi', 'NONE', 0),
  ('Azam TV', 'TV', 'tv', 'FIXED', 2000),
  ('DStv', 'TV', 'tv', 'FIXED', 2000),
  ('NIDA', 'GOVERNMENT', 'building', 'NONE', 0),
  ('TRA', 'GOVERNMENT', 'building', 'NONE', 0)
ON CONFLICT DO NOTHING;

INSERT INTO insurance_products (name, description, category, premium_monthly, coverage_amount, waiting_period_days) VALUES
  ('Afya Bora', 'Bima ya afya inayoshughulikia gharama za matibabu.', 'HEALTH', 5000, 2000000, 30),
  ('Maisha Salama', 'Bima ya maisha kwa familia yako.', 'LIFE', 10000, 10000000, 0),
  ('Biashara Imara', 'Bima ya vifaa na bidhaa za biashara.', 'PROPERTY', 15000, 5000000, 14),
  ('Mazao Yangu', 'Bima ya mazao dhidi ya ukame na mafuriko.', 'CROP', 3000, 500000, 60)
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_qr_codes_user ON qr_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_qr_codes_code ON qr_codes(code);
CREATE INDEX IF NOT EXISTS idx_qr_payments_payer ON qr_payments(payer_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_user ON bill_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_airtime_purchases_user ON airtime_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_codes_user ON backup_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_savings_challenges_creator ON savings_challenges(creator_id);
CREATE INDEX IF NOT EXISTS idx_savings_challenge_members ON savings_challenge_members(challenge_id, user_id);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_user ON insurance_policies(user_id);
