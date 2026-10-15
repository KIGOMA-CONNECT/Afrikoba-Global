ALTER TABLE p2p_secondary_listings
  ADD COLUMN IF NOT EXISTS project_investment_id INTEGER NULL;

ALTER TABLE p2p_secondary_listings
  DROP CONSTRAINT IF EXISTS p2p_secondary_listings_project_investment_id_fkey;

ALTER TABLE p2p_secondary_listings
  ADD CONSTRAINT p2p_secondary_listings_project_investment_id_fkey
  FOREIGN KEY (project_investment_id)
  REFERENCES project_investments(id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_p2p_secondary_listings_project_investment
  ON p2p_secondary_listings(project_investment_id);

CREATE INDEX IF NOT EXISTS idx_p2p_secondary_listings_active_project_investment
  ON p2p_secondary_listings(project_investment_id)
  WHERE status = 'ACTIVE';
