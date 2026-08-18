-- OTP brute-force protection: max 5 attempts per OTP code
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;
