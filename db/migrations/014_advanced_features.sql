-- C1: PIN reset tokens
CREATE TABLE IF NOT EXISTS pin_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(10) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- C3: Credit scores
CREATE TABLE IF NOT EXISTS credit_scores (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INT NOT NULL DEFAULT 500,
  factors JSONB DEFAULT '[]',
  last_calculated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- C4: Loan calculator presets
CREATE TABLE IF NOT EXISTS loan_products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  min_amount NUMERIC(15,2) NOT NULL,
  max_amount NUMERIC(15,2) NOT NULL,
  interest_rate NUMERIC(5,2) NOT NULL,
  min_term_months INT NOT NULL,
  max_term_months INT NOT NULL,
  eligibility_min_score INT DEFAULT 500,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO loan_products (name, min_amount, max_amount, interest_rate, min_term_months, max_term_months, eligibility_min_score) VALUES
  ('Micro Loan', 10000, 500000, 10.0, 1, 6, 400),
  ('Standard Loan', 500000, 5000000, 12.0, 3, 12, 500),
  ('Business Loan', 5000000, 50000000, 15.0, 6, 24, 600)
ON CONFLICT DO NOTHING;

-- C5: Bill splits
CREATE TABLE IF NOT EXISTS bill_splits (
  id SERIAL PRIMARY KEY,
  creator_id INT NOT NULL REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  total_amount NUMERIC(15,2) NOT NULL,
  split_count INT NOT NULL,
  per_person NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PARTIAL, COMPLETED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bill_split_participants (
  id SERIAL PRIMARY KEY,
  split_id INT NOT NULL REFERENCES bill_splits(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  amount_owed NUMERIC(15,2) NOT NULL,
  amount_paid NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PAID
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(split_id, user_id)
);

-- C6: Support tickets
CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  ticket_id VARCHAR(20) NOT NULL UNIQUE,
  category VARCHAR(50) NOT NULL, -- ACCOUNT, TRANSACTION, KYC, TECHNICAL, OTHER
  priority VARCHAR(20) DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH, URGENT
  subject VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, IN_PROGRESS, WAITING, RESOLVED, CLOSED
  assigned_to INT REFERENCES users(id),
  resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id INT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- C8: Push notification device tokens
CREATE TABLE IF NOT EXISTS push_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(500) NOT NULL,
  platform VARCHAR(20) NOT NULL, -- IOS, ANDROID, WEB
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token)
);

-- C9: KYC documents
CREATE TABLE IF NOT EXISTS kyc_documents (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type VARCHAR(50) NOT NULL, -- NATIONAL_ID, PASSPORT, DRIVERS_LICENSE, UTILITY_BILL, SELFIE
  file_url VARCHAR(500) NOT NULL,
  file_hash VARCHAR(64),
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED
  rejection_reason TEXT,
  verified_by INT REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  expires_at DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- C10: Merchants
CREATE TABLE IF NOT EXISTS merchants (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  business_type VARCHAR(50),
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merchant_payments (
  id SERIAL PRIMARY KEY,
  merchant_id INT NOT NULL REFERENCES merchants(id),
  payer_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL,
  reference VARCHAR(100),
  description VARCHAR(255),
  status VARCHAR(20) DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pin_reset_user ON pin_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_scores_user ON credit_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_bill_splits_creator ON bill_splits(creator_id);
CREATE INDEX IF NOT EXISTS idx_bill_split_participants_split ON bill_split_participants(split_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_active ON push_tokens(is_active);
CREATE INDEX IF NOT EXISTS idx_kyc_documents_user ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_merchants_phone ON merchants(phone);
CREATE INDEX IF NOT EXISTS idx_merchant_payments_merchant ON merchant_payments(merchant_id);
