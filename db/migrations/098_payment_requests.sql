-- Migration 098: Payment Requests (request-to-pay)
-- A user (requester) asks another user (payer, by phone) for money.
-- The payer accepts by paying through the canonical wallet transfer path.

CREATE TABLE IF NOT EXISTS payment_requests (
  id SERIAL PRIMARY KEY,
  requester_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payer_id INT REFERENCES users(id),       -- resolved at creation from payer_phone
  payer_phone VARCHAR(20) NOT NULL,        -- canonical East-African phone format
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  note VARCHAR(255),
  reference VARCHAR(40) NOT NULL UNIQUE,   -- PRQ-XXXXXXXX
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',  -- PENDING | PAID | CANCELLED | EXPIRED
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  transaction_reference VARCHAR(40),       -- set when paid (TR-XXXXXXXX)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_requester ON payment_requests(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_payer ON payment_requests(payer_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_due ON payment_requests(status, expires_at) WHERE status = 'PENDING';