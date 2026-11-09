-- 147 - Notification idempotency (Phase 71 / Step B).
-- A notification created on behalf of a source event (e.g. an outbox event)
-- carries source_event_reference; a replay of the same event for the same
-- user must not create a second notification.
-- Rows without a reference (legacy / direct callers) are unaffected: the
-- unique index is partial and NULLs never conflict.
-- The migration runner manages transaction boundaries (no BEGIN/COMMIT here).
-- Rollback: see docs/phase71-backlog.md (DROP INDEX, then DROP COLUMN).

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS source_event_reference VARCHAR(200);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_user_source_event_ref
  ON notifications (user_id, source_event_reference)
  WHERE source_event_reference IS NOT NULL;
