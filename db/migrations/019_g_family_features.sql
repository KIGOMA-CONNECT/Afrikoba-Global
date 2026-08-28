-- G1: Family / shared wallets
CREATE TABLE IF NOT EXISTS family_wallets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  created_by INT NOT NULL REFERENCES users(id),
  currency VARCHAR(3) DEFAULT 'TZS',
  balance NUMERIC(15,2) DEFAULT 0,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS family_wallet_members (
  id SERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES family_wallets(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  role VARCHAR(20) DEFAULT 'MEMBER', -- OWNER, MEMBER
  can_spend BOOLEAN DEFAULT TRUE,
  spending_limit NUMERIC(15,2) DEFAULT 0, -- 0 = unlimited
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  joined_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'INVITED', -- INVITED, ACTIVE, REMOVED
  UNIQUE(wallet_id, user_id)
);

CREATE TABLE IF NOT EXISTS family_wallet_transactions (
  id SERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES family_wallets(id),
  actor_user_id INT REFERENCES users(id),
  counterparty_user_id INT REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL,
  type VARCHAR(20) NOT NULL, -- CONTRIBUTION, SPEND, TRANSFER_OUT, PAYOUT
  description VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- G2: Multi-currency balances
CREATE TABLE IF NOT EXISTS user_balances (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  currency_code VARCHAR(3) NOT NULL,
  balance NUMERIC(15,2) DEFAULT 0,
  UNIQUE(user_id, currency_code)
);

CREATE TABLE IF NOT EXISTS fx_rates (
  id SERIAL PRIMARY KEY,
  currency_code VARCHAR(3) NOT NULL UNIQUE,
  rate_to_tzs NUMERIC(15,6) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO fx_rates (currency_code, rate_to_tzs) VALUES
  ('TZS', 1.0), ('USD', 2600.0), ('EUR', 2800.0), ('KES', 18.5), ('UGX', 0.70), ('RWF', 2.1), ('GBP', 3200.0)
ON CONFLICT (currency_code) DO NOTHING;

-- G3: Biometric / device binding
CREATE TABLE IF NOT EXISTS user_devices (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  device_id VARCHAR(128) NOT NULL,
  device_name VARCHAR(100),
  biometric_token VARCHAR(255), -- hashed biometric/key reference
  challenge_nonce VARCHAR(128),
  nonce_expires TIMESTAMPTZ,
  last_used TIMESTAMPTZ,
  is_trusted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

-- G4: Offline queue
CREATE TABLE IF NOT EXISTS offline_operations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  op_type VARCHAR(30) NOT NULL, -- TRANSFER, BILL_PAYMENT, CASH_OUT, CONTRIBUTION
  payload JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'QUEUED', -- QUEUED, PROCESSED, FAILED
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  synced_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_offline_user ON offline_operations(user_id, status);

-- G5: Round-up savings
CREATE TABLE IF NOT EXISTS roundup_rules (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  savings_goal_id INT,
  is_active BOOLEAN DEFAULT TRUE,
  round_to NUMERIC(15,2) DEFAULT 1000, -- round up to nearest 1000
  total_roundup NUMERIC(15,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS roundup_log (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  transaction_id INT REFERENCES transactions(id),
  rounded_amount NUMERIC(15,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_family_wallets_created ON family_wallets(created_by);
CREATE INDEX IF NOT EXISTS idx_family_members_wallet ON family_wallet_members(wallet_id);
CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_wallet_members(user_id);
CREATE INDEX IF NOT EXISTS idx_user_balances_user ON user_balances(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_roundup_rules_user ON roundup_rules(user_id);
