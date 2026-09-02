-- ============================================================
-- AFRIKOBA PHASE 18: MARKETPLACE DELIVERY EVIDENCE
--                        & ESCROW DISPUTE RESOLUTION
-- 1) Sellers attach delivery evidence to an escrowed order so the
--    buyer can verify before confirming (escrow settlement).
-- 2) Buyers open escrow disputes on ESCROW_HELD orders. The dispute
--    freezes confirm/cancel; an ADMIN ruling moves the escrow.
-- 3) Marketplace disputes live in the shared `disputes` table, linked
--    to the order - banking disputes (transaction_id) are unchanged.
-- ============================================================

-- Delivery evidence on the order (visible to the buyer pre-confirm).
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS evidence_urls TEXT[] DEFAULT '{}';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS evidence_note TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS evidence_at TIMESTAMPTZ;

-- Marketplace escrow disputes share the disputes table.
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS marketplace_order_id INT REFERENCES marketplace_orders(id);
CREATE INDEX IF NOT EXISTS idx_disputes_marketplace_order ON disputes(marketplace_order_id);

-- At most one open/under-review escrow dispute per order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_disputes_marketplace_open
  ON disputes(marketplace_order_id)
  WHERE marketplace_order_id IS NOT NULL AND status IN ('OPEN','UNDER_REVIEW');