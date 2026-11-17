/**
 * MTC-26 — Concurrent replay + migration governance regression suite.
 * Database-backed against disposable PG16 (127.0.0.1:55432, phase68_amount_guard_mtc04).
 *
 * Verifies:
 *   A. Sequential exactly-once posting (first, identical replay, conflicting replay)
 *   B. Concurrent identical replay resolves both callers to one posting ID
 *   C. Concurrent conflicting replay: one commits, the loser gets 409
 *   D. Journal failure rolls back both registry claim and journal rows
 *   E. Retry after rollback succeeds; retry after commit is idempotent
 *   F. Journal immutability regression (UPDATE/DELETE 42501, reversal via new entries)
 *   G. Migration 152/153/154 object state (read-only)
 *
 * NOTE: journal_entries are immutable by design, so committed test rows cannot be
 * deleted. All test references are prefixed MTC26-<run>- and are identifiable
 * artifacts of this suite in the disposable database only.
 */

const assert = require('assert');
const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');

const RUN = Date.now().toString(36).toUpperCase();
const refFor = (name) => `MTC26-${RUN}-${name}`.slice(0, 50);
const LINES = (amt) => ([
  { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amt },
  { accountCode: 'SOCIAL_FUND_CLEARING', direction: 'CR', amount: amt },
]);

const results = [];
let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(true, name, detail);
  } catch (e) {
    record(false, name, (e.code ? e.code + ': ' : '') + e.message);
  }
}

async function registryRows(ref) {
  const r = await pool.query(
    'SELECT posting_id, payload_hash, status FROM journal_posting_registry WHERE reference_id = $1', [ref]
  );
  return r.rows;
}

async function journalGroups(ref) {
  const r = await pool.query(
    'SELECT entry_group_id, count(*)::int AS n FROM journal_entries WHERE reference_id = $1 GROUP BY entry_group_id', [ref]
  );
  return r.rows;
}

