-- Migration 154: Journal posting registry (GSF-FIN-09, GSF-FIN-10)
-- Provides database-enforced exactly-once posting identity for partitioned journal_entries.
-- The journal_entries table is partitioned by posted_at, so a unique constraint on
-- entry_group_id cannot be enforced globally. This unpartitioned registry solves that.

-- 1. Posting registry table (unpartitioned, globally unique)
CREATE TABLE IF NOT EXISTS journal_posting_registry (
  posting_id VARCHAR(64) PRIMARY KEY,
  reference_id VARCHAR(50) NOT NULL,
  transaction_id INTEGER,
  entry_count INTEGER NOT NULL DEFAULT 0,
  dr_total NUMERIC(19,4) NOT NULL DEFAULT 0,
  cr_total NUMERIC(19,4) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'POSTED',
  posted_by VARCHAR(40),
  posted_at TIMESTAMPTZ DEFAULT NOW(),
  -- MTC-08: Full payload for deterministic replay comparison
  payload JSONB NOT NULL DEFAULT '[]',
  payload_hash VARCHAR(64) NOT NULL DEFAULT '',
  metadata JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_posting_ref
  ON journal_posting_registry (reference_id);

-- 2. Immutability trigger for journal_entries (GSF-FIN-10)
CREATE OR REPLACE FUNCTION journal_entries_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal_entries are immutable: DELETE is not permitted (entry_group_id=%)', OLD.entry_group_id
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Allow only status updates on specific columns? No — full immutability.
    RAISE EXCEPTION 'journal_entries are immutable: UPDATE is not permitted (entry_group_id=%)', OLD.entry_group_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_entries_immutable ON journal_entries;
CREATE TRIGGER trg_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION journal_entries_immutable();

-- Note: journal_entries is partitioned, so the trigger must be created on
-- each partition. The above creates it on the parent (inherited by partitions
-- in PG 16 via trigger inheritance for partitioned tables).

ALTER TABLE journal_entries
  ENABLE ALWAYS TRIGGER trg_journal_entries_immutable;