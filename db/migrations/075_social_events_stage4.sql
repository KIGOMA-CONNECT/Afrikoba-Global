-- Afrikoba Global - Social Events Stage 4
-- (a) Public shareable event pages + join-by-link
ALTER TABLE social_events ADD COLUMN IF NOT EXISTS public_token VARCHAR(64);
ALTER TABLE social_events ADD COLUMN IF NOT EXISTS public_share_enabled BOOLEAN NOT NULL DEFAULT TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_events_public_token ON social_events(public_token) WHERE public_token IS NOT NULL;

UPDATE social_events SET public_token = md5(random()::text || clock_timestamp()::text) WHERE public_token IS NULL;

-- (b) Event templates (reusable setups including budget items)
CREATE TABLE IF NOT EXISTS event_templates (
  id SERIAL PRIMARY KEY,
  organizer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  event_type VARCHAR(40) NOT NULL DEFAULT 'OTHER',
  owner_type VARCHAR(40) NOT NULL DEFAULT 'INDIVIDUAL',
  target_amount NUMERIC(15,2),
  description TEXT,
  rules JSONB NOT NULL DEFAULT '{}',
  savings_cadence VARCHAR(20),
  savings_session_amount NUMERIC(15,2),
  budget_items JSONB NOT NULL DEFAULT '[]',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_templates_organizer ON event_templates(organizer_id);

-- (c) Recurring event series
ALTER TABLE social_events ADD COLUMN IF NOT EXISTS series_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_social_events_series ON social_events(series_id);

CREATE TABLE IF NOT EXISTS event_series (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES event_templates(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  cadence VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
  day_of_month INTEGER,
  day_of_week INTEGER,
  event_type VARCHAR(40) NOT NULL DEFAULT 'OTHER',
  target_amount NUMERIC(15,2),
  rules JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at DATE,
  last_event_id INTEGER,
  events_generated INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_series_owner ON event_series(owner_id);
CREATE INDEX IF NOT EXISTS idx_event_series_due ON event_series(next_run_at) WHERE active AND next_run_at IS NOT NULL;