/* ============================================================
 * AFRIKOBA GLOBAL - PARTITIONED LEDGER + AUDIT REGRESSION
 * Migration 088 turns journal_entries + audit_logs into monthly
 * declarative range partitions. This suite proves:
 *  - both tables are declaratively partitioned (relkind 'p')
 *  - partitions exist for current + next months (no missing-routing gaps)
 *  - new ledger rows route into the correct month partition
 *  - new audit rows route into the correct month partition
 *  - the DB-level balanced-group trigger still enforces after rebuild
 *  - partition manager: idempotent ensureAll / create + archive (detach-rename)
 *  - /api/ops/partitions admin visibility (+ RBAC gate)
 * ============================================================ */
const BASE = process.env.PARTITIONS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');
const { logAction } = require('../src/services/auditService');
const ps = require('../src/services/partitionService');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.user) throw new Error(`register ${phoneNumber} -> ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  return r.data;
}
async function makeAdmin(regData) {
  if (!regData || !regData.user || !regData.user.id) return null;
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [regData.user.id]);
  return regData.user.id;
}

async function fundWallet(userId, amount, ref) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({ client, userId, amount, reference: ref, fromAccount: 'SUSPENSE', description: 'Partition test seed' });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

(async () => {
  const suffix = Math.floor(1000 + Math.random() * 9000);

  await section('Declarative partitioned tables exist');
  const kinds = await pool.query(
    `SELECT relname, relkind FROM pg_class WHERE relname IN ('journal_entries','audit_logs')`
  );
  const kindMap = Object.fromEntries(kinds.rows.map((r) => [r.relname, r.relkind]));
  await expect(kindMap.journal_entries === 'p', 'journal_entries is a partitioned table');
  await expect(kindMap.audit_logs === 'p', 'audit_logs is a partitioned table');
  await expect(ps.currentYm().match(/^\d{4}m\d{2}$/) !== null, 'currentYm() format valid (' + ps.currentYm() + ')');

  await section('Monthly partitions provisioned');
  const jparts = await ps.listPartitions('journal_entries');
  const aparts = await ps.listPartitions('audit_logs');
  await expect(jparts.length >= 13, `journal_entries has current+12 partitions (${jparts.length})`);
  await expect(aparts.length >= 13, `audit_logs has current+12 partitions (${aparts.length})`);
  await expect(jparts.every((p) => /^journal_entries_y\d{4}m\d{2}$/.test(p.partition))
    && jparts.every((p) => /( FOR VALUES FROM|FROM)/.test(p.bound)), 'partition names + bounds well-formed');

  await section('Partition manager idempotency + overview');
  const before = (await ps.listPartitions('journal_entries')).length;
  await ps.ensureAll();
  const after = (await ps.listPartitions('journal_entries')).length;
  await expect(after === before, `ensureAll is idempotent (${before} -> ${after})`);
  await expect(await ps.isPartitioned('journal_entries') === true, 'isPartitioned detects partitioned table');
  const ov = await ps.partitionOverview();
  await expect(ov.journal_entries.partitioned === true && ov.journal_entries.partitionCount >= 13, 'overview: journal_entries partitioned');
  await expect(ov.audit_logs.partitioned === true && ov.audit_logs.partitionCount >= 13, 'overview: audit_logs partitioned');

  await section('Ledger rows route into month partitions');
  const a = await register(`255801${suffix}`, 'Part Owner');
  const uid = a.user.id;
  const ref = `PART:LEDGER:${uid}:${Date.now()}`;
  await fundWallet(uid, 50000, ref);
  const led = await pool.query(
    `SELECT tableoid::regclass::text AS part FROM journal_entries WHERE reference_id = $1`,
    [ref]
  );
  await expect(led.rows.length >= 2, `ledger entries written for ref (n=${led.rows.length})`);
  await expect(led.rows.length >= 2 && led.rows.every((r) => /^journal_entries_y\d{4}m\d{2}$/.test(r.part)),
    'ledger rows land in month partition', `parts=${[...new Set(led.rows.map((r) => r.part))].join(',')}`);

  await section('Audit rows route into month partitions');
  const action = `PART_AUDIT_${suffix}`;
  await logAction(uid, action, 'users', uid, { partition: 'audit-routing' });
  const aud = await pool.query(
    `SELECT tableoid::regclass::text AS part FROM audit_logs WHERE action = $1`,
    [action]
  );
  await expect(aud.rows.length === 1, `audit row written (n=${aud.rows.length})`);
  await expect(aud.rows.length === 1 && /^audit_logs_y\d{4}m\d{2}$/.test(aud.rows[0].part),
    'audit row lands in month partition', `part=${aud.rows[0] ? aud.rows[0].part : '?'}`);

  await section('Balanced-group trigger still enforces after rebuild');
  const accountId = (await pool.query(`SELECT id FROM ledger_accounts WHERE account_code = 'CUSTOMER_WALLET' LIMIT 1`)).rows[0].id;
  const client = await pool.connect();
  let violated = false;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, posted_at)
       VALUES ($1, $2, 'DR', 1000, NOW())`,
      [`PART_VIOLATION_${suffix}`, accountId]
    );
    try {
      await client.query('COMMIT');
    } catch (e) {
      violated = /BALANCED_LEDGER_VIOLATION/.test(e.message);
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    client.release();
  }
  await expect(violated, 'unbalanced DR-only group rejected at COMMIT');

  await section('Archive (DETACH) an old partition');
  await ps.createPartition('journal_entries', '1999m01');
  const beforeArchive = (await ps.listPartitions('journal_entries')).length;
  const listed = (await ps.listPartitions('journal_entries')).some((p) => p.partition === 'journal_entries_y1999m01');
  await expect(listed, 'throwaway partition listed');
  const archivedName = await ps.archivePartition('journal_entries', '1999m01');
  await expect(archivedName === 'archive_journal_entries_y1999m01', 'DETACH renames to archive_journal_entries_y1999m01');
  const afterArchive = (await ps.listPartitions('journal_entries')).length;
  await expect(afterArchive === beforeArchive - 1, 'partition no longer inherited by parent');
  const archKind = (await pool.query(`SELECT relkind FROM pg_class WHERE relname = 'archive_journal_entries_y1999m01'`)).rows[0];
  await expect(!!archKind && archKind.relkind === 'r', 'archived partition is a plain queryable table');
  await pool.query('DROP TABLE IF EXISTS archive_journal_entries_y1999m01');

  await section('HTTP: /api/ops/partitions (admin)');
  const adm = await register(`255802${suffix}`, 'Part Admin');
  const admId = await makeAdmin(adm);
  await expect(!!admId, 'admin promoted');
  const uk = await api('GET', '/api/ops/partitions', a.token, null);
  await expect(uk.status === 401 || uk.status === 403, 'partitions endpoint blocked for regular user');
  const okPart = await api('GET', '/api/ops/partitions', adm.token, null);
  await expect(okPart.status === 200 && okPart.data.success
    && okPart.data.partitions.journal_entries.partitioned === true
    && okPart.data.partitions.audit_logs.partitioned === true,
    'admin sees partition state for both tables');

  console.log(`\n===== PARTITIONS: ${passed} passed, ${failed} failed =====`);
  if (failures.length) console.log('FAILURES: ' + failures.join(' | '));
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('SUITE CRASH:', e.message);
  process.exit(1);
});