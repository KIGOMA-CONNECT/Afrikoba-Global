-- ============================================================
-- AFRIKOBA PHASE 21: ROSCA AUTO-CONTRIBUTION
--                        & TRUST_SCORE FROM HISTORY
-- 1) Track per-member ROSCA contribution reliability so the
--    platform can reward on-time contributors and downgrade
--    unreliable ones (drives trust_score, mirrors eRosca credit
--    history).
-- 2) rosca_trust_history records each score delta so members and
--    auditors can inspect exactly why a trust score changed.
-- ============================================================

-- Per-member reliability counters within a pool.
ALTER TABLE rosca_members ADD COLUMN IF NOT EXISTS contributions_ok INT DEFAULT 0;
ALTER TABLE rosca_members ADD COLUMN IF NOT EXISTS contributions_missed INT DEFAULT 0;
ALTER TABLE rosca_members ADD COLUMN IF NOT EXISTS on_time_streak INT DEFAULT 0;

-- History of trust_score changes driven by ROSCA activity.
CREATE TABLE IF NOT EXISTS rosca_trust_history (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pool_id INT REFERENCES rosca_pools(id) ON DELETE CASCADE,
    cycle_number INT,
    delta NUMERIC(5,1) NOT NULL,
    score_after NUMERIC(6,2) NOT NULL,
    reason VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rosca_trust_history_user ON rosca_trust_history(user_id);
CREATE INDEX IF NOT EXISTS idx_rosca_trust_history_pool ON rosca_trust_history(pool_id);
