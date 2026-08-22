-- ============================================
-- REFERRAL SYSTEM
-- ============================================

CREATE TABLE IF NOT EXISTS referral_codes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  code VARCHAR(20) UNIQUE NOT NULL,
  total_referrals INT DEFAULT 0,
  total_earned NUMERIC(15, 2) DEFAULT 0.00,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_user_id INT NOT NULL REFERENCES users(id),
  referred_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_code VARCHAR(20) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, COMPLETED, REWARDED
  reward_amount NUMERIC(15, 2) DEFAULT 0.00,
  rewarded_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(referred_user_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- ============================================
-- ANALYTICS / EVENT TRACKING
-- ============================================

CREATE TABLE IF NOT EXISTS analytics_events (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  event_type VARCHAR(50) NOT NULL, -- LOGIN, REGISTER, DEPOSIT, WITHDRAWAL, TRANSFER, INVEST, VICOBA_JOIN, etc.
  event_data JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_type_created ON analytics_events(event_type, created_at DESC);

-- ============================================
-- SETTINGS (system-wide configuration)
-- ============================================

CREATE TABLE IF NOT EXISTS system_settings (
  id SERIAL PRIMARY KEY,
  setting_key VARCHAR(100) UNIQUE NOT NULL,
  setting_value TEXT,
  description TEXT,
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('referral_reward_amount', '5000', 'Reward amount per successful referral (TSh)'),
  ('referral_min_deposit', '10000', 'Minimum deposit to trigger referral reward'),
  ('max_referral_depth', '2', 'Maximum referral chain depth'),
  ('maintenance_mode', 'false', 'System maintenance mode toggle')
ON CONFLICT (setting_key) DO NOTHING;
