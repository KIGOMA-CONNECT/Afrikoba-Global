-- ============================================================
-- 092 DEVICE SECURITY & ANTI-FRAUD BINDING
-- Per-user device policy gates money movement on trusted devices:
--   PERMISSIVE    -> default; devices recorded, alerts only
--   TRUSTED_ONLY  -> transfer/withdraw blocked unless the caller's
--                    device fingerprint is registered + trusted
-- trusted_devices gains an explicit is_trusted flag so any device
-- can be revoked without deleting its history.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS device_policy VARCHAR(20) DEFAULT 'PERMISSIVE';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS chk_users_device_policy;
ALTER TABLE users
  ADD CONSTRAINT chk_users_device_policy
  CHECK (device_policy IN ('PERMISSIVE', 'TRUSTED_ONLY'));

ALTER TABLE trusted_devices
  ADD COLUMN IF NOT EXISTS is_trusted BOOLEAN DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_trusted_devices_active
  ON trusted_devices(user_id, is_active, is_trusted);