-- ============================================
-- NOTIFICATIONS SYSTEM
-- ============================================

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(150) NOT NULL,
  body TEXT NOT NULL,
  type VARCHAR(30) NOT NULL DEFAULT 'INFO', -- INFO, TRANSACTION, VICOBA, ROSCA, P2P, SECURITY, PROMO
  channel VARCHAR(20) NOT NULL DEFAULT 'IN_APP', -- IN_APP, SMS, EMAIL, PUSH
  entity_type VARCHAR(50),
  entity_id INT,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_type ON notifications(user_id, type);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- User notification preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  sms_enabled BOOLEAN DEFAULT TRUE,
  email_enabled BOOLEAN DEFAULT FALSE,
  push_enabled BOOLEAN DEFAULT TRUE,
  transaction_alerts BOOLEAN DEFAULT TRUE,
  vicoba_alerts BOOLEAN DEFAULT TRUE,
  rosca_alerts BOOLEAN DEFAULT TRUE,
  p2p_alerts BOOLEAN DEFAULT TRUE,
  promo_alerts BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
