-- =====================================================
-- MIGRATION 001: SERVICE SUBSCRIPTIONS & GROUP JOIN CODES
-- International-standard access control (subscription model)
-- =====================================================

-- 1. User Service Subscriptions (product catalog pattern)
CREATE TABLE IF NOT EXISTS user_service_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_key VARCHAR(30) NOT NULL, -- WALLET, VICOBA, ROSCA, P2P
    status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, SUSPENDED
    subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, service_key)
);
CREATE INDEX IF NOT EXISTS idx_user_service_user ON user_service_subscriptions(user_id);

-- 2. VICOBA group join code
ALTER TABLE vicoba_groups ADD COLUMN IF NOT EXISTS join_code VARCHAR(12) UNIQUE;

-- 3. VICOBA invitations (chairman invites members via SMS -> they accept)
CREATE TABLE IF NOT EXISTS vicoba_invites (
    id SERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
    phone_number VARCHAR(15) NOT NULL,
    status VARCHAR(20) DEFAULT 'SENT', -- SENT, ACCEPTED, EXPIRED
    joined_user_id INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vicoba_invites_phone ON vicoba_invites(phone_number, status);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_vicoba_invites_group_phone') THEN
    ALTER TABLE vicoba_invites ADD CONSTRAINT uq_vicoba_invites_group_phone UNIQUE (group_id, phone_number);
  END IF;
END $$;

-- Backfill: every existing user already has the WALLET service
INSERT INTO user_service_subscriptions (user_id, service_key)
SELECT id, 'WALLET' FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM user_service_subscriptions s
    WHERE s.user_id = u.id AND s.service_key = 'WALLET'
);

-- Backfill: demo users already use the other services (keep tests working)
INSERT INTO user_service_subscriptions (user_id, service_key)
SELECT u.id, s.service_key
FROM users u
CROSS JOIN (VALUES ('VICOBA'), ('ROSCA'), ('P2P')) AS s(service_key)
WHERE u.phone_number IN (
    '255712000001', '255713100001', '255714100002',
    '255715100003', '255716100004'
)
AND NOT EXISTS (
    SELECT 1 FROM user_service_subscriptions x
    WHERE x.user_id = u.id AND x.service_key = s.service_key
);
