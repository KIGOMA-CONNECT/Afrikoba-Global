/* ============================================================
 * AFRIKOBA GLOBAL - DISASTER RECOVERY / RESTORE VERIFICATION
 * Closes GAP AFK-INST-18 required update + standards-audit rec #5:
 * proves the daily pg_dump can actually be RESTORED and that the
 * restored database is structurally + financially sound. Steps:
 *  - pg_dump the live source DB to a temp file
 *  - static verify (CREATE TABLE / COPY / CREATE INDEX present)
 *  - restore the dump into a scratch database via psql
 *  - verify scratch matches source (object + row counts)
 *  - post-restore integrity (balanced journal, non-negative wallets,
 *    serials ahead of max ids, partitions intact, migrations replay)
 *  - drop the scratch database (no residue)
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');
const pool = require('../src/config/db');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASS = process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres';
const DB_NAME = process.env.DB_NAME || 'afrikoba_global';
const WIN_PG_BIN = 'C:\\Program Files\\PostgreSQL\\18\\bin\\';
const isWin = process.platform === 'win32';
const PGDUMP_PATH = process.env.PGDUMP_PATH || (isWin ? '"' + WIN_PG_BIN + 'pg_dump.exe"' : 'pg_dump');
const PSQL_PATH = process.env.PSQL_PATH || (isWin ? '"' + WIN_PG_BIN + 'psql.exe"' : 'psql');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

let scratchName = '';
let dumpFile = '';

async function maint(cmd, params) {
  const c = new Client({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
    database: 'postgres', connectionTimeoutMillis: 8000,
  });
  await c.connect();
  try {
    return await c.query(cmd, params);
  } finally {
    await c.end().catch(() => {});
  }
}

async function scratch(cmd, params) {
  const c = new Client({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
    database: scratchName, connectionTimeoutMillis: 8000,
  });
  await c.connect();
  try {
    return await c.query(cmd, params);
  } finally {
    await c.end().catch(() => {});
  }
}

function stripQuotes(p) {
  const s = p.replace(/"/g, '');
  return s;
}

async function run() {
  scratchName = `afrikoba_restore_verify_${Math.floor(1000 + Math.random() * 9000)}`;
  dumpFile = path.join(os.tmpdir(), `afrikoba_restore_verify_${Date.now()}.sql`);
  const dumpBin = stripQuotes(PGDUMP_PATH);
  const psqlBin = stripQuotes(PSQL_PATH);

  await section('1. Backup creation via pg_dump');
  try {
    execFileSync(dumpBin, ['--no-owner', '--no-privileges', '-h', DB_HOST, '-p', String(DB_PORT), '-U', DB_USER, '-d', DB_NAME, '-f', dumpFile], {
      timeout: 300000, stdio: 'pipe', env: { ...process.env, PGPASSWORD: DB_PASS },
    });
    ok('pg_dump exited 0');
  } catch (e) {
    fail('pg_dump exited 0', e.message.split('\n').slice(0, 3).join(' '));
  }
  const stats = fs.existsSync(dumpFile) ? fs.statSync(dumpFile) : null;
  await expect(!!stats && stats.size > 1000, `dump file created + non-empty (${stats ? stats.size : 0} bytes)`);
  if (stats) {
    const content = fs.readFileSync(dumpFile, 'utf8');
    await expect(content.includes('CREATE TABLE'), 'dump contains CREATE TABLE statements');
    await expect(content.includes('COPY '), 'dump contains COPY (data) blocks');
    await expect(content.includes('CREATE INDEX'), 'dump contains CREATE INDEX statements');
  }

  await section('2. Restore into scratch database');
  try {
    const src = await pool.query('SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1', ['public']);
    const srcTables = src.rows[0].n;
    await maint('CREATE DATABASE ' + scratchName);
    ok(`scratch database created (${scratchName})`);
    try {
      execFileSync(psqlBin, ['-v', 'ON_ERROR_STOP=1', '-h', DB_HOST, '-p', String(DB_PORT), '-U', DB_USER, '-d', scratchName, '-f', dumpFile], {
        timeout: 600000, stdio: 'pipe', env: { ...process.env, PGPASSWORD: DB_PASS },
      });
      ok('psql restore exited 0');
      const restored = await scratch("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
      await expect(restored.rows[0].n === srcTables, `restored table count matches source (${restored.rows[0].n} == ${srcTables})`);
    } catch (e) {
      fail('psql restore exited 0', String(e.message).split('\n').slice(0, 4).join(' '));
    }
  } catch (e) {
    fail('scratch database created + restorable', e.message);
  }

  await section('3. Row-count parity with source');
  for (const table of ['users', 'transactions', 'wallet_ledger', 'journal_entries', 'audit_logs', 'ledger_accounts', 'supported_countries', 'schema_migrations']) {
    try {
      const srcN = (await pool.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
      const rstN = (await scratch(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
      await expect(srcN === rstN, `${table} row count matches (${rstN} == ${srcN})`);
    } catch (e) {
      fail(`${table} row count matches`, e.message.slice(0, 120));
    }
  }

  await section('4. Post-restore financial integrity');
  const unbalanced = await scratch(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT entry_group_id
       FROM journal_entries
       GROUP BY entry_group_id
       HAVING ABS(SUM(CASE WHEN direction='DR' THEN amount ELSE -amount END)) > 0.01
     ) x`
  );
  await expect(unbalanced.rows[0].n === 0, `zero unbalanced journal groups (got ${unbalanced.rows[0].n})`);
  const negWallets = await scratch(`SELECT COUNT(*)::int AS n FROM users WHERE wallet_balance < 0`);
  await expect(negWallets.rows[0].n === 0, `no negative wallet balances (got ${negWallets.rows[0].n})`);

  await section('5. Serializable IDs + partitioning survive restore');
  for (const table of ['users', 'transactions', 'journal_entries', 'audit_logs', 'supported_countries']) {
    const seqRes = await scratch(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [`public.${table}`]);
    const seq = seqRes.rows[0].seq;
    if (!seq) { fail(`${table}: serial sequence restored`); continue; }
    const r = await scratch(
      `SELECT (SELECT last_value FROM ${seq}) AS last_value,
              (SELECT COALESCE(MAX(id),0) FROM public.${table}) AS max_id`
    );
    const lastValue = Number(r.rows[0].last_value || 0);
    const maxId = Number(r.rows[0].max_id || 0);
    await expect(lastValue >= maxId, `${table} serial ahead of max id (${lastValue} >= ${maxId})`);
  }
  const partKinds = await scratch(
    `SELECT relname, relkind FROM pg_class WHERE relname IN ('journal_entries','audit_logs')`
  );
  const partMap = Object.fromEntries(partKinds.rows.map((r) => [r.relname, r.relkind]));
  await expect(partMap.journal_entries === 'p', 'journal_entries still declaratively partitioned');
  await expect(partMap.audit_logs === 'p', 'audit_logs still declaratively partitioned');
  const jparts = (await scratch(`SELECT COUNT(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE c.relname LIKE 'journal_entries_y%'`)).rows[0].n;
  await expect(jparts >= 13, `journal_entries month partitions restored (${jparts})`);

  await section('6. Migration ledger replays cleanly');
  const srcMigs = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const rstMigs = await scratch('SELECT version FROM schema_migrations ORDER BY version');
  await expect(srcMigs.rows.length === rstMigs.rows.length && srcMigs.rows.every((r, i) => r.version === rstMigs.rows[i].version),
    `all ${rstMigs.rows.length} applied migrations present after restore`);

  await section('7. Cleanup');
  try {
    await maint('DROP DATABASE ' + scratchName + ' WITH (FORCE)');
    ok('scratch database dropped');
  } catch (e) {
    fail('scratch database dropped', e.message.slice(0, 120));
  }
  try {
    fs.unlinkSync(dumpFile);
    ok('temp dump removed');
  } catch (e) {
    fail('temp dump removed', e.message.slice(0, 120));
  }

  console.log(`\n===== RESTORE VERIFY: ${passed} passed, ${failed} failed =====`);
  if (failures.length) console.log('FAILURES: ' + failures.join(' | '));
  process.exit(failed ? 1 : 0);
}

run().catch(async (e) => {
  console.error('SUITE CRASH:', e.message);
  try { if (scratchName) await maint('DROP DATABASE ' + scratchName + ' WITH (FORCE)'); } catch (_) {}
  try { if (dumpFile && fs.existsSync(dumpFile)) fs.unlinkSync(dumpFile); } catch (_) {}
  process.exit(1);
});