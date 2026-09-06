-- ============================================================
-- 083: KYC SCHEMA ALIGNMENT
-- The kyc_documents table in db/schema.sql uses document_url and
-- predates migration 014 (whose CREATE TABLE was a no-op against
-- an existing table). This migration idempotently adds the columns
-- the KYC lifecycle workflow relies on, regardless of bootstrap path.
-- ============================================================

ALTER TABLE kyc_documents
  ADD COLUMN IF NOT EXISTS document_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS file_hash TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS expires_at DATE,
  ADD COLUMN IF NOT EXISTS document_number TEXT,
  ADD COLUMN IF NOT EXISTS issued_country VARCHAR(64) DEFAULT 'TZ',
  ADD COLUMN IF NOT EXISTS submitted_via VARCHAR(20) DEFAULT 'WEB',
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewer_note TEXT;