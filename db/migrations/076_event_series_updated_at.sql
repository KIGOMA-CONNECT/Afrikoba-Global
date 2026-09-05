-- Afrikoba Global - Social Events Stage 4 fix
-- event_series is missing the standard updated_at column used by updateEventSeries
-- and generateNextEventFromSeries.
ALTER TABLE event_series ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();