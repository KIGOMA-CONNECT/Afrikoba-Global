-- 149 | R34 S5 — VICOBA loan three-tier approval chain (Standard Group Governance Mode).
-- VICOBA v2.1 §3, §4.1–4.4: the member submits their own request; Katibu, then Mhasibu
-- (role MWEKAHAZINA), then Mwenyekiti approve; three different people; the applicant never
-- approves any step; a missing approver puts the request ON_HOLD; disbursement only after
-- all three steps.
--
-- Scope: approval workflow data only. No change to existing rows, DR/CR, journal_entries,
-- transactions, balances or the disbursement itself. No backfill: rows created before this
-- migration keep approval_chain_version NULL and are recognised as the legacy chain.
-- Status CHECKs are NOT VALID: they bind new and updated rows only; VALIDATE after the
-- read-only check of existing statuses (owner decision).
-- The migration runner manages transaction boundaries (no BEGIN/COMMIT here).
-- Test databases only; not authorised for production.
-- Rollback (test DB): DROP TRIGGER trg_vicoba_loan_approvals_guard ON vicoba_loan_approvals;
--   DROP FUNCTION vicoba_loan_approvals_guard(); DROP TABLE vicoba_loan_approvals;
--   ALTER TABLE vicoba_loan_requests DROP CONSTRAINT ck_vicoba_loan_requests_status,
--   DROP CONSTRAINT ck_vicoba_loan_requests_v1_shape, DROP CONSTRAINT ck_vicoba_loan_requests_hold,
--   DROP CONSTRAINT ck_vicoba_loan_requests_cancel, then DROP the eight columns added below.

ALTER TABLE vicoba_loan_requests
  ADD COLUMN IF NOT EXISTS initiated_by_user_id   INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approval_chain_version SMALLINT,
  ADD COLUMN IF NOT EXISTS hold_reason            VARCHAR(40),
  ADD COLUMN IF NOT EXISTS hold_step              VARCHAR(20),
  ADD COLUMN IF NOT EXISTS held_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_step          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id   INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at           TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_vicoba_loan_requests_status') THEN
    ALTER TABLE vicoba_loan_requests
      ADD CONSTRAINT ck_vicoba_loan_requests_status CHECK (status IN
        ('PENDING','PENDING_KATIBU','PENDING_MHASIBU','PENDING_MWENYEKITI','ON_HOLD',
         'REJECTED','CANCELLED','APPROVED','DISBURSED','REPAID')) NOT VALID;
  END IF;
  -- A chain-v1 row is never in the legacy 'PENDING' state and is always initiated by its applicant.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_vicoba_loan_requests_v1_shape') THEN
    ALTER TABLE vicoba_loan_requests
      ADD CONSTRAINT ck_vicoba_loan_requests_v1_shape CHECK (
        approval_chain_version IS NULL
        OR (status <> 'PENDING' AND initiated_by_user_id IS NOT NULL
            AND initiated_by_user_id = applicant_user_id)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_vicoba_loan_requests_hold') THEN
    ALTER TABLE vicoba_loan_requests
      ADD CONSTRAINT ck_vicoba_loan_requests_hold CHECK (
        status <> 'ON_HOLD' OR (hold_reason IS NOT NULL AND hold_step IS NOT NULL AND held_at IS NOT NULL)) NOT VALID;
  END IF;
  -- Only the applicant cancels (owner decision D-S5-5).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_vicoba_loan_requests_cancel') THEN
    ALTER TABLE vicoba_loan_requests
      ADD CONSTRAINT ck_vicoba_loan_requests_cancel CHECK (
        status <> 'CANCELLED' OR (cancelled_by_user_id IS NOT NULL
          AND cancelled_by_user_id = applicant_user_id AND cancelled_at IS NOT NULL)) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vicoba_loan_approvals (
  id                   BIGSERIAL PRIMARY KEY,
  loan_id              INT NOT NULL REFERENCES vicoba_loan_requests(id) ON DELETE RESTRICT,
  group_id             INT NOT NULL REFERENCES vicoba_groups(id) ON DELETE RESTRICT,
  chain_version        SMALLINT NOT NULL,
  step_no              SMALLINT NOT NULL CHECK (step_no BETWEEN 1 AND 9),
  step_code            VARCHAR(20) NOT NULL,
  actor_user_id        INT NOT NULL REFERENCES users(id),
  actor_role_at_action VARCHAR(20) NOT NULL,
  decision             VARCHAR(10) NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reason               TEXT,
  amount               NUMERIC(15,2) CHECK (amount IS NULL OR amount > 0),
  decided_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_vicoba_loan_approvals_loan_step  UNIQUE (loan_id, step_no),
  CONSTRAINT uq_vicoba_loan_approvals_loan_actor UNIQUE (loan_id, actor_user_id),
  CONSTRAINT ck_vicoba_loan_approvals_reject_reason
    CHECK (decision <> 'REJECTED' OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 3 AND 500)),
  CONSTRAINT ck_vicoba_loan_approvals_v1_steps
    CHECK (chain_version <> 1 OR (step_no, step_code) IN ((1,'KATIBU'),(2,'MHASIBU'),(3,'MWENYEKITI')))
);
CREATE INDEX IF NOT EXISTS idx_vicoba_loan_approvals_actor ON vicoba_loan_approvals(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_vicoba_loan_approvals_group ON vicoba_loan_approvals(group_id, decided_at);

-- Append-only audit, plus a second line of defence for the applicant and group rules.
CREATE OR REPLACE FUNCTION vicoba_loan_approvals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lr RECORD;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'vicoba_loan_approvals is append-only' USING ERRCODE = '42501';
  END IF;
  SELECT applicant_user_id, group_id INTO lr FROM vicoba_loan_requests WHERE id = NEW.loan_id;
  IF lr.applicant_user_id = NEW.actor_user_id THEN
    RAISE EXCEPTION 'vicoba_loan_approvals: applicant cannot decide own loan' USING ERRCODE = '23514';
  END IF;
  IF lr.group_id IS DISTINCT FROM NEW.group_id THEN
    RAISE EXCEPTION 'vicoba_loan_approvals: group mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_vicoba_loan_approvals_guard ON vicoba_loan_approvals;
CREATE TRIGGER trg_vicoba_loan_approvals_guard
  BEFORE INSERT OR UPDATE OR DELETE ON vicoba_loan_approvals
  FOR EACH ROW EXECUTE FUNCTION vicoba_loan_approvals_guard();
