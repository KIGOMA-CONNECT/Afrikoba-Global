-- ============================================
-- TOTP 2FA - Time-based One-Time Password
-- ============================================
-- Optional 2FA beyond SMS OTP for high-security operations.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_verified_at TIMESTAMP;
