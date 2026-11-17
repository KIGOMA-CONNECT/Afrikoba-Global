-- Migration 151: GOV-AN R4 — Immutable analytics snapshots
--
-- Purpose: Prevent ordinary UPDATE and DELETE operations against recorded
-- governance analytics snapshots, enforcing insert-only immutability at the
-- database level (in addition to application-level insert-only logic).
--
-- Logical snapshot identity: (group_type, group_id, snapshot_date)
-- The first successfully recorded snapshot becomes the permanent record.
--
-- IMPORTANT: This migration is a DRAFT. It has NOT been executed.
-- It requires separate authorization before application to any database.
-- It must be reviewed for compatibility with existing maintenance, retention
-- and administrative procedures before execution.
--
-- Trigger-based immutability limits:
-- - Triggers do not prevent operations by database owners or superusers
--   (unless additional controls such as row-level security or policy-based
--   access are implemented).
-- - Corrections to recorded snapshots require an audited dual-control workflow
--   (not implemented here). Any correction must be performed through a
--   separate, authorized, audited process.
-- - VACUUM and ANALYZE do not trigger row-level UPDATE/DELETE triggers.
-- - No automatic purge or retention deletion is included. If retention
--   policies are needed, they must be implemented separately with appropriate
--   authorization and audit controls.

-- Function: reject UPDATE and DELETE on governance_analytics
CREATE OR REPLACE FUNCTION gov_analytics_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'governance_analytics snapshots are immutable: % on (group_type=%, group_id=%, snapshot_date=%) is not permitted',
    TG_OP, OLD.group_type, OLD.group_id, OLD.snapshot_date
    USING ERRCODE = '42501';  -- insufficient_privilege
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger: fire before UPDATE or DELETE on governance_analytics
-- ENABLE ALWAYS: fires even when session_replication_role = replica
DROP TRIGGER IF EXISTS trg_gov_analytics_immutable ON governance_analytics;
CREATE TRIGGER trg_gov_analytics_immutable
  BEFORE UPDATE OR DELETE ON governance_analytics
  FOR EACH ROW
  EXECUTE FUNCTION gov_analytics_immutable();

ALTER TABLE governance_analytics
  ENABLE ALWAYS TRIGGER trg_gov_analytics_immutable;

-- Verify unique constraint exists on logical snapshot identity
-- (should already exist from migration 063; this is a safety check)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'governance_analytics'::regclass
      AND contype = 'u'
      AND conkey = (SELECT array_agg(attnum ORDER BY attnum) FROM pg_attribute
                    WHERE attrelid = 'governance_analytics'::regclass
                      AND attname IN ('group_type', 'group_id', 'snapshot_date'))
  ) THEN
    RAISE EXCEPTION 'Unique constraint on (group_type, group_id, snapshot_date) is missing';
  END IF;
END $$;

-- Rollback plan (for review only, not executed):
-- DROP TRIGGER IF EXISTS trg_gov_analytics_immutable ON governance_analytics;
-- DROP FUNCTION IF EXISTS gov_analytics_immutable();