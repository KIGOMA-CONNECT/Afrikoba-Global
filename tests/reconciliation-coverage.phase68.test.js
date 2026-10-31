'use strict';
/**
 * Phase 68 — reconciliation coverage for direct `wallet_ledger` writers.
 *
 * Runs against a disposable Postgres database only (name must match
 * /^phase68_amount_guard_[a-z0-9_]+$/ and PHASE68_TEST_DB must equal DB_NAME).
 * SMS and audit transport are stubbed: no network, no provider call.
 *
 * Every service that writes `wallet_ledger` directly must do so inside the same
 * transaction as an engine primitive that posts a balanced journal group. This
 * suite proves that two ways:
 *
 *   S. static parity — each `INSERT INTO wallet_ledger` is transaction-scoped
 *      and preceded by an engine posting in the same BEGIN block;
 *   C. database behaviour — a journal-backed ledger row is not an orphan, an
 *      orphan row is surfaced as `LEDGER_ORPHAN`, and repeat runs dedupe.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DB_NAME = process.env.DB_NAME || '';
if (!/^phase68_amount_guard_[a-z0-9_]+$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
  console.error('SUITE ERROR: DB_NAME and PHASE68_TEST_DB must match an explicit phase68_amount_guard_<unique_suffix> disposable database name.');
  process.exit(2);
}

function stubModule(rel, exportsObj) {
  const p = path.join(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

stubModule('src/services/smsService.js', { sendSMS: async () => ({ success: true }) });
stubModule('src/services/auditService.js', { logAudit: async () => {}, logAction: async () => {} });

const pool = require(path.join(ROOT, 'src/config/db'));
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const recon = require(path.join(ROOT, 'src/jobs/balanceReconciliation'));

const uniq = (p) => `${p}-RC-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

async function freshUser() {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name <> 'id'
      ORDER BY ordinal_position`
  );
  const names = cols.map((c) => c.column_name);
  const { rows: uniqueCols } = await pool.query(
    `SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = 'users'::regclass AND i.indisunique AND NOT i.indisprimary
        AND array_length(i.indkey::int2[], 1) = 1`
  );
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const overrides = new Map([
    ['phone_number', `255${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`],
  ]);
  for (const u of uniqueCols) {
    if (/char|text/.test(u.typ)) overrides.set(u.col, String(Math.floor(Math.random() * 9e9) + 1e9));
  }
  overrides.set('email', `rc-${suffix}@rc.invalid`);
  const params = [];
  const select = names.map((c) => {
    if (c === 'wallet_balance' || c === 'locked_balance') return '0';
    if (overrides.has(c)) { params.push(overrides.get(c)); return `$${params.length}`; }
    return `"${c}"`;
  });
  const { rows } = await pool.query(
    `INSERT INTO users (${names.map((c) => `"${c}"`).join(', ')})
     SELECT ${select.join(', ')} FROM users WHERE id = (SELECT min(id) FROM users WHERE phone_number IS NOT NULL)
     RETURNING id`,
    params
  );
  return rows[0].id;
}

const orphanCount = async (ref) => (await pool.query(
  `SELECT count(*)::int AS n FROM reconciliation_exceptions
    WHERE exception_type = 'LEDGER_ORPHAN' AND reference_id = $1`,
  [ref]
)).rows[0].n;

const journalBalanced = async (ref) => (await pool.query(
  `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DR'), 0)
        - COALESCE(SUM(amount) FILTER (WHERE direction = 'CR'), 0) AS diff
     FROM journal_entries WHERE reference_id = $1`,
  [ref]
)).rows[0].diff;

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

/* ------------------------------------------------------------------ *
 * S. Static parity — direct ledger writers stay transaction-scoped
 * ------------------------------------------------------------------ */

const WRITERS = [
  'src/jobs/reconciliationCron.js',
  'src/services/mkobaService.js',
  'src/services/p2pService.js',
  'src/services/countryService.js',
  'src/services/recurrenceService.js',
  'src/services/vicobaService.js',
  'src/services/ussdService.js',
];

scenario('S1 every direct wallet_ledger insert is transaction-scoped and engine-backed', () => {
  const engineCall = /\bfin\.(creditWallet|debitWallet|internalTransfer|walletToGroup|groupToWallet|postDeposit)\s*\(/;
  for (const rel of WRITERS) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
    const needle = 'INSERT INTO wallet_ledger';
    let idx = source.indexOf(needle);
    assert.ok(idx >= 0, `${rel}: expected at least one ${needle}`);
    let found = 0;
    while (idx >= 0) {
      found += 1;
      const beginIdx = Math.max(
        source.lastIndexOf("'BEGIN'", idx),
        source.lastIndexOf('"BEGIN"', idx),
        source.lastIndexOf('`BEGIN`', idx)
      );
      assert.ok(beginIdx >= 0, `${rel}: wallet_ledger insert #${found} has no BEGIN before it`);
      const commitAfterIdx = Math.max(
        source.indexOf("'COMMIT'", idx),
        source.indexOf('"COMMIT"', idx),
        source.indexOf('`COMMIT`', idx)
      );
      assert.ok(commitAfterIdx > idx, `${rel}: wallet_ledger insert #${found} has no COMMIT after it`);
      const segment = source.slice(beginIdx, idx);
      assert.ok(engineCall.test(segment),
        `${rel}: wallet_ledger insert #${found} is not preceded by an engine posting in the same transaction`);
      idx = source.indexOf(needle, idx + needle.length);
    }
  }
});

