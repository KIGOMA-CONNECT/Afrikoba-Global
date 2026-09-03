-- ============================================================================
-- 045 UPATU/ROSCA GOVERNANCE
-- Phase 2 completion: governance, versioned constitution, and configurable
-- cycle collection (grace period, late fee, payout order) per the directive.
--
--  1. Pool-level configurable governance: grace days, late fee, payout order.
--  2. Versioned Upatu constitution with per-member acceptance.
--  3. Richer round/(collection) statuses (OPEN -> PARTIALLY_FUNDED -> FUNDED
--     -> PAYOUT_PENDING -> DISBURSED).
-- ============================================================================

-- 1) Configurable governance on each pool (used by the payout engine).
ALTER TABLE rosca_pools ADD COLUMN IF NOT EXISTS grace_days INT DEFAULT 0;
ALTER TABLE rosca_pools ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE rosca_pools ADD COLUMN IF NOT EXISTS payout_order VARCHAR(20) DEFAULT 'SEQUENTIAL'
  CHECK (payout_order IN ('SEQUENTIAL','TRUST','DRAW'));

-- 2) Versioned Upatu constitution (append-only; a new version supersedes the old).
CREATE TABLE IF NOT EXISTS rosca_constitutions (
  id           SERIAL PRIMARY KEY,
  pool_id      INT NOT NULL REFERENCES rosca_pools(id) ON DELETE CASCADE,
  version      INT NOT NULL,
  title        VARCHAR(200),
  body         JSONB NOT NULL,          -- structured clause list, e.g. [{clause, text}]
  created_by   INT REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pool_id, version)
);

-- Per-member constitution acceptance. A member must accept the current
-- version before joining (enforced in joinPool) and before a payout is due.
CREATE TABLE IF NOT EXISTS rosca_constitution_acceptance (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pool_id          INT NOT NULL REFERENCES rosca_pools(id) ON DELETE CASCADE,
  constitution_id  INT NOT NULL REFERENCES rosca_constitutions(id) ON DELETE CASCADE,
  accepted_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, pool_id, constitution_id)
);
CREATE INDEX IF NOT EXISTS idx_rosca_accept_pool_user ON rosca_constitution_acceptance(pool_id, user_id);

-- 3) Richer round/collection status. The existing schedules.status (PENDING/
--    COLLECTED/DISBURSED/SKIPPED) is preserved; collection_status tracks the
--    open -> collecting -> funded lifecycle the directive requires.
ALTER TABLE rosca_schedules ADD COLUMN IF NOT EXISTS collection_status VARCHAR(24) DEFAULT 'OPEN';
ALTER TABLE rosca_schedules ADD COLUMN IF NOT EXISTS collected_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE rosca_schedules ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE rosca_schedules ADD COLUMN IF NOT EXISTS late_fee_charged NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE rosca_schedules ADD COLUMN IF NOT EXISTS grace_until DATE;
