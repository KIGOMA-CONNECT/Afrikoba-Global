-- Migration 100: Support tickets compliance resolution audit
-- Adds resolved_at so support_resolved/closed timestamps (and SLA) can be
-- audited; backfills resolved_at for tickets already RESOLVED/CLOSED.

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

UPDATE support_tickets
SET resolved_at = COALESCE(resolved_at, NOW())
WHERE status IN ('RESOLVED', 'CLOSED') AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_support_tickets_resolved_at ON support_tickets(resolved_at);