-- Migration 124: M-Koba merge - VICOBA withdrawals, bonus, group transactions
-- Mirrors M-Koba GROUP WITHDRAWS / BONUS / SHARE-LOAN-SOCIAL book support

-- ==========================================
-- GROUP WITHDRAWALS (Mwenyekiti + Mwekahazina signature then member wallet credit)
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_withdrawals (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, DISBURSED, REJECTED
  chairman_id INTEGER REFERENCES users(id),
  chairman_note TEXT,
  chairman_at TIMESTAMP,
  treasurer_id INTEGER REFERENCES users(id),
  treasurer_note TEXT,
  treasurer_at TIMESTAMP,
  reference_id VARCHAR(30) UNIQUE,
  disbursed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vicoba_withdrawals_group ON vicoba_withdrawals(group_id, status);
CREATE INDEX IF NOT EXISTS idx_vicoba_withdrawals_user ON vicoba_withdrawals(user_id);

-- ==========================================
-- BONUS (M-Koba BONUS ledger line - e.g. interest income topped into the group)
-- ==========================================
CREATE TABLE IF NOT EXISTS vicoba_bonus (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES vicoba_groups(id) ON DELETE CASCADE,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  purpose TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vicoba_bonus_group ON vicoba_bonus(group_id);