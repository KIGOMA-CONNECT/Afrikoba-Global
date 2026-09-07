-- SAR filing formalisation: FIU suspicious activity reporting trail.
-- Adds a filings table (audit: multiple filings allowed per case) and mirrors
-- the latest filing onto aml_cases for dashboard surface.
CREATE TABLE IF NOT EXISTS sar_filings (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES aml_cases(id) ON DELETE CASCADE,
  reference VARCHAR(80) NOT NULL,
  agency VARCHAR(60) NOT NULL DEFAULT 'FIU',
  summary TEXT,
  filed_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sar_filings_case ON sar_filings(case_id);
CREATE INDEX IF NOT EXISTS idx_sar_filings_created ON sar_filings(created_at);

ALTER TABLE aml_cases
  ADD COLUMN IF NOT EXISTS sar_reference VARCHAR(80),
  ADD COLUMN IF NOT EXISTS sar_agency VARCHAR(60),
  ADD COLUMN IF NOT EXISTS sar_filed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sar_filed_by INT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_aml_cases_sar_filed ON aml_cases(sar_filed_at) WHERE sar_filed_at IS NOT NULL;