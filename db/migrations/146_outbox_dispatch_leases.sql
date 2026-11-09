-- 146 - Outbox dispatcher lease ownership and expiry.
-- The migration runner manages transaction boundaries.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outbox_processing_lease
  ON outbox_events (locked_until)
  WHERE status = 'PROCESSING';
