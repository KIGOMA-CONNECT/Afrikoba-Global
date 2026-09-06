-- ============================================================================
-- 088 PARTITIONED LEDGER + AUDIT (declarative, monthly range)
--
-- High-volume append-only tables -> monthly RANGE partitions so that old
-- months can be DETACHed/archived without grinding on the parent table.
-- Targets:
--   * journal_entries (double-entry ledger; ~2 rows per money movement)
--   * audit_logs     (privileged-action audit trail)
--
-- NOT partitioned (documented): outbox_events (needs UNIQUE(reference_id)
-- dedup whose constraint target would change), flag_evaluations (log table,
-- small), transactions (is an FK target from journal_entries — partitioning it
-- would require dropping that relationship).
--
-- Rebuild approach (safe here: NO table references journal_entries/audit_logs
-- by FK; only outbound FKs which a partitioned table supports):
--   rename legacy -> create partitioned parent + trigger + indexes
--   -> create monthly partitions -> backfill data -> setval -> drop legacy.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. journal_entries
-- ---------------------------------------------------------------------------
ALTER TABLE journal_entries RENAME TO journal_entries_legacy;

-- Free index/constraint names before the new parent is created
-- (index names are schema-global; 'journal_entries_pkey''s index followed the table).
ALTER TABLE journal_entries_legacy DROP CONSTRAINT journal_entries_pkey;
DROP INDEX idx_journal_entries_group;
DROP INDEX idx_journal_entries_tx;
DROP INDEX idx_journal_entries_acct;

CREATE TABLE journal_entries (
  id               BIGSERIAL,
  entry_group_id   VARCHAR(64) NOT NULL,
  transaction_id   INTEGER REFERENCES transactions(id),
  account_id       INTEGER NOT NULL REFERENCES ledger_accounts(id),
  direction        VARCHAR(4) NOT NULL CHECK (direction IN ('DR','CR')),
  amount           NUMERIC(19,4) NOT NULL CHECK (amount >= 0),
  currency_code    VARCHAR(3) DEFAULT 'TZS',
  reference_id     VARCHAR(50),
  description      TEXT,
  posted_by        VARCHAR(40),
  posted_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id, posted_at)
) PARTITION BY RANGE (posted_at);

-- Balance is guaranteed at the DB level for every entry_group (deferred).
CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION fn_assert_balanced_group();

CREATE INDEX idx_journal_entries_group ON journal_entries(entry_group_id);
CREATE INDEX idx_journal_entries_tx    ON journal_entries(transaction_id);
CREATE INDEX idx_journal_entries_acct  ON journal_entries(account_id, posted_at DESC);

-- Backfill any NULLs (legacy column was nullable; partition key must resolve).
UPDATE journal_entries_legacy SET posted_at = NOW() WHERE posted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. audit_logs
-- ---------------------------------------------------------------------------
ALTER TABLE audit_logs RENAME TO audit_logs_legacy;

ALTER TABLE audit_logs_legacy DROP CONSTRAINT audit_logs_pkey;
DROP INDEX idx_audit_logs_user;
DROP INDEX idx_audit_logs_entity;
DROP INDEX idx_audit_logs_action;

CREATE TABLE audit_logs (
  id            SERIAL,
  user_id       INTEGER REFERENCES users(id),
  action        VARCHAR(255) NOT NULL,
  entity_type   VARCHAR(255),
  entity_id     INTEGER,
  ip_address    VARCHAR(64),
  user_agent    TEXT,
  meta          JSONB,
  created_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_audit_logs_user   ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);

UPDATE audit_logs_legacy SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Monthly partitions: current month + next 12 months for both tables
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl    text;
  ym     text;
  sdate  timestamptz;
  edate  timestamptz;
  i      int;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['journal_entries', 'audit_logs'] LOOP
    FOR i IN 0..12 LOOP
      -- UTC month boundaries (must match src/services/partitionService.js)
      sdate := (date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) + (i || ' months')::interval) AT TIME ZONE 'UTC';
      edate := sdate + interval '1 month';
      ym    := to_char(sdate AT TIME ZONE 'UTC', 'YYYY') || 'm' || to_char(sdate AT TIME ZONE 'UTC', 'MM');
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        tbl || '_y' || ym, tbl, sdate, edate
      );
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Migrate legacy data (keeps ids; partition routing by posted_at/created_at)
-- ---------------------------------------------------------------------------
INSERT INTO journal_entries (id, entry_group_id, transaction_id, account_id, direction, amount, currency_code, reference_id, description, posted_by, posted_at)
SELECT id, entry_group_id, transaction_id, account_id, direction, amount, currency_code, reference_id, description, posted_by, posted_at
FROM journal_entries_legacy;

INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, ip_address, user_agent, meta, created_at)
SELECT id, user_id, action, entity_type, entity_id, ip_address, user_agent, meta, created_at
FROM audit_logs_legacy;

-- Reset sequences to continue after migrated rows.
SELECT setval('journal_entries_id_seq', COALESCE((SELECT MAX(id) FROM journal_entries), 1));
SELECT setval('audit_logs_id_seq',    COALESCE((SELECT MAX(id) FROM audit_logs), 1));

DROP TABLE journal_entries_legacy;
DROP TABLE audit_logs_legacy;