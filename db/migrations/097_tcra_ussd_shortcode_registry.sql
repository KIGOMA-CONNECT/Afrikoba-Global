-- ============================================================================
-- 097 TCRA USSD SHORTCODE REGISTRY
-- GAP: AFK-INST-13 TCRA USSD shortcode registration row (ACTION REQUIRED).
-- The USSD rails already exist (HMAC rails, ussdService, test-ussd). What is
-- missing is an in-system registry for the per-market shortcode + registration
-- status so Compliance can track filings and surface the posture like the
-- payment-licence matrix (089). The actual filing with the regulator is still
-- a manual compliance action; this migration + API make the state auditable.
--
--   * supported_countries gains ussd_shortcode (the dial string) and
--     ussd_shortcode_status (PENDING -> APPROVED), constrained.
--   * TZ seeded with the working shortcode; status PENDING until the TCRA
--     filing is granted (admin flips it via PUT /api/admin/countries/:id).
--   * No data moves, no drops; additive only.
-- ============================================================================

ALTER TABLE supported_countries
  ADD COLUMN IF NOT EXISTS ussd_shortcode VARCHAR(16),
  ADD COLUMN IF NOT EXISTS ussd_shortcode_status VARCHAR(20) NOT NULL DEFAULT 'PENDING';

-- Registration lifecycle: not yet filed / filed-pending / granted.
ALTER TABLE supported_countries DROP CONSTRAINT IF EXISTS supported_countries_ussd_status_check;
ALTER TABLE supported_countries ADD CONSTRAINT supported_countries_ussd_status_check
  CHECK (ussd_shortcode_status IN ('PENDING','APPROVED'));

-- Tanzania: shortcode dial string applied for; filing tracking starts PENDING.
UPDATE supported_countries SET
  ussd_shortcode = CASE code
    WHEN 'TZ' THEN '*150*87'
    ELSE ussd_shortcode END
WHERE code = 'TZ';