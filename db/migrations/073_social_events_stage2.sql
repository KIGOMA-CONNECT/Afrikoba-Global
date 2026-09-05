-- =====================================================================
-- 073_social_events_stage2.sql
-- AFRIKOBA SOCIAL EVENTS & CONTRIBUTION ENGINE — Stage 2
-- Collaborative savings plans (per-event "push" goals) + commitments
-- (ahadi za kuchangia) with fulfilment tracking via contributions.
-- =====================================================================

-- Mipango ya akiba ya tukio: kutolewa kwa watu wengi (collaborative savings)
CREATE TABLE IF NOT EXISTS event_savings_plans (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  target_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (target_amount > 0),
  cadence VARCHAR(12) NOT NULL DEFAULT 'WEEKLY', -- DAILY, WEEKLY, BIWEEKLY, MONTHLY, CUSTOM
  session_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (session_amount > 0),
  start_date DATE,
  end_date DATE,
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, COMPLETED
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_savings_plans_event ON event_savings_plans(event_id);

-- Unganisho kati ya michango ya SAVINGS na mpango maalumu
CREATE TABLE IF NOT EXISTS event_savings_plan_contributions (
  id SERIAL PRIMARY KEY,
  plan_id INT NOT NULL REFERENCES event_savings_plans(id) ON DELETE CASCADE,
  contribution_id INT NOT NULL REFERENCES event_contributions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contribution_id)
);

CREATE INDEX IF NOT EXISTS idx_esp_c_plan ON event_savings_plan_contributions(plan_id);

-- Ahadi (commitments): mtu anajitoa kuchangia kiasi fulani; michango inaongeza 'fulfilled'
CREATE TABLE IF NOT EXISTS event_commitments (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  fulfilled NUMERIC(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PARTIAL, FULFILLED, CANCELLED
  note VARCHAR(255),
  due_date DATE,
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_commitments_event ON event_commitments(event_id);
CREATE INDEX IF NOT EXISTS idx_event_commitments_user ON event_commitments(user_id);
CREATE INDEX IF NOT EXISTS idx_event_commitments_status ON event_commitments(event_id, status);