-- ============================================================
-- SACCOS DIGITAL CORE - LENDING PRODUCTS (increment 19)
-- OWNER/BOARD-defined lending products so a SACCOS can issue
-- loans against a named product (fixed rate / tenor / amount
-- band) instead of only the flat saccos-wide `lending` config.
--
-- A member applies with an optional `productId`; the product's
-- min_amount / max_amount / max_term_months gate the request and
-- its interest_rate_percent becomes the loan's flat rate at
-- approval (snapshotted onto the loan + application rows) while
-- every downstream flow (repayments, installments, restructure,
-- arrears) keeps using the loan's own interest_rate - no change.
--
-- ARCHIVED products are kept for audit but can no longer be
-- picked at application time.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_lending_products (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  interest_rate_percent NUMERIC(6,2) NOT NULL CHECK (interest_rate_percent >= 0 AND interest_rate_percent <= 100),
  min_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  max_amount NUMERIC(15,2) CHECK (max_amount IS NULL OR max_amount > 0),
  max_term_months INT NOT NULL CHECK (max_term_months BETWEEN 1 AND 120),
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (saccos_id, code)
);
CREATE INDEX IF NOT EXISTS idx_saccos_lending_products_saccos
  ON saccos_lending_products(saccos_id, status);

-- Snap the product onto the application (rate used at approval) and the loan
-- (rate + product provenance visible for the life of the facility).
ALTER TABLE saccos_loan_applications
  ADD COLUMN IF NOT EXISTS product_id INT REFERENCES saccos_lending_products(id);
ALTER TABLE saccos_loan_applications
  ADD COLUMN IF NOT EXISTS rate_percent NUMERIC(6,2);
ALTER TABLE saccos_loans
  ADD COLUMN IF NOT EXISTS product_id INT REFERENCES saccos_lending_products(id);
CREATE INDEX IF NOT EXISTS idx_saccos_loans_product
  ON saccos_loans(saccos_id, product_id);