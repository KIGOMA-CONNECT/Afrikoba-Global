-- ============================================================================
-- 036 FINANCIAL PASSPORT
-- A governed, explainable financial identity snapshot for AFRIKOBA.
--
-- Design principles (per the Financial OS vision):
--   * EXPLAINABLE, not opaque: every score is decomposable into named
--     dimensions (identity / behaviour / capacity), each carrying a reason.
--   * VERSIONED + APPEND-ONLY: each calculation inserts a NEW row (bumped
--     version), preserving the full audit trail of how a decision changed.
--     Only the latest row per user is flagged is_current = TRUE.
--   * LEDGER-CONSISTENT: reads only (no balance mutation), so it never touches
--     the double-entry journal or the reconciliation projections.
-- ============================================================================

CREATE TABLE IF NOT EXISTS financial_passports (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version           INT NOT NULL,

  -- COMPOSITE AFRIKOBA SCORE (0-850) + rating band
  afrikoba_score    INT  NOT NULL,
  rating_label      VARCHAR(30),
  rating_label_sw   VARCHAR(30),
  rating_color      VARCHAR(9),

  -- 1. IDENTITY dimensions (each 0-100 for explainability)
  identity_confidence  NUMERIC(5,2) NOT NULL DEFAULT 0,
  kyc_level            INT,
  phone_verified       BOOLEAN DEFAULT FALSE,
  nida_present         BOOLEAN DEFAULT FALSE,
  account_age_days     INT,

  -- 2. BEHAVIOUR dimensions (0-100)
  savings_consistency      NUMERIC(5,2),
  repayment_reliability    NUMERIC(5,2),
  contribution_consistency NUMERIC(5,2),
  group_participation      NUMERIC(5,2),
  tx_regularity            NUMERIC(5,2),
  tx_risk_level            VARCHAR(12),   -- LOW / MEDIUM / HIGH

  -- 3. CAPACITY (monetary, TZS)
  est_monthly_income       NUMERIC(15,2),
  est_cashflow             NUMERIC(15,2),
  committed_obligations    NUMERIC(15,2),
  disposable_capacity      NUMERIC(15,2),

  -- 4. GOVERNANCE / explainability
  dimensions       JSONB NOT NULL DEFAULT '[]',   -- named reasons per dimension
  triggers         JSONB DEFAULT '[]',             -- what changed vs last version
  calculated_by    VARCHAR(40) DEFAULT 'passport:cron',

  is_current       BOOLEAN DEFAULT FALSE,
  calculated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, version)
);

CREATE INDEX IF NOT EXISTS idx_passport_current ON financial_passports(user_id) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_passport_user ON financial_passports(user_id, version DESC);

-- Promote the first inserted passport for a user to current automatically.
CREATE OR REPLACE FUNCTION fn_promote_passport()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE financial_passports
     SET is_current = FALSE
   WHERE user_id = NEW.user_id AND is_current = TRUE AND id <> NEW.id;
  NEW.is_current := TRUE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_promote_passport ON financial_passports;
CREATE TRIGGER trg_promote_passport
  BEFORE INSERT ON financial_passports
  FOR EACH ROW EXECUTE FUNCTION fn_promote_passport();