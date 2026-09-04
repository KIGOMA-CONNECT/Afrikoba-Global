-- Migration 058: Multi-signature treasury wallets, proposals, and signers tables

CREATE TABLE IF NOT EXISTS treasury_wallets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  required_signatures INT DEFAULT 2,
  total_signers INT DEFAULT 3,
  balance NUMERIC(18,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS treasury_proposals (
  id SERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES treasury_wallets(id) ON DELETE CASCADE,
  proposer_id INT NOT NULL REFERENCES users(id),
  recipient_phone VARCHAR(30) NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, EXECUTED, REJECTED
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_treasury_prop_wallet ON treasury_proposals(wallet_id);
CREATE INDEX IF NOT EXISTS idx_treasury_prop_status ON treasury_proposals(status);

CREATE TABLE IF NOT EXISTS treasury_signatures (
  id SERIAL PRIMARY KEY,
  proposal_id INT NOT NULL REFERENCES treasury_proposals(id) ON DELETE CASCADE,
  signer_id INT NOT NULL REFERENCES users(id),
  signature_status VARCHAR(20) DEFAULT 'APPROVED', -- APPROVED, REJECTED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(proposal_id, signer_id)
);

CREATE INDEX IF NOT EXISTS idx_treasury_sig_prop ON treasury_signatures(proposal_id);
