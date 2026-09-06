-- ============================================================
-- 082: KYC LIFECYCLE ENHANCEMENTS + ADDITIONAL FOUR-EYES POLICIES
-- 1) Extends kyc_documents with biographic/review fields for the
--    full KYC workflow (upload -> profile -> review -> level bump).
-- 2) Seeds four-eyes policies for VICOBA / card / high-value loan
--    disbursement dual-control operations.
-- ============================================================

-- ---------- KYC lifecycle ----------
ALTER TABLE kyc_documents
  ADD COLUMN IF NOT EXISTS document_number TEXT,
  ADD COLUMN IF NOT EXISTS issued_country VARCHAR(64) DEFAULT 'TZ',
  ADD COLUMN IF NOT EXISTS submitted_via VARCHAR(20) DEFAULT 'WEB',
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewer_note TEXT;

-- KYC-level per-type requirement map (level 2 = ID verified)
COMMENT ON COLUMN kyc_documents.issued_country IS 'Country that issued the document (default TZ)';
COMMENT ON COLUMN kyc_documents.submitted_via IS 'WEB | MOBILE | BRANCH';

-- ---------- Additional four-eyes policies ----------
INSERT INTO four_eyes_policies (action_code, description, required_approvers, approver_roles, enabled, allow_self_approve) VALUES
  ('VICOBA_LOAN_DISBURSE',            'Kutoa mkopo wa kikundi (VICOBA) kwa idhini ya four-eyes',        1, ARRAY['ADMIN'], true, false),
  ('VICOBA_SOCIAL_FUND_DISBURSE',     'Kutoa msaada wa social fund kwa idhini ya four-eyes',            1, ARRAY['ADMIN'], true, false),
  ('CARD_ADMIN_SETTLE',               'Settlement ya card authorization (admin-run)',                   1, ARRAY['ADMIN'], true, false),
  ('CARD_ADMIN_REFUND',               'Refund ya card authorization (admin-run)',                       1, ARRAY['ADMIN'], true, false),
  ('CREDIT_LOAN_DISBURSE',            'Kutoa mkopo wa mkoko (micro/credit) kwa idhini ya four-eyes',    1, ARRAY['ADMIN'], true, false),
  ('BUSINESS_LOAN_DISBURSE',          'Kutoa mkopo wa biashara kwa idhini ya four-eyes',                1, ARRAY['ADMIN'], true, false)
ON CONFLICT (action_code) DO NOTHING;