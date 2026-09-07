-- ============================================================
-- 090 SEQUENCE RESYNC (idempotent, never lowers)
-- Migration 088 rebuilt journal_entries + audit_logs into
-- monthly partitions. On databases where a legacy sequence with
-- the same name already existed, CREATE TABLE's implicit serial
-- default bound the new parent to a PG-generated name
-- (journal_entries_id_seq1 / audit_logs_id_seq1) that migration
-- 088's setval() never touched — leaving the live sequence behind
-- MAX(id) (e.g. 429 vs 1925) and violating the serial contract.
-- CI never caught it because fresh DBs have no legacy sequence.
-- This resyncs the sequence ACTUALLY referenced by each table's
-- id default, and never moves a sequence backwards.
-- ============================================================

DO $$
DECLARE
  seq_record RECORD;
BEGIN
  FOR seq_record IN
    SELECT 'journal_entries' AS tbl, pg_get_serial_sequence('public.journal_entries', 'id') AS seq
    UNION ALL
    SELECT 'audit_logs' AS tbl, pg_get_serial_sequence('public.audit_logs', 'id') AS seq
  LOOP
    IF seq_record.seq IS NOT NULL THEN
      EXECUTE format(
        'SELECT setval(%L, GREATEST((SELECT COALESCE(MAX(id), 1) FROM %I),
                                    (SELECT last_value FROM pg_sequences
                                     WHERE schemaname = ''public'' AND sequencename = %L)))',
        seq_record.seq,
        seq_record.tbl,
        split_part(seq_record.seq, '.', 2)
      );
    END IF;
  END LOOP;
END $$;