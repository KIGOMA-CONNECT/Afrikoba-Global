-- Stage 5 (Events): deadline reminders, member-wide upcoming sweep, overdue commitments

-- Widen reminder type to cover contribution-deadline nudges.
ALTER TABLE event_reminders DROP CONSTRAINT event_reminders_type_check;
ALTER TABLE event_reminders ADD CONSTRAINT event_reminders_type_check
  CHECK (type IN ('COMMITMENT_DUE','EVENT_UPCOMING','DEADLINE','SAVINGS_SESSION'));

-- Dedup support for member-scoped reminders.
CREATE INDEX IF NOT EXISTS idx_event_reminders_user
  ON event_reminders(event_id, user_id, type, sent_date);