-- ============================================================================
-- 123 SANCTIONS WATCHLIST & SCREENING HITS
-- Adds OFAC/UN/EU-style sanctions screening on money-exit paths.
-- sanctions_watchlist: admin-managed entries (source, name, phone, doc).
-- sanctions_screening_hits: per-screen audit trail with disposition workflow.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sanctions_watchlist (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,                          -- OFAC / UN / EU / TZ_FIU / INTERPOL / PEER
  category TEXT NOT NULL DEFAULT 'INDIVIDUAL',   -- INDIVIDUAL / ENTITY
  full_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,                 -- lowercased, diacritics stripped
  phone_number TEXT,                             -- E.164 preferred
  document_type TEXT,                            -- NIDA / PASSPORT / DRIVING_LICENSE
  document_number TEXT,
  country_code TEXT,                             -- ISO3166 alpha-2
  birth_date DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',         -- ACTIVE / REMOVED
  reference TEXT,                                -- external regulator reference
  notes TEXT,
  created_by INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sanctions_watchlist_status ON sanctions_watchlist(status);
CREATE INDEX IF NOT EXISTS idx_sanctions_watchlist_source ON sanctions_watchlist(source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sanctions_watchlist_doc
  ON sanctions_watchlist (document_type, document_number)
  WHERE document_type IS NOT NULL AND document_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS sanctions_screening_hits (
  id SERIAL PRIMARY KEY,
  watchlist_id INT REFERENCES sanctions_watchlist(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,                    -- USER / BENEFICIARY / MERCHANT / PAYROLL_ENTRY / MANUAL
  subject_id INT,
  subject_name TEXT,
  subject_phone TEXT,
  matched_field TEXT NOT NULL,                   -- full_name / phone / document
  match_score NUMERIC(5,2) NOT NULL,            -- 0.00 – 100.00
  severity TEXT NOT NULL DEFAULT 'HIGH',         -- LOW / MEDIUM / HIGH / CRITICAL
  disposition TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING / CONFIRMED / FALSE_POSITIVE
  decided_by INT,
  decided_at TIMESTAMPTZ,
  case_id INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sanctions_hits_disposition ON sanctions_screening_hits(disposition);
CREATE INDEX IF NOT EXISTS idx_sanctions_hits_subject ON sanctions_screening_hits(subject_type, subject_id);
