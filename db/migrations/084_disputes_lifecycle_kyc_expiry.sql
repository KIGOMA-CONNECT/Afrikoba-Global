-- ============================================================
-- AFRIKOBA PHASE 19: DISPUTE RESOLUTION LIFECYCLE,
--                        KYC DOCUMENT EXPIRY & REMAINING
--                        ADMIN DISBURSEMENTS UNDER FOUR-EYES
-- 1) Disputes gain a full lifecycle: reviewer assignment, notes
--    history, mediation escalation, typed resolution amounts.
-- 2) KYC documents support the `EXPIRED` status (document-level),
--    driving level recomputation and agent sweeps.
-- 3) The last two admin disbursements (lending circles + kilimo
--    agri loans) join four-eyes dual control.
-- ============================================================

-- Dispute lifecycle columns.
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS resolution_type VARCHAR(30);
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS resolved_amount NUMERIC(14,2);
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS notes TEXT[] DEFAULT '{}';
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES users(id);
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

-- Workflow lookups.
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_assigned ON disputes(assigned_to, status);

-- Four-eyes policies for the remaining admin disbursements.
INSERT INTO four_eyes_policies (action_code, description, required_approvers, approver_roles, enabled, allow_self_approve) VALUES
  ('LENDING_CIRCLE_DISBURSE',   'Kutoa kampeni ya lending circle kwa idhini ya four-eyes',   1, ARRAY['ADMIN'], true, false),
  ('KILIMO_AGRI_LOAN_DISBURSE', 'Kutoa mkopo wa kilimo (agri loan) kwa idhini ya four-eyes', 1, ARRAY['ADMIN'], true, false)
ON CONFLICT (action_code) DO NOTHING;

-- The kilimo disbursement path sources funds from TREASURY; register the
-- internal account so the ledger can balance the loans (was previously absent).
INSERT INTO ledger_accounts (account_code, name, account_type, is_system)
SELECT 'TREASURY', 'Treasury (loan disbursements)', 'ASSET', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE account_code='TREASURY');