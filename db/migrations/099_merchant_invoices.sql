-- Migration 099: Merchant Invoices
-- Merchants issue itemised invoices; customers settle them by code (INV-*)
-- through the canonical merchant payment path. Payment is idempotent per invoice.

CREATE TABLE IF NOT EXISTS merchant_invoices (
  id SERIAL PRIMARY KEY,
  merchant_id INT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL UNIQUE,          -- INV-XXXXXXXX
  customer_name VARCHAR(120),
  customer_phone VARCHAR(20),
  line_items JSONB DEFAULT '[]'::jsonb,      -- [{description, quantity, unit_price}]
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(8) NOT NULL DEFAULT 'TZS',
  note VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'ISSUED',   -- ISSUED | PAID | CANCELLED
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  paid_by INT REFERENCES users(id),
  transaction_reference VARCHAR(40),         -- MERCH-*/TR-* when paid
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_invoices_merchant ON merchant_invoices(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_invoices_status ON merchant_invoices(status, expires_at) WHERE status = 'ISSUED';