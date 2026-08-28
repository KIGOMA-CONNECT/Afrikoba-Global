-- H1: Extend D8 business_accounts with banking fields (table exists from 015)
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS balance NUMERIC(15,2) DEFAULT 0;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TZS';
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS description TEXT;

-- H2: Payment links
CREATE TABLE IF NOT EXISTS payment_links (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  reference VARCHAR(40) UNIQUE NOT NULL,
  title VARCHAR(150) NOT NULL,
  currency VARCHAR(3) DEFAULT 'TZS',
  amount NUMERIC(15,2) NOT NULL,
  payer_user_id INT REFERENCES users(id),
  paid_amount NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, DISABLED, PAID
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

-- H3: Invoices (tax-aware - H9)
CREATE TABLE IF NOT EXISTS business_invoices (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  invoice_number VARCHAR(30) UNIQUE NOT NULL,
  customer_phone VARCHAR(30),
  customer_name VARCHAR(150),
  amount NUMERIC(15,2) NOT NULL,
  tax_percent NUMERIC(5,2) DEFAULT 0,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PAID, OVERDUE, CANCELLED
  due_date TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- H4: Products / inventory
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  sku VARCHAR(50),
  unit_price NUMERIC(15,2) NOT NULL,
  stock_quantity INT DEFAULT 0,
  low_stock_threshold INT DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- H5: Payroll
CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  period VARCHAR(20) NOT NULL,
  total_amount NUMERIC(15,2) NOT NULL,
  employee_count INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PROCESSED',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id SERIAL PRIMARY KEY,
  payroll_run_id INT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_phone VARCHAR(30),
  employee_name VARCHAR(150),
  amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PROCESSED'
);

-- H6: Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(30),
  total_paid NUMERIC(15,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  supplier_id INT REFERENCES suppliers(id),
  amount NUMERIC(15,2) NOT NULL,
  reference VARCHAR(40),
  status VARCHAR(20) DEFAULT 'PROCESSED',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- H7: analytics computed from invoices + payment links (no extra table).

-- H8: Business loans
CREATE TABLE IF NOT EXISTS business_loans (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  applicant_user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL,
  interest_rate NUMERIC(5,2) DEFAULT 10,
  term_months INT DEFAULT 12,
  due_amount NUMERIC(15,2) DEFAULT 0,
  paid_amount NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, DISBURSED, REJECTED, REPAID
  admin_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  disbursed_at TIMESTAMPTZ
);

-- H10: Staff uses D8 business_members (already exists from 015); add index.
CREATE INDEX IF NOT EXISTS idx_business_members_business ON business_members(business_id);
CREATE INDEX IF NOT EXISTS idx_business_members_user ON business_members(user_id);

-- H10: POS sessions
CREATE TABLE IF NOT EXISTS pos_sessions (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  cashier_user_id INT REFERENCES users(id),
  opening_cash NUMERIC(15,2) DEFAULT 0,
  closing_cash NUMERIC(15,2),
  sales_total NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, CLOSED
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_paylinks_business ON payment_links(business_id);
CREATE INDEX IF NOT EXISTS idx_invoices_business ON business_invoices(business_id);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON business_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_payroll_business ON payroll_runs(business_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_items(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_business ON suppliers(business_id);
CREATE INDEX IF NOT EXISTS idx_bizloans_business ON business_loans(business_id);
CREATE INDEX IF NOT EXISTS idx_bizloans_applicant ON business_loans(applicant_user_id);
CREATE INDEX IF NOT EXISTS idx_pos_business ON pos_sessions(business_id);