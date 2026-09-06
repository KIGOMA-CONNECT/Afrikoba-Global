-- ============================================================
-- 086 - Kilimo farm seasons, harvest/yield tracking, agronomist advisories
-- ============================================================

CREATE TABLE IF NOT EXISTS farm_seasons (
  id SERIAL PRIMARY KEY,
  farm_id INT NOT NULL REFERENCES farm_profiles(id) ON DELETE CASCADE,
  season_name VARCHAR(150) NOT NULL,
  planting_date DATE,
  expected_harvest_date DATE,
  crop VARCHAR(100),
  area_acres NUMERIC(8,2),
  expected_yield_tons NUMERIC(10,2) DEFAULT 0.00,
  actual_yield_tons NUMERIC(10,2) DEFAULT 0.00,
  sale_amount NUMERIC(14,2) DEFAULT 0.00,
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, COMPLETED, CANCELLED
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agri_advisories (
  id SERIAL PRIMARY KEY,
  season_id INT REFERENCES farm_seasons(id) ON DELETE CASCADE,
  farm_id INT NOT NULL REFERENCES farm_profiles(id) ON DELETE CASCADE,
  agronomist_user_id INT NOT NULL REFERENCES users(id),
  category VARCHAR(50) NOT NULL, -- CROP_CARE, IRRIGATION, SOIL, PESTS, FERTILIZER, MARKET
  title VARCHAR(200) NOT NULL,
  advice TEXT NOT NULL,
  action_due_date DATE,
  status VARCHAR(20) DEFAULT 'ISSUED', -- ISSUED, ACTIONED, EXPIRED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farm_seasons_farm ON farm_seasons(farm_id);
CREATE INDEX IF NOT EXISTS idx_farm_seasons_status ON farm_seasons(status);
CREATE INDEX IF NOT EXISTS idx_agri_advisories_farm ON agri_advisories(farm_id);
CREATE INDEX IF NOT EXISTS idx_agri_advisories_season ON agri_advisories(season_id);
CREATE INDEX IF NOT EXISTS idx_agri_advisories_agronomist ON agri_advisories(agronomist_user_id);