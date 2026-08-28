-- ============================================================
-- J-SERIES: VIRTUAL CARDS (Visa/Mastercard-style prepaid)
-- J1-J2: Issue & manage virtual cards (masked, limits, status)
-- J3: Purchase authorization (AUTH_HOLD on wallet)
-- J4: Merchant settlement | J5: Refunds (pre-settlement)
-- J6: Card statement & spend summary
-- ============================================================

-- NOTE: card_number ina hifadhiwa kwenye HASH tu (sha256). Masked
-- number ndiyo inayorejeshwa. CVV inarejeshwa mara moja pekee
-- wakati wa issuance (customers kupitia app yao).

CREATE TABLE IF NOT EXISTS virtual_cards (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheme VARCHAR(20) NOT NULL DEFAULT 'VISA', -- VISA, MASTERCARD, VERVE
  card_number_hash VARCHAR(64) NOT NULL UNIQUE,
  masked_number VARCHAR(24) NOT NULL,
  expiry_month VARCHAR(2) NOT NULL,
  expiry_year VARCHAR(4) NOT NULL,
  cvv_hash VARCHAR(64) NOT NULL,
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, FROZEN, BLOCKED
  daily_limit NUMERIC(15,2),
  per_txn_limit NUMERIC(15,2),
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS card_transactions (
  id SERIAL PRIMARY KEY,
  card_id INT NOT NULL REFERENCES virtual_cards(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_name VARCHAR(120) NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'AUTH_HOLD', -- AUTH_HOLD, SETTLED, REFUNDED
  auth_reference VARCHAR(40) NOT NULL UNIQUE,
  declined_reason VARCHAR(80),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_virtual_cards_user ON virtual_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_virtual_cards_status ON virtual_cards(user_id, status);
CREATE INDEX IF NOT EXISTS idx_card_txn_card ON card_transactions(card_id);
CREATE INDEX IF NOT EXISTS idx_card_txn_user ON card_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_card_txn_status ON card_transactions(card_id, status, created_at);