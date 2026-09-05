-- Afrikoba Global - Social Events Stage 4 fix
-- event_members (created in 074) lacks the standard updated_at column used
-- by joinEventByPublicLink's upsert.
ALTER TABLE event_members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();