-- Migration 150: Add idempotency keys to General Social Fund contributions and payouts
-- Supports SF-05 (contribution idempotency) and SF-22 (payout idempotency)

ALTER TABLE social_fund_contributions ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);
ALTER TABLE social_fund_payouts ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);

-- Unique constraint: one idempotency key per user per case for contributions
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_contrib_idempotency
  ON social_fund_contributions (case_id, user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Unique constraint: one idempotency key per case for payouts
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_payout_idempotency
  ON social_fund_payouts (case_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;