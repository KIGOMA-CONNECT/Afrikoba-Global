-- Migration 069: P2P Secondary Market, Auto-Invest, Kiva Lending Circles, and Kilimo Agri-Finance

-- ===== 1. P2P SECONDARY MARKET & AUTO-INVEST =====
CREATE TABLE IF NOT EXISTS p2p_secondary_listings (
  id SERIAL PRIMARY KEY,
  seller_user_id INT NOT NULL REFERENCES users(id),
  investment_id INT NOT NULL REFERENCES investments(id),
  shares_for_sale INT NOT NULL CHECK (shares_for_sale > 0),
  price_per_share NUMERIC(15,2) NOT NULL CHECK (price_per_share > 0),
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, SOLD, CANCELLED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS p2p_secondary_bids (
  id SERIAL PRIMARY KEY,
  listing_id INT NOT NULL REFERENCES p2p_secondary_listings(id) ON DELETE CASCADE,
  buyer_user_id INT NOT NULL REFERENCES users(id),
  bid_price_per_share NUMERIC(15,2) NOT NULL CHECK (bid_price_per_share > 0),
  shares_requested INT NOT NULL CHECK (shares_requested > 0),
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, ACCEPTED, REJECTED, CANCELLED
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS p2p_auto_invest_rules (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  enabled BOOLEAN DEFAULT TRUE,
  min_roi_percentage NUMERIC(5,2) DEFAULT 10.00,
  preferred_sectors TEXT[] DEFAULT ARRAY['AGRICULTURE', 'TECHNOLOGY', 'RETAIL', 'ENERGY'],
  max_amount_per_project NUMERIC(15,2) NOT NULL DEFAULT 100000.00,
  budget_cap NUMERIC(15,2) NOT NULL DEFAULT 1000000.00,
  total_auto_invested NUMERIC(15,2) DEFAULT 0.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 2. KIVA-STYLE LENDING CIRCLES & CROWDFUNDING =====
CREATE TABLE IF NOT EXISTS field_partners (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  country_code VARCHAR(10) DEFAULT 'TZ',
  region VARCHAR(100),
  risk_rating VARCHAR(10) DEFAULT 'LOW', -- LOW, MEDIUM, HIGH
  trust_score NUMERIC(5,2) DEFAULT 80.00,
  total_loans_facilitated NUMERIC(15,2) DEFAULT 0.00,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lending_circles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  leader_user_id INT NOT NULL REFERENCES users(id),
  field_partner_id INT REFERENCES field_partners(id),
  description TEXT,
  location VARCHAR(150),
  impact_category VARCHAR(50) DEFAULT 'COMMUNITY', -- WOMEN_EMPOWERMENT, SMALL_FARMER, YOUTH, COMMUNITY
  guarantee_percentage NUMERIC(5,2) DEFAULT 100.00,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lending_circle_members (
  id SERIAL PRIMARY KEY,
  circle_id INT NOT NULL REFERENCES lending_circles(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  role VARCHAR(20) DEFAULT 'MEMBER', -- LEADER, MEMBER, GUARANTOR
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(circle_id, user_id)
);

CREATE TABLE IF NOT EXISTS crowdfund_campaigns (
  id SERIAL PRIMARY KEY,
  circle_id INT REFERENCES lending_circles(id),
  borrower_user_id INT NOT NULL REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  story TEXT,
  target_amount NUMERIC(15,2) NOT NULL CHECK (target_amount > 0),
  raised_amount NUMERIC(15,2) DEFAULT 0.00,
  term_months INT DEFAULT 12,
  interest_rate NUMERIC(5,2) DEFAULT 0.00,
  status VARCHAR(20) DEFAULT 'FUNDING', -- FUNDING, FULLY_FUNDED, DISBURSED, REPAID, DEFAULTED
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crowdfund_contributions (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES crowdfund_campaigns(id) ON DELETE CASCADE,
  lender_user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 3. KILIMO (AGRI-FINANCE) =====
CREATE TABLE IF NOT EXISTS farm_profiles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  farm_name VARCHAR(150) NOT NULL,
  region VARCHAR(100) NOT NULL,
  district VARCHAR(100),
  size_acres NUMERIC(8,2) NOT NULL CHECK (size_acres > 0),
  primary_crop VARCHAR(100) NOT NULL,
  irrigation_type VARCHAR(50) DEFAULT 'RAIN_FED',
  expected_harvest_date DATE,
  historical_yield_tons NUMERIC(8,2) DEFAULT 0.00,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agri_input_suppliers (
  id SERIAL PRIMARY KEY,
  supplier_name VARCHAR(150) NOT NULL,
  category VARCHAR(50) NOT NULL, -- SEEDS, FERTILIZER, EQUIPMENT, PESTICIDES
  phone_number VARCHAR(30),
  verified BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agri_loans (
  id SERIAL PRIMARY KEY,
  farm_id INT NOT NULL REFERENCES farm_profiles(id) ON DELETE CASCADE,
  borrower_user_id INT NOT NULL REFERENCES users(id),
  supplier_id INT REFERENCES agri_input_suppliers(id),
  loan_type VARCHAR(50) DEFAULT 'INPUT_FINANCING', -- INPUT_FINANCING, HARVEST_CYCLE, EQUIPMENT
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  grace_period_months INT DEFAULT 3,
  tenure_months INT DEFAULT 6,
  interest_rate NUMERIC(5,2) DEFAULT 8.00,
  repayment_due_date DATE,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, DISBURSED, REPAID, OVERDUE
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agri_offtake_agreements (
  id SERIAL PRIMARY KEY,
  agri_loan_id INT NOT NULL REFERENCES agri_loans(id) ON DELETE CASCADE,
  offtaker_name VARCHAR(150) NOT NULL,
  agreed_price_per_kg NUMERIC(12,2) NOT NULL,
  committed_quantity_kg NUMERIC(12,2) NOT NULL,
  contract_url TEXT,
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, FULFILLED, DEFAULTED
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial agri suppliers & field partners
INSERT INTO agri_input_suppliers (supplier_name, category, phone_number, verified) VALUES
  ('Yara Tanzania Fertilizers', 'FERTILIZER', '+255700000101', TRUE),
  ('Simba Seeds Corporation', 'SEEDS', '+255700000102', TRUE),
  ('Kilimo Bora Machinery', 'EQUIPMENT', '+255700000103', TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO field_partners (name, country_code, region, risk_rating, trust_score) VALUES
  ('Tanzania Women Farmers Initiative (TWFI)', 'TZ', 'Morogoro', 'LOW', 92.50),
  ('Kilimanjaro Agro-Cooperative Union', 'TZ', 'Kilimanjaro', 'LOW', 88.00)
ON CONFLICT DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_p2p_sec_listing_status ON p2p_secondary_listings(status);
CREATE INDEX IF NOT EXISTS idx_p2p_sec_bids_listing ON p2p_secondary_bids(listing_id);
CREATE INDEX IF NOT EXISTS idx_crowdfund_campaigns_status ON crowdfund_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_agri_loans_user ON agri_loans(borrower_user_id);