/* ------------------------------------------------------------------ *
 * C. Database behaviour
 * ------------------------------------------------------------------ */

scenario('C1 a journal-backed wallet_ledger row is not an orphan', async () => {
  const uid = await freshUser();
  const ref = uniq('MATCHED');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({
      client, userId: uid, amount: 250, reference: ref,
      fromAccount: 'SUSPENSE', description: 'RC matched credit',
    });
    await client.query(
      `INSERT INTO wallet_ledger (reference_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, 'RC matched row')`,
      [ref, uid, 250]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  assert.strictEqual(Number(await journalBalanced(ref)), 0, 'journal group is not balanced');
  const orphans = await recon.checkLedgerCoverage(pool);
  assert.ok(!orphans.some((o) => o.referenceId === ref), 'journal-backed row was flagged as an orphan');
});

scenario('C2 an orphan wallet_ledger row is surfaced as LEDGER_ORPHAN', async () => {
  const uid = await freshUser();
  const ref = uniq('ORPHAN');

  await pool.query(
    `INSERT INTO wallet_ledger (reference_id, to_user_id, amount, description)
     VALUES ($1, $2, 99, 'RC orphan row')`,
    [ref, uid]
  );

  try {
    const result = await recon.runLedgerCoverage();
    assert.ok(result.orphans.some((o) => o.referenceId === ref),
      `runLedgerCoverage did not report ${ref}`);

    const rows = (await pool.query(
      `SELECT exception_type, status, detail
         FROM reconciliation_exceptions
        WHERE exception_type = 'LEDGER_ORPHAN' AND reference_id = $1`,
      [ref]
    )).rows;
    assert.strictEqual(rows.length, 1, `expected 1 LEDGER_ORPHAN, got ${rows.length}`);
    assert.strictEqual(rows[0].status, 'OPEN');
    assert.strictEqual(Number(rows[0].detail.ledgerRows), 1);
    assert.strictEqual(Number(rows[0].detail.ledgerAmount), 99);
  } finally {
    await pool.query('DELETE FROM reconciliation_exceptions WHERE exception_type = $1 AND reference_id = $2',
      ['LEDGER_ORPHAN', ref]);
    await pool.query('DELETE FROM wallet_ledger WHERE reference_id = $1', [ref]);
  }
});

scenario('C3 repeated coverage runs do not duplicate the exception', async () => {
  const uid = await freshUser();
  const ref = uniq('DEDUP');

  await pool.query(
    `INSERT INTO wallet_ledger (reference_id, to_user_id, amount, description)
     VALUES ($1, $2, 11, 'RC dedup row')`,
    [ref, uid]
  );

  try {
    await recon.runLedgerCoverage();
    await recon.runLedgerCoverage();
    assert.strictEqual(await orphanCount(ref), 1, 'LEDGER_ORPHAN was duplicated across runs');
  } finally {
    await pool.query('DELETE FROM reconciliation_exceptions WHERE exception_type = $1 AND reference_id = $2',
      ['LEDGER_ORPHAN', ref]);
    await pool.query('DELETE FROM wallet_ledger WHERE reference_id = $1', [ref]);
  }
});

scenario('C4 full reconciliation records the ledger-coverage line item', async () => {
  const summary = await recon.runBalanceReconciliation('MANUAL');
  assert.ok(summary && summary.totalChecked > 0, 'reconciliation returned no summary');

  const { rows } = await pool.query(
    `SELECT state, journal_balance
       FROM reconciliation_line_items
      WHERE run_id = $1 AND account_code = 'WALLET_LEDGER_JOURNAL_MAP'`,
    [summary.runId]
  );
  assert.strictEqual(rows.length, 1, 'ledger-coverage line item missing from the reconciliation run');
  assert.ok(['MATCHED', 'AMOUNT_MISMATCH'].includes(rows[0].state), `unexpected state ${rows[0].state}`);
  assert.ok(Number(rows[0].journal_balance) >= 0, 'orphan count is negative');
});

/* ------------------------------------------------------------------ */

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    try {
      await s.fn();
      console.log(`PASS ${s.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}\n     ${(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')}`);
    }
  }

  console.log(`RESULT: ${scenarios.length - failed} passed, ${failed} failed of ${scenarios.length}`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})();
