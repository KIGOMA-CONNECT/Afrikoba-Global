-- Migration 065: AI Budget / BOQ Analysis
-- Analyzes project BOQs, budgets, and quotations against reference market rates,
-- detects cost anomalies and overpricing, and produces budget health assessments
-- with confidence-scored recommendations.

-- Reference market rates per line-item category
CREATE TABLE IF NOT EXISTS ai_market_rates (
  id SERIAL PRIMARY KEY,
  category VARCHAR(60) NOT NULL,
  unit VARCHAR(30),
  reference_rate NUMERIC(18,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'TZS',
  source VARCHAR(60),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(category, unit)
);

-- Budget/BOQ analysis snapshots
CREATE TABLE IF NOT EXISTS ai_budget_analyses (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES project_decompositions(id) ON DELETE CASCADE,
  document_id INT REFERENCES project_documents(id),
  total_budget NUMERIC(18,2) NOT NULL,
  market_reference_total NUMERIC(18,2),
  variance NUMERIC(18,2),
  variance_percent NUMERIC(6,2),
  budget_health VARCHAR(20) NOT NULL,           -- HEALTHY, OVERPRICED, UNDERPRICED, WATCH
  confidence NUMERIC(5,2) NOT NULL,
  line_items JSONB DEFAULT '[]'::jsonb,          -- analyzed line items with anomaly flags
  recommendations JSONB DEFAULT '[]'::jsonb,
  model_version VARCHAR(30) DEFAULT 'afri-boq-1.0',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_budget_proj ON ai_budget_analyses(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_budget_doc ON ai_budget_analyses(document_id);

-- Seed reference market rates
INSERT INTO ai_market_rates (category, unit, reference_rate, currency, source)
VALUES
  ('Foundation & Excavation', 'lump', 12000000, 'TZS', 'BOT sector benchmark'),
  ('Structural Steel & Concrete', 'm2', 750000, 'TZS', 'BOT sector benchmark'),
  ('Labor & Supervision', 'lump', 9000000, 'TZS', 'BOT sector benchmark'),
  ('Masonry & Blockwork', 'm2', 85000, 'TZS', 'BOT sector benchmark'),
  ('Roofing', 'm2', 95000, 'TZS', 'BOT sector benchmark'),
  ('Electrical Installation', 'point', 120000, 'TZS', 'BOT sector benchmark'),
  ('Plumbing', 'point', 95000, 'TZS', 'BOT sector benchmark'),
  ('Finishing / Painting', 'm2', 22000, 'TZS', 'BOT sector benchmark')
ON CONFLICT (category, unit) DO NOTHING;
