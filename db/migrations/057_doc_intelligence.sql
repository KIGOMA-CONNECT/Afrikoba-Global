-- Migration 057: AI Document Intelligence parser & extracted project data tables

CREATE TABLE IF NOT EXISTS project_documents (
  id SERIAL PRIMARY KEY,
  project_id INT,
  doc_type VARCHAR(50) NOT NULL, -- BOQ, PROPOSAL, QUOTATION, CONTRACT, FINANCIAL_STATEMENT
  file_name TEXT NOT NULL,
  extracted_data JSONB DEFAULT '{}',
  confidence_score NUMERIC(5,2) DEFAULT 85.00,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_docs_proj ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_project_docs_type ON project_documents(doc_type);
