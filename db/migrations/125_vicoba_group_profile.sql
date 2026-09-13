-- 125_vicoba_group_profile.sql
-- VICOBA group profile: optional config shown/received at group creation.
-- All columns are ADDITIVE; existing financial model untouched.

ALTER TABLE vicoba_groups
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS group_type VARCHAR(30) NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS country VARCHAR(60) NOT NULL DEFAULT 'Tanzania',
  ADD COLUMN IF NOT EXISTS language VARCHAR(20) NOT NULL DEFAULT 'sw',
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'TZS',
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS min_shares INT,
  ADD COLUMN IF NOT EXISTS max_shares INT;