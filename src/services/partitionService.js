/**
 * PARTITION MANAGER (declarative monthly RANGE partitions)
 * Handles the partitioned tables introduced by migration 088:
 *   journal_entries (BY posted_at) and audit_logs (BY created_at).
 *
 * Responsibilities:
 *   - ensureAll()/ensureTable()  : create partitions for current + next months
 *   - createPartition(table, ym) : one partition for month 'YYYYmMM'
 *   - listPartitions(table)      : partition names + boundaries
 *   - archivePartition(tbl, name): DETACH + rename to archive_* (data stays
 *                                  queryable as a plain table, ready for upload)
 * Old partitions can be dropped with `DROP TABLE archive_*;` once archived.
 */
const pool = require('../config/db');

const JOURNAL_PARTITIONED = 'journal_entries';
const AUDIT_PARTITIONED = 'audit_logs';
const AHEAD_MONTHS = 13; // current + 12 future months

function monthBounds(ym) {
  const y = parseInt(ym.slice(0, 4), 10);
  const m = parseInt(ym.slice(5), 10);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const iso = (d) => d.toISOString();
  return { start: iso(start), end: iso(end) };
}

function currentYm(offsetMonths = 0) {
  const d = new Date();
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1));
  return `${base.getUTCFullYear()}m${String(base.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Create one monthly partition for a partitioned table (idempotent). */
async function createPartition(table, ym) {
  const { start, end } = monthBounds(ym);
  const name = `${table}_y${ym}`;
  // NB: PostgreSQL rejects bind parameters ($1/$2) inside partition bounds —
  // bound values must be constant expressions, so we inline literals.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${table} FOR VALUES FROM ('${start}'::timestamptz) TO ('${end}'::timestamptz)`
  );
  return name;
}

/** Ensure current + next AHEAD_MONTHS partitions exist for both tables. */
async function ensureAll() {
  await ensureTable(JOURNAL_PARTITIONED);
  await ensureTable(AUDIT_PARTITIONED);
  return { ok: true };
}

async function ensureTable(table) {
  for (let i = 0; i < AHEAD_MONTHS; i++) {
    await createPartition(table, currentYm(i));
  }
  return listPartitions(table);
}

/** List partitions + boundaries for a partitioned table. */
async function listPartitions(table) {
  const res = await pool.query(
    `SELECT child.relname AS partition, pg_get_expr(child.relpartbound, child.oid) AS bound
       FROM pg_inherits i
       JOIN pg_class child ON child.oid = i.inhrelid
       JOIN pg_class parent ON parent.oid = i.inhparent
      WHERE parent.relname = $1
      ORDER BY child.relname`,
    [table]
  );
  return res.rows;
}

/** Is `table` a declaratively partitioned table? */
async function isPartitioned(table) {
  const res = await pool.query(
    `SELECT 1 FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid WHERE c.relname = $1`,
    [table]
  );
  return res.rows.length === 1;
}

/**
 * Archive an old partition: DETACH it from the parent (writes-stop, queries
 * keep working) and rename to archive_<table>_<ym> so it is clearly separated
 * and ready for export/delete. Returns the new archive table name.
 */
async function archivePartition(table, ym) {
  const name = `${table}_y${ym}`;
  const exists = await pool.query(
    `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
    [name]
  );
  if (exists.rows.length === 0) throw new Error(`Partition '${name}' haipo.`);
  const archiveName = `archive_${name}`;
  await pool.query(`ALTER TABLE ${table} DETACH PARTITION ${name}`);
  await pool.query(`ALTER TABLE ${name} RENAME TO ${archiveName}`);
  return archiveName;
}

/** Ops snapshot: partition state per managed table. */
async function partitionOverview() {
  const overview = {};
  for (const table of [JOURNAL_PARTITIONED, AUDIT_PARTITIONED]) {
    const parts = await listPartitions(table);
    overview[table] = {
      partitioned: await isPartitioned(table),
      partitionCount: parts.length,
      latest: parts.length ? parts[parts.length - 1].partition : null,
      partitions: parts.slice(-6).map((p) => `${p.partition} ${p.bound}`),
    };
  }
  return overview;
}

module.exports = {
  JOURNAL_PARTITIONED,
  AUDIT_PARTITIONED,
  ensureAll,
  ensureTable,
  createPartition,
  listPartitions,
  isPartitioned,
  archivePartition,
  partitionOverview,
  currentYm,
};