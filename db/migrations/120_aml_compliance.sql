-- 120_aml_compliance.sql
-- wallet_freezes: freeze/unfreeze user wallets for AML/sanctions compliance.
-- Enforced at the two primary wallet cash-out paths (P2P transfer + MNO withdrawal).

CREATE TABLE IF NOT EXISTS wallet_freezes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id INT REFERENCES aml_cases(id) ON DELETE SET NULL,
  reference VARCHAR(80) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  initiated_by INT NOT NULL REFERENCES users(id),
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifted_by INT REFERENCES users(id),
  lifted_at TIMESTAMPTZ,
  lifted_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_freezes_user_id ON wallet_freezes(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_freezes_active_user ON wallet_freezes(user_id) WHERE status = 'ACTIVE';
