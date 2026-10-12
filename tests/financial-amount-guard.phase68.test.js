'use strict';
/**
 * Phase 68 — financial-amount guard regression suite (plain Node, no new deps).
 *
 * Proves that every exported financial-engine primitive, plus postJournal,
 * rejects NaN / +-Infinity / zero / negative / invalid-type amounts BEFORE any
 * financial_operations, journal_entries or financial_audit_log row is written,
 * and that valid amounts, idempotency and concurrency behave.
 *
 * RUN (new, verified disposable DB only):
 *   DB_NAME=phase68_amount_guard_<unique_suffix> \
 *   PHASE68_TEST_DB=phase68_amount_guard_<unique_suffix> \
 *   DB_HOST=<verified_isolated_host> DB_PORT=<verified_isolated_port> \
 *   DB_USER=<verified_test_user> DB_PASSWORD=<verified_test_password> \
 *   node tests/financial-amount-guard.phase68.test.js
 *
 * SAFETY: requires an explicit matching disposable DB name and checks the
 * connected database identity before any write-capable test.
 */

const assert = require('node:assert/strict');

const ROOT = require('node:path').join(__dirname, '..');
const pool = require(ROOT + '/src/config/db');
const fin = require(ROOT + '/src/services/financialEngine');
const recon = require(ROOT + '/src/jobs/balanceReconciliation');

const EXPECTED_DB = process.env.PHASE68_TEST_DB;
const DENYLIST = [
  'afrikoba_regression', 'afrikoba_global', 'afrikoba',
  'afrikoba_staging', 'postgres', 'phase68_guard',
  'phase68_remed_dryrun',
];

const INVALIDS = [
  ['neg100', -100], ['neg1', -1], ['zero', 0],
  ['NaN', NaN], ['Infinity', Infinity], ['negInfinity', -Infinity],
  ['strNonNumeric', 'abc'], ['null', null], ['undefined', undefined],
  ['boolean', true], ['array', [5]], ['object', {}],
];

let pass = 0, fail = 0;
const failures = [];
async function expectReject400(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (err && err.statusCode === 400) pass++;
  else { fail++; failures.push(`${name}: expected statusCode 400, got ${err ? (err.statusCode || err.code || err.message) : 'NO THROW'}`); }
}
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); } }

async function tableRefCounts(prefix, queryable = pool) {
  const r = await queryable.query(
    `SELECT
       (SELECT count(*) FROM financial_operations WHERE reference_id LIKE $1) fo,
       (SELECT count(*) FROM journal_entries    WHERE reference_id LIKE $1) je,
       (SELECT count(*) FROM financial_audit_log WHERE reference_id LIKE $1) fa`, [prefix + '%']);
  return r.rows[0];
}
async function ledgerCounts(ref) {
  const r = await pool.query(
    `SELECT
       (SELECT count(*) FROM financial_operations WHERE reference_id=$1) fo,
       (SELECT count(*) FROM journal_entries    WHERE reference_id=$1) je,
       (SELECT count(*) FROM financial_audit_log WHERE reference_id=$1) fa`, [ref]);
  return r.rows[0];
}
async function wallet(id) {
  const r = await pool.query('SELECT wallet_balance::float8 w, locked_balance::float8 l FROM users WHERE id=$1', [id]);
  return r.rows[0];
}

async function main() {
  // ---- 0. Database identity gate (before any write-capable test) ----
  if (
    !EXPECTED_DB ||
    !process.env.DB_NAME ||
    process.env.DB_NAME !== EXPECTED_DB ||
    !/^phase68_amount_guard_[a-z0-9_]+$/i.test(EXPECTED_DB)
  ) {
    throw new Error(
      'REFUSING to run: DB_NAME and PHASE68_TEST_DB must match an explicit ' +
      'phase68_amount_guard_<unique_suffix> disposable database name.'
    );
  }

  const identity = await pool.query(
    'SELECT current_database() AS db, inet_server_addr()::text AS server_addr, inet_server_port() AS server_port'
  );
  const { db, server_addr, server_port } = identity.rows[0];
  console.log(`[guard] target database = ${db}; server=${server_addr}:${server_port}`);

  if (DENYLIST.includes(db) || db !== EXPECTED_DB) {
    throw new Error(
      `REFUSING to run write-capable tests against '${db}' (expected '${EXPECTED_DB}')`
    );
  }

  // ---- 1. Invalid matrix across all 13 primitives, zero residue ----
  {
    const client = await pool.connect();
    const specs = [
      ['postDeposit', 0, (v, ref) => fin.postDeposit({ userId: 1, amount: v, commission: 0, reference: ref, externalTxId: ref })],
      ['holdFunds', 0, (v, ref) => fin.holdFunds({ userId: 1, amount: v, reference: ref })],
      ['releaseHold', 0, (v, ref) => fin.releaseHold({ userId: 1, amount: v, reference: ref })],
      ['captureHold', 0, (v, ref) => fin.captureHold({ userId: 1, amount: v, reference: ref })],
      ['transfer', 0, (v, ref) => fin.transfer({ fromUserId: 1, toUserId: 3, amount: v, reference: ref })],
      ['creditWallet', 1, (v, ref) => fin.creditWallet({ client, userId: 1, amount: v, reference: ref })],
      ['debitWallet', 1, (v, ref) => fin.debitWallet({ client, userId: 1, amount: v, reference: ref })],
      ['internalTransfer', 1, (v, ref) => fin.internalTransfer({ client, fromUserId: 1, toUserId: 3, amount: v, reference: ref })],
      ['walletToGroup', 1, (v, ref) => fin.walletToGroup({ client, userId: 1, groupId: 1, amount: v, reference: ref })],
      ['groupToWallet', 1, (v, ref) => fin.groupToWallet({ client, userId: 1, groupId: 1, amount: v, reference: ref })],
      ['lockWallet', 1, (v, ref) => fin.lockWallet({ client, userId: 1, amount: v, reference: ref })],
      ['unlockWallet', 1, (v, ref) => fin.unlockWallet({ client, userId: 1, amount: v, reference: ref })],
      ['captureLock', 1, (v, ref) => fin.captureLock({ client, userId: 1, amount: v, reference: ref })],
    ];
    for (const [name, needsClient, call] of specs) {
      if (needsClient) await client.query('BEGIN');
      const prefix = `T68-${name}-${Date.now()}`;
      const queryable = needsClient ? client : pool;
      const before = await tableRefCounts(prefix, queryable);
      for (const [label, v] of INVALIDS) {
        await expectReject400(`${name}(${label})`, () => call(v, `${prefix}-${label}`));
      }
      const after = await tableRefCounts(prefix, queryable);
      ok(Number(after.fo) === Number(before.fo), `${name}: financial_operations residue ${before.fo}->${after.fo}`);
      ok(Number(after.je) === Number(before.je), `${name}: journal_entries residue ${before.je}->${after.je}`);
      ok(Number(after.fa) === Number(before.fa), `${name}: financial_audit_log residue ${before.fa}->${after.fa}`);
      if (needsClient) await client.query('ROLLBACK');
    }
    client.release();
    console.log(`[guard] invalid matrix: ${pass} passed, ${fail} failed`);
  }

  // ---- 2. postDeposit NaN commission (G2) ----
  {
    const ref = `T68-PD-COMM-${Date.now()}`;
    await expectReject400('postDeposit(NaN commission)',
      () => fin.postDeposit({ userId: 1, amount: 10, commission: NaN, reference: ref }));
    const lc = await ledgerCounts(ref);
    ok(Number(lc.fo) === 0 && Number(lc.je) === 0 && Number(lc.fa) === 0, `postDeposit NaN commission residue ${JSON.stringify(lc)}`);
  }

  // ---- 3. postJournal validation (amount/direction/balance/non-finite) ----
  {
    const client = await pool.connect();
    const bad = [
      ['NaN amount', { lines: [{ accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: NaN }, { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: NaN }] }],
      ['zero amount', { lines: [{ accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: 0 }, { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: 0 }] }],
      ['Infinity amount', { lines: [{ accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: Infinity }, { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: Infinity }] }],
      ['bad direction', { lines: [{ accountCode: 'CUSTOMER_WALLET', direction: 'XX', amount: 5 }, { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: 5 }] }],
      ['unbalanced', { lines: [{ accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: 10 }, { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: 5 }] }],
    ];
    for (const [label, body] of bad) {
      await client.query('BEGIN');
      const ref = `T68-PJ-${label.replace(/\W/g, '')}-${Date.now()}`;
      let err = null;
      try { await fin.postJournal({ client, lines: body.lines, referenceId: ref, description: 't68' }); } catch (e) { err = e; }
      ok(!!err, `postJournal(${label}) must throw`);
      const c = await client.query(
        'SELECT count(*)::int n FROM journal_entries WHERE reference_id=$1',
        [ref]
      );
      ok(c.rows[0].n === 0, `postJournal(${label}) residue ${c.rows[0].n}`);
      await client.query('ROLLBACK');
    }
    client.release();
  }

  // ---- 4. Valid-amount regression (balances + journal integrity) ----
  {
    const w0 = await wallet(1);
    const rev0 = (await pool.query('SELECT total_commission::float8 t FROM company_revenue WHERE id=1')).rows[0].t;
    const ref = `T68-VAL-PD-${Date.now()}`;
    const res = await fin.postDeposit({ userId: 1, amount: 10, commission: 1, reference: ref });
    ok(res && res.success === true, 'valid postDeposit succeeds');
    const lc = await ledgerCounts(ref);
    ok(Number(lc.fo) === 1, `valid postDeposit financial_operations=${lc.fo}`);
    ok(Number(lc.je) === 3, `valid postDeposit journal lines=${lc.je} (expect 3)`);
    const w1 = await wallet(1);
    ok(Math.abs((w1.w - w0.w) - 10) < 1e-6, `valid deposit wallet ${w0.w}->${w1.w} (+10)`);
    const rev1 = (await pool.query('SELECT total_commission::float8 t FROM company_revenue WHERE id=1')).rows[0].t;
    ok(Math.abs((rev1 - rev0) - 1) < 1e-6, `valid deposit commission ${rev0}->${rev1} (+1)`);

    const dup = await fin.postDeposit({ userId: 1, amount: 10, commission: 1, reference: ref });
    ok(dup && dup.dedup === true, 'repeat postDeposit is dedup');
    const w2 = await wallet(1);
    ok(Math.abs(w2.w - w1.w) < 1e-6, `dedup did not change wallet ${w1.w}->${w2.w}`);

    const h1 = await wallet(1);
    await fin.holdFunds({ userId: 1, amount: 5, reference: `T68-VAL-H-${Date.now()}` });
    const h2 = await wallet(1);
    ok(Math.abs((h1.w - h2.w) - 5) < 1e-6 && Math.abs((h2.l - h1.l) - 5) < 1e-6, `hold 5: wallet -5 locked +5 (${JSON.stringify(h2)})`);
    await fin.releaseHold({ userId: 1, amount: 5, reference: `T68-VAL-R-${Date.now()}` });
    const h3 = await wallet(1);
    ok(Math.abs(h3.w - h1.w) < 1e-6 && Math.abs(h3.l - h1.l) < 1e-6, `release 5 restores ${JSON.stringify(h3)}`);
    await fin.holdFunds({ userId: 1, amount: 4, reference: `T68-VAL-H2-${Date.now()}` });
    await fin.captureHold({ userId: 1, amount: 4, reference: `T68-VAL-C-${Date.now()}` });
    const h4 = await wallet(1);
    ok(Math.abs(h4.l - h1.l) < 1e-6, `capture 4 restores locked ${h4.l}`);

    const u3a = await wallet(3);
    await fin.transfer({ fromUserId: 1, toUserId: 3, amount: 2, reference: `T68-VAL-T-${Date.now()}` });
    const u1b = await wallet(1), u3b = await wallet(3);
    ok(Math.abs((u3b.w - u3a.w) - 2) < 1e-6, `transfer credited recipient +2 (${u3a.w}->${u3b.w})`);
    ok(Math.abs((u1b.w - h4.w) + 2) < 1e-6, `transfer debited sender -2 (${h4.w}->${u1b.w})`);
  }

  // ---- 5. Concurrency / idempotency (same ref, parallel) ----
  {
    const ref = `T68-CC-${Date.now()}`;
    const w0 = await wallet(1);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
      fin.postDeposit({ userId: 1, amount: 7, commission: 0, reference: ref })));
    const posted = results.filter((r) => r.status === 'fulfilled' && r.value && r.value.success === true).length;
    const deduped = results.filter((r) => r.status === 'fulfilled' && r.value && r.value.dedup === true).length;
    const lc = await ledgerCounts(ref);
    const w1 = await wallet(1);
    ok(posted + deduped === 5, `concurrent classified ${posted} posted / ${deduped} dedup`);
    ok(posted === 1, `concurrent exactly one effect (posted=${posted})`);
    ok(Number(lc.fo) === 1 && Number(lc.je) === 2, `concurrent single ledger set fo=${lc.fo} je=${lc.je}`);
    ok(Math.abs((w1.w - w0.w) - 7) < 1e-6, `concurrent wallet +7 once (${w0.w}->${w1.w})`);
  }

  // ---- 6. DB-level finiteness constraints (migration 139) ----
  {
    const client = await pool.connect();
    try {
      let err1 = null;
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE users SET wallet_balance='NaN' WHERE id=1`
        );
      } catch (e) {
        err1 = e;
      } finally {
        await client.query('ROLLBACK');
      }
      ok(
        !!err1,
        `users.wallet_balance='NaN' rejected at DB (${err1 ? err1.code : 'ACCEPTED!'})`
      );

      const jr = await client.query(
        'SELECT id, posted_at::text AS posted_at FROM journal_entries ORDER BY posted_at LIMIT 1'
      );
      if (jr.rows.length) {
        let err2 = null;
        await client.query('BEGIN');
        try {
          await client.query(
            `UPDATE journal_entries SET amount='NaN' WHERE id=$1 AND posted_at=$2`,
            [jr.rows[0].id, jr.rows[0].posted_at]
          );
        } catch (e) {
          err2 = e;
        } finally {
          await client.query('ROLLBACK');
        }
        ok(
          !!err2,
          `journal_entries.amount='NaN' rejected at DB (${err2 ? err2.code : 'ACCEPTED!'})`
        );
      }
    } finally {
      client.release();
    }
  }

  // ---- 7. Invariants + reconciliation smoke (no ReferenceError) ----
  {
    const inv = await pool.query('SELECT check_name, ok FROM fn_financial_invariants()');
    ok(inv.rows.length >= 3, `fn_financial_invariants rows=${inv.rows.length} (>=3)`);
    ok(inv.rows.every((r) => r.ok === true), `all invariants ok on clean isolated DB: ${JSON.stringify(inv.rows)}`);
    let rerr = null, summary = null;
    try { summary = await recon.runBalanceReconciliation('MANUAL'); } catch (e) { rerr = e; }
    ok(!rerr, `runBalanceReconciliation completes (err=${rerr ? rerr.message : 'none'})`);
    ok(summary && summary.totalChecked > 0, `reconciliation checked ${summary ? summary.totalChecked : 'n/a'} accounts`);
  }

  console.log(`\n=== AMOUNT-GUARD SUITE: ${pass} passed, ${fail} failed ===`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(' - ' + f)); }
  return fail;
}

main()
  .then((f) => { pool.end().catch(() => {}); process.exit(f === 0 ? 0 : 1); })
  .catch((e) => { console.error('SUITE ERROR:', e.message); pool.end().catch(() => {}); process.exit(2); });