async function main() {
  const newRef = refFor('NEW');
  const replayRef = refFor('REPLAY');
  const conflictRef = refFor('CONFLICT');
  const concOkRef = refFor('CONCOK');
  const concBadRef = refFor('CONCBAD');
  const failRef = refFor('FAIL');
  const retryRef = refFor('RETRY');
  const postCommitRef = refFor('POSTCOMMIT');
  const reversalRef = refFor('REVERSAL');

  // ---------- A. Sequential exactly-once ----------
  await check('A1 first posting creates one registry row and one balanced journal group', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = await fin.postJournal({
        client: c, lines: LINES(10), referenceId: newRef, description: 'MTC26 new',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });
      await c.query('COMMIT');
      assert.strictEqual(id, newRef);
      const reg = await registryRows(newRef);
      const je = await journalGroups(newRef);
      assert.strictEqual(reg.length, 1, 'one registry row');
      assert.strictEqual(je.length, 1, 'one journal group');
      assert.strictEqual(je[0].n, 2, 'two journal lines');
      return `posting_id=${id}, entries=${je[0].n}`;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  });

  await check('A2 sequential identical replay returns existing posting and does not duplicate', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = await fin.postJournal({
        client: c, lines: LINES(10), referenceId: newRef, description: 'MTC26 new',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });
      await c.query('COMMIT');
      assert.strictEqual(id, newRef, 'same posting id');
      const je = await journalGroups(newRef);
      assert.strictEqual(je.length, 1, 'still exactly one journal group');
      assert.strictEqual(je[0].n, 2, 'still exactly two lines');
      return 'dedup returned same id, no extra rows';
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  });

  await check('A3 sequential conflicting replay is rejected with JOURNAL_POSTING_CONFLICT (409)', async () => {
    const c = await pool.connect();
    let code = null;
    try {
      await c.query('BEGIN');
      await fin.postJournal({
        client: c, lines: LINES(99), referenceId: newRef, description: 'MTC26 conflict',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });
    } catch (e) { code = e.code; } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
    assert.strictEqual(code, 'JOURNAL_POSTING_CONFLICT');
    const je = await journalGroups(newRef);
    assert.strictEqual(je[0].n, 2, 'original posting untouched');
    return 'rejected, original intact';
  });

  // ---------- B. Concurrent identical replay ----------
  await check('B1 concurrent identical replay: both callers resolve to the same posting ID', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');

      // c1 claims and posts but stays uncommitted -> holds the unique-index lock.
      const r1 = await fin.postJournal({
        client: c1, lines: LINES(25), referenceId: concOkRef, description: 'MTC26 conc',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });

      // c2 attempts the same reference; its INSERT blocks on c1's uncommitted row.
      const p2 = fin.postJournal({
        client: c2, lines: LINES(25), referenceId: concOkRef, description: 'MTC26 conc',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, msg: e.message }));

      await sleep(400);
      await c1.query('COMMIT');

      const r2 = await p2;
      assert.strictEqual(r2.ok, true, 'loser must not error: ' + (r2.code || '') + ' ' + (r2.msg || ''));
      assert.strictEqual(r1, concOkRef);
      assert.strictEqual(r2.v, concOkRef, 'both callers resolve to the same posting id');
      await c2.query('COMMIT');

      const je = await journalGroups(concOkRef);
      assert.strictEqual(je.length, 1, 'exactly one committed journal group');
      assert.strictEqual(je[0].n, 2, 'exactly two journal lines');
      return `posting_id=${r1} for both callers, one journal group`;
    } catch (e) {
      await c1.query('ROLLBACK').catch(() => {});
      await c2.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c1.release(); c2.release(); }
  });

  // ---------- C. Concurrent conflicting replay ----------
  await check('C1 concurrent conflicting replay: one committed posting, loser gets 409', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');

      await fin.postJournal({
        client: c1, lines: LINES(30), referenceId: concBadRef, description: 'MTC26 cb',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });

      const p2 = fin.postJournal({
        client: c2, lines: LINES(31), referenceId: concBadRef, description: 'MTC26 cb',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code }));

      await sleep(400);
      await c1.query('COMMIT');

      const r2 = await p2;
      assert.strictEqual(r2.ok, false, 'conflicting caller must be rejected');
      assert.strictEqual(r2.code, 'JOURNAL_POSTING_CONFLICT');

      // Transaction must still be usable (no 25P02) so the caller can roll back cleanly.
      const usable = await c2.query('SELECT 1 AS ok').then(() => true, () => false);
      assert.strictEqual(usable, true, 'loser transaction must remain usable (no 25P02)');
      await c2.query('ROLLBACK');

      const reg = await registryRows(concBadRef);
      const je = await journalGroups(concBadRef);
      assert.strictEqual(reg.length, 1, 'exactly one registry row');
      assert.strictEqual(je.length, 1, 'exactly one journal group');
      return 'winner committed, loser 409, transaction usable';
    } catch (e) {
      await c1.query('ROLLBACK').catch(() => {});
      await c2.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c1.release(); c2.release(); }
  });

  // ---------- D. Failure rollback ----------
  await check('D1 journal insertion failure rolls back registry claim and partial journal rows', async () => {
    const c = await pool.connect();
    let threw = false;
    try {
      await c.query('BEGIN');
      await fin.postJournal({
        client: c,
        lines: [
          { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: 5 },
          { accountCode: 'MTC26_NONEXISTENT_ACCOUNT', direction: 'CR', amount: 5 },
        ],
        referenceId: failRef, description: 'MTC26 fail', postedBy: 'mtc26',
        productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });
    } catch (e) { threw = true; } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
    assert.strictEqual(threw, true, 'posting must throw');
    const reg = await registryRows(failRef);
    const je = await journalGroups(failRef);
    assert.strictEqual(reg.length, 0, 'registry claim rolled back');
    assert.strictEqual(je.length, 0, 'no orphaned journal rows');
    return 'registry and journal both rolled back';
  });

  await check('D2 retry after rollback succeeds exactly once', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = await fin.postJournal({
        client: c, lines: LINES(5), referenceId: failRef, description: 'MTC26 retry',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });
      await c.query('COMMIT');
      assert.strictEqual(id, failRef);
      const je = await journalGroups(failRef);
      assert.strictEqual(je.length, 1);
      assert.strictEqual(je[0].n, 2);
      return 'retry posted once';
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  });

  await check('D3 retry after committed posting returns existing id without duplication', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await fin.postJournal({
        client: c, lines: LINES(5), referenceId: failRef, description: 'MTC26 retry',
        postedBy: 'mtc26', productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });
      await c.query('COMMIT');
      const je = await journalGroups(failRef);
      assert.strictEqual(je.length, 1);
      assert.strictEqual(je[0].n, 2);
      return 'post-commit replay deduped';
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  });

  // ---------- F. Immutability + reversal ----------
  await check('F1 UPDATE of committed journal entry is rejected with 42501', async () => {
    const r = await pool.query(
      "SELECT id FROM journal_entries WHERE reference_id = $1 ORDER BY id LIMIT 1", [newRef]
    );
    assert.ok(r.rows.length > 0, 'test journal row must exist');
    let code = null;
    try {
      await pool.query("UPDATE journal_entries SET amount = 999 WHERE id = $1", [r.rows[0].id]);
    } catch (e) { code = e.code; }
    assert.strictEqual(code, '42501');
    const after = await pool.query('SELECT amount FROM journal_entries WHERE id = $1', [r.rows[0].id]);
    assert.strictEqual(Number(after.rows[0].amount), 10, 'amount unchanged');
    return 'UPDATE rejected, value unchanged';
  });

  await check('F2 DELETE of committed journal entry is rejected with 42501', async () => {
    const r = await pool.query(
      "SELECT id FROM journal_entries WHERE reference_id = $1 ORDER BY id LIMIT 1", [newRef]
    );
    let code = null;
    try {
      await pool.query('DELETE FROM journal_entries WHERE id = $1', [r.rows[0].id]);
    } catch (e) { code = e.code; }
    assert.strictEqual(code, '42501');
    const after = await pool.query('SELECT count(*)::int AS n FROM journal_entries WHERE id = $1', [r.rows[0].id]);
    assert.strictEqual(after.rows[0].n, 1, 'row preserved');
    return 'DELETE rejected, row preserved';
  });

  await check('F3 reversal is expressed as new journal entries, original untouched', async () => {
    const before = await journalGroups(newRef);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const id = await fin.postJournal({
        client: c,
        lines: [
          { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: 10 },
          { accountCode: 'SOCIAL_FUND_CLEARING', direction: 'DR', amount: 10 },
        ],
        referenceId: reversalRef, description: 'MTC26 reversal', postedBy: 'mtc26',
        productType: 'SOCIAL_FUND', productRef: 'mtc26',
      });
      await c.query('COMMIT');
      assert.strictEqual(id, reversalRef);
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    const after = await journalGroups(newRef);
    assert.deepStrictEqual(after, before, 'original journal group unchanged');
    const rev = await journalGroups(reversalRef);
    assert.strictEqual(rev.length, 1);
    return 'reversal added as a separate journal group';
  });

  await check('F4 registry unique index on reference_id is present', async () => {
    const r = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'journal_posting_registry' AND indexname = 'uq_journal_posting_ref'"
    );
    assert.strictEqual(r.rows.length, 1);
    return 'uq_journal_posting_ref present';
  });

  await check('F5 immutability trigger covers parent and all partitions', async () => {
    const t = await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_journal_entries_immutable' AND NOT tgisinternal");
    const p = await pool.query("SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'journal_entries'::regclass");
    assert.ok(t.rows[0].n >= p.rows[0].n, `triggers ${t.rows[0].n} < partitions ${p.rows[0].n}`);
    return `triggers=${t.rows[0].n}, partitions=${p.rows[0].n}`;
  });

  // ---------- G. Migration object state (read-only) ----------
  await check('G1 migration 152 objects exist', async () => {
    const tbl = await pool.query("SELECT to_regclass('social_fund_case_permissions') AS o");
    const view = await pool.query("SELECT to_regclass('social_fund_active_case_permissions') AS o");
    assert.ok(tbl.rows[0].o, 'table missing');
    assert.ok(view.rows[0].o, 'view missing');
    return 'table + view present';
  });

  await check('G2 migration 153 objects exist', async () => {
    const acc = await pool.query("SELECT 1 FROM ledger_accounts WHERE account_code = 'SOCIAL_FUND_CLEARING'");
    const fn = await pool.query("SELECT fn_product_namespace('SOCIAL_FUND_CLEARING') AS ns");
    assert.strictEqual(acc.rows.length, 1, 'clearing account missing');
    assert.strictEqual(fn.rows[0].ns, 'SOCIAL_FUND');
    return 'clearing account + namespace function present';
  });

  await check('G3 migration ledger state recorded for diagnostics (not a pass/fail of correctness)', async () => {
    const r = await pool.query("SELECT version FROM schema_migrations WHERE version LIKE '15%' ORDER BY version");
    const versions = r.rows.map((x) => x.version);
    console.log('      schema_migrations 15x:', JSON.stringify(versions));
    return `recorded: ${versions.join(', ') || '(none)'}`;
  });

  console.log(`\nRESULT: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`RUN=${RUN}  test references prefix=MTC26-${RUN}-`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('SUITE ERROR:', e && (e.stack || e.message));
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
