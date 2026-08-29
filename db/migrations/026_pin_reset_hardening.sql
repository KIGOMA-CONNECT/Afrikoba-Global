-- 026_pin_reset_hardening.sql
-- PIN reset "forgot PIN" flow:
--  - token VARCHAR(10) → VARCHAR(128): resetKey (64 hex chars) hapo awali
--    haikutoshea kwenye column hii → verify iliporomoka (500).
--  - attempts: kukinga brute-force ya token ya namba 6 (marudio ≥5 →
--    token inabatilishwa).
ALTER TABLE pin_reset_tokens
  ALTER COLUMN token TYPE VARCHAR(128),
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;