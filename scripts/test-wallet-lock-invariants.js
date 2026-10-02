/* ============================================================
 * AFRIKOBA GLOBAL - PHASE 64 REGRESSION
 * Wallet LOCK / UNLOCK / CAPTURE primitive invariants.
 *
 * Scope: direct engine-level tests for lockWallet(), unlockWallet(),
 * captureLock() in src/services/financialEngine.js.
 *
 * This suite deliberately does NOT go through HTTP. test-cards.js
 * proves the card happy-path only; it never exercises the engine's
 * idempotency gate, its guarded-projection failure branches, or its
 * rollback semantics. This file covers those.
 *
 * Coverage map (invariant id -> test):
 *   INV-1 wallet+locked conserved by LOCK/UNLOCK   -> T1
 *   INV-2 LOCK requires sufficient available        -> T4, T9
 *   INV-3 UNLOCK requires sufficient locked         -> T5
 *   INV-4 CAPTURE requires sufficient locked        -> T6
 *   INV-5 exactly one balanced journal group       -> T1,T2,T3
 *   INV-6 reference is idempotent                   -> T3
 *   INV-7 retry cannot create 2nd economic effect   -> T3
 *   INV-8 failed guard leaves no journal/audit      -> T4,T5,T6
 *   INV-9 journal failure rolls back projection    -> T7
 *   INV-10 op state atomic with mutation           -> T10
 *   INV-11 concurrency cannot overdraw              -> T8
 *   INV-12 amount must be positive (DEFECT PROBE)  -> T9
 *
 * SAFETY: this suite performs real money mutations. It refuses to
 * run unless P64_ALLOW_MUTATION=1 is set and the target database
 * looks like a regression/staging database. It must never be
 * pointed at production.
 * ============================================================ */
const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');
const crypto = require('crypto');

const REF = () => 'P64-' + crypto.randomBytes(6).toString('hex').toUpperCase();

// ---------------------------------------------------------------- safety gate
function assertSafeToMutate() {
  const dbName = process.env.DB_NAME || 'afrikoba_global';
  const allow = process.env.P64_ALLOW_MUTATION;
  const prodNames = /prod|production|live|master|primary/i;
  if (allow !== '1') {
    console.error('BLOCKED: set P64_ALLOW_MUTATION=1 to run. This suite mutates balances.');
    process.exit(2);
  }
  if (prodNames.test(dbName)) {
    console.error(`BLOCKED: DB_NAME="${dbName}" looks like production. Refusing to mutate.`);
    process.exit(2);
  }
  if (process.env.NODE_ENV === 'production' && !process.env.P64_I_CONFIRM_NONPROD) {
    console.error('BLOCKED: NODE_ENV=production. Set P64_I_CONFIRM_NONPROD=1 if this is really a regression DB.');
    process.exit(2);
  }
  console.log(`Safety gate OK -> db=${dbName} node_env=${process.env.NODE_ENV || '(unset)'}`);
}

let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  PASS  ${label}`); }
function fail(label, extra) { failed++; failures.push(label); console.log(`  FAIL  ${label}${extra ? ' :: ' + extra : ''}`); }
function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra); }
function section(label) { console.log(`\n--- ${label} ---`); }

// ------------------------------------------------------------------- fixtures
async function makeUser(wallet = 0, locked = 0) {
  const phone = '2559' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  const r = await pool.query(
    `INSERT INTO users (full_name, phone_number, role, wallet_balance, locked_balance)
     VALUES ($1,$2,'MJUMBE',$3,$4) RETURNING id`,
    ['P64 Harness', phone, wallet, locked]
  );
  return r.rows[0].id;
}
async function balances(userId) {
  const r = await pool.query('SELECT wallet_balance, locked_balance FROM users WHERE id = $1', [userId]);
  return { wallet: Number(r.rows[0].wallet_balance), locked: Number(r.rows[0].locked_balance) };
}
async function journalFor(reference) {
  const r = await pool.query(
    `SELECT j.direction, j.amount, la.account_code AS acct
       FROM journal_entries j JOIN ledger_accounts la ON la.id = j.account_id
      WHERE j.reference_id = $1 ORDER BY j.id`,
    [reference]
  );
  return {
    rows: r.rows,
    n: r.rows.length,
    dr: r.rows.filter((x) => x.direction === 'DR').reduce((s, x) => s + Number(x.amount), 0),
    cr: r.rows.filter((x) => x.direction === 'CR').reduce((s, x) => s + Number(x.amount), 0),
    balanced: Math.abs(r.rows.filter((x) => x.direction === 'DR').reduce((s, x) => s + Number(x.amount), 0)
                     - r.rows.filter((x) => x.direction === 'CR').reduce((s, x) => s + Number(x.amount), 0)) < 0.000001,
    codes: r.rows.map((x) => x.acct).sort(),
  };
}
async function opsFor(reference) {
  const r = await pool.query(
    'SELECT operation_type, status, amount FROM financial_operations WHERE reference_id = $1', [reference]
  );
  return r.rows;
}
async function auditFor(reference) {
  const r = await pool.query('SELECT operation, account_kind FROM financial_audit_log WHERE reference_id = $1', [reference]);
  return r.rows;
}

/** Run fn inside a transaction exactly like the real callers do. */
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

(async () => {
  assertSafeToMutate();

  // ---- preflight: schema must actually support the primitives -------------
  section('Preflight schema contract');
  const ucols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='users' AND column_name IN ('wallet_balance','locked_balance')`
  );
  const uc = ucols.rows.map((r) => r.column_name);
  expect(uc.length === 2, 'users has wallet_balance AND locked_balance columns', JSON.stringify(uc));
  if (uc.length < 2) {
    console.log('\nFATAL: users.locked_balance missing -> lock primitives cannot run. Aborting.');
    console.log(`FAILED ${passed}/${passed + failed}`);
    process.exit(1);
  }
  const accs = await pool.query(
    `SELECT account_code FROM ledger_accounts
      WHERE account_code IN ('CARD_HOLD','CUSTOMER_WALLET','MNO_CLEARING')`
  );
  const ac = accs.rows.map((r) => r.account_code).sort();
  expect(['CARD_HOLD', 'CUSTOMER_WALLET', 'MNO_CLEARING'].every((a) => ac.includes(a)),
    'ledger_accounts has CARD_HOLD, CUSTOMER_WALLET, MNO_CLEARING', JSON.stringify(ac));
  const uniq = await pool.query(
    `SELECT count(*)::int n FROM pg_constraint
      WHERE conrelid='financial_operations'::regclass AND contype='u'`
  );
  expect(uniq.rows[0].n >= 1, 'financial_operations has a UNIQUE constraint (claimOperation ON CONFLICT works)', `n=${uniq.rows[0].n}`);
  const chk = await pool.query(
    `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conrelid='users'::regclass AND contype='c'`
  );
  const hasNonNeg = chk.rows.some((r) => /wallet_balance|locked_balance/.test(r.d) && />= *0/.test(r.d));
  expect(hasNonNeg, 'users carries DB-level CHECK preventing negative balances', JSON.stringify(chk.rows.map((r) => r.d)));

  // ---- T1: LOCK -> UNLOCK round trip, total conserved ---------------------
  section('T1  LOCK -> UNLOCK round trip (INV-1, INV-5)');
  {
    const uid = await makeUser(100000, 0);
    const refL = REF(), refU = REF();
    const t0 = await balances(uid);
    await inTx((c) => fin.lockWallet({ client: c, userId: uid, amount: 30000, reference: refL }));
    const t1 = await balances(uid);
    expect(t1.wallet === 70000 && t1.locked === 30000, 'LOCK moves 30,000 available -> locked', JSON.stringify(t1));
    expect(t1.wallet + t1.locked === t0.wallet + t0.locked, 'INV-1 wallet+locked total unchanged by LOCK',
      `${t0.wallet}+${t0.locked} -> ${t1.wallet}+${t1.locked}`);
    const jL = await journalFor(refL);
    expect(jL.n === 2 && jL.balanced && jL.dr === 30000 && jL.cr === 30000
      && jL.codes.join(',') === 'CARD_HOLD,CUSTOMER_WALLET',
      'INV-5 LOCK posts exactly one balanced 2-line group DR CUSTOMER_WALLET / CR CARD_HOLD', JSON.stringify(jL.codes));

    await inTx((c) => fin.unlockWallet({ client: c, userId: uid, amount: 30000, reference: refU }));
    const t2 = await balances(uid);
    expect(t2.wallet === 100000 && t2.locked === 0, 'UNLOCK returns 30,000 locked -> available', JSON.stringify(t2));
    expect(t2.wallet + t2.locked === t0.wallet + t0.locked, 'INV-1 total unchanged by UNLOCK', JSON.stringify(t2));
    const jU = await journalFor(refU);
    expect(jU.n === 2 && jU.balanced && jU.dr === 30000 && jU.cr === 30000
      && jU.codes.join(',') === 'CARD_HOLD,CUSTOMER_WALLET',
      'INV-5 UNLOCK balanced DR CARD_HOLD / CR CUSTOMER_WALLET', JSON.stringify(jU.codes));
    const opsU = await opsFor(refU);
    expect(opsU.length === 1 && opsU[0].status === 'SUCCESS', 'INV-10 UNLOCK operation row terminal SUCCESS', JSON.stringify(opsU));
  }

  // ---- T2: LOCK -> CAPTURE, funds leave the platform ----------------------
  section('T2  LOCK -> CAPTURE (INV-4 happy path, INV-5)');
  {
    const uid = await makeUser(80000, 0);
    const refL = REF(), refC = REF();
    await inTx((c) => fin.lockWallet({ client: c, userId: uid, amount: 20000, reference: refL }));
    const t1 = await balances(uid);
    await inTx((c) => fin.captureLock({ client: c, userId: uid, amount: 12000, reference: refC, toAccount: 'MNO_CLEARING' }));
    const t2 = await balances(uid);
    expect(t2.wallet === t1.wallet && t2.locked === t1.locked - 12000,
      'CAPTURE decrements locked only; wallet untouched', JSON.stringify({ before: t1, after: t2 }));
    expect(t2.wallet + t2.locked === t1.wallet + t1.locked - 12000,
      'CAPTURE intentionally reduces total by the captured amount (money leaves)', JSON.stringify(t2));
    const jC = await journalFor(refC);
    expect(jC.n === 2 && jC.balanced && jC.dr === 12000 && jC.cr === 12000
      && jC.codes.join(',') === 'CARD_HOLD,MNO_CLEARING',
      'INV-5 CAPTURE balanced DR CARD_HOLD / CR MNO_CLEARING', JSON.stringify(jC.codes));
  }

  // ---- T3: duplicate retry (INV-6, INV-7) ---------------------------------
  section('T3  Duplicate retry with same reference (INV-6, INV-7)');
  {
    const uid = await makeUser(100000, 0);
    const ref = REF();
    const r1 = await inTx((c) => fin.lockWallet({ client: c, userId: uid, amount: 40000, reference: ref }));
    const after1 = await balances(uid);
    const r2 = await inTx((c) => fin.lockWallet({ client: c, userId: uid, amount: 40000, reference: ref }));
    const after2 = await balances(uid);
    expect(!!r1.success, 'first LOCK succeeded', JSON.stringify(r1));
    expect(r2.dedup === true && r2.success === undefined, 'second LOCK with same reference returns dedup, no success', JSON.stringify(r2));
    expect(after2.wallet === after1.wallet && after2.locked === after1.locked,
      'INV-7 retry created NO second economic effect', JSON.stringify({ after1, after2 }));
    const j = await journalFor(ref);
    expect(j.n === 2, 'INV-5 retry did not add a second journal group', `lines=${j.n}`);
    const ops = await opsFor(ref);
    expect(ops.length === 1, 'INV-6 exactly one financial_operations row for the reference', `rows=${ops.length}`);
    const aud = await auditFor(ref);
    expect(aud.length === 2, 'retry did not duplicate audit rows (USER_BALANCE + USER_LOCKED)', `rows=${aud.length}`);
  }

  // ---- T4: LOCK insufficient available (INV-2, INV-8) ---------------------
  section('T4  LOCK with insufficient available balance (INV-2, INV-8)');
  {
    const uid = await makeUser(5000, 0);
    const ref = REF();
    const before = await balances(uid);
    let threw = null;
    try { await inTx((c) => fin.lockWallet({ client: c, userId: uid, amount: 90000, reference: ref })); }
    catch (e) { threw = e; }
    const after = await balances(uid);
    expect(threw !== null, 'INV-2 LOCK over available balance throws', threw ? threw.message : 'no throw');
    expect(threw && threw.statusCode === 400, 'LOCK rejection is a clean 400 (not a 500)', threw ? String(threw.statusCode) : '-');
    expect(after.wallet === before.wallet && after.locked === before.locked, 'balances unchanged after rejected LOCK', JSON.stringify({ before, after }));
    const j = await journalFor(ref);
    expect(j.n === 0, 'INV-8 failed guard left NO journal rows', `lines=${j.n}`);
    const aud = await auditFor(ref);
    expect(aud.length === 0, 'INV-8 failed guard left NO audit rows', `rows=${aud.length}`);
    const ops = await opsFor(ref);
    expect(ops.length === 0, 'INV-8 operation claim rolled back (no residue)', `rows=${ops.length}`);
  }

  // ---- T5: UNLOCK insufficient locked (INV-3, INV-8) ----------------------
  section('T5  UNLOCK with insufficient locked balance (INV-3, INV-8)');
  {
    const uid = await makeUser(100000, 2000); // only 2,000 locked
    const ref = REF();
    const before = await balances(uid);
    let threw = null;
    try { await inTx((c) => fin.unlockWallet({ client: c, userId: uid, amount: 50000, reference: ref })); }
    catch (e) { threw = e; }
    const after = await balances(uid);
    expect(threw !== null, 'INV-3 UNLOCK beyond locked balance throws', threw ? threw.message : 'no throw');
    expect(after.wallet === before.wallet && after.locked === before.locked, 'UNLOCK rejection changed nothing', JSON.stringify({ before, after }));
    const j = await journalFor(ref);
    expect(j.n === 0, 'INV-8 no journal residue from rejected UNLOCK', `lines=${j.n}`);
    const ops = await opsFor(ref);
    expect(ops.length === 0, 'INV-8 no operation residue from rejected UNLOCK', `rows=${ops.length}`);
  }

  // ---- T6: CAPTURE insufficient locked (INV-4, INV-8) ---------------------
  section('T6  CAPTURE with insufficient locked balance (INV-4, INV-8)');
  {
    const uid = await makeUser(0, 3000);
    const ref = REF();
    const before = await balances(uid);
    let threw = null;
    try { await inTx((c) => fin.captureLock({ client: c, userId: uid, amount: 25000, reference: ref })); }
    catch (e) { threw = e; }
    const after = await balances(uid);
    expect(threw !== null, 'INV-4 CAPTURE beyond locked balance throws', threw ? threw.message : 'no throw');
    expect(after.locked === before.locked, 'CAPTURE rejection did not drive locked negative', JSON.stringify({ before, after }));
    const j = await journalFor(ref);
    expect(j.n === 0, 'INV-8 no journal residue from rejected CAPTURE', `lines=${j.n}`);
    const ops = await opsFor(ref);
    expect(ops.length === 0, 'INV-8 no operation residue from rejected CAPTURE', `rows=${ops.length}`);
  }

  // ---- T7: journal failure rolls back the projection (INV-9) --------------
  // postJournal throws on an unknown account code AFTER the guarded UPDATE
  // has already mutated the projection. Correctness therefore depends on
  // the caller rolling back - this test proves that it does.
  section('T7  Journal failure after guarded projection (INV-9)');
  {
    const uid = await makeUser(70000, 0);
    const ref = REF();
    const before = await balances(uid);
    let threw = null;
    try {
      await inTx((c) => fin.lockWallet({
        client: c, userId: uid, amount: 25000, reference: ref,
        sourceAccount: 'NO_SUCH_LEDGER_ACCOUNT_XYZ',
      }));
    } catch (e) { threw = e; }
    const after = await balances(uid);
    expect(threw !== null, 'unknown ledger account makes postJournal fail', threw ? threw.message : 'no throw');
    expect(after.wallet === before.wallet && after.locked === before.locked,
      'INV-9 projection mutation rolled back with the failed journal', JSON.stringify({ before, after }));
    const j = await journalFor(ref);
    expect(j.n === 0, 'INV-9 no partial journal group survived', `lines=${j.n}`);
    const aud = await auditFor(ref);
    expect(aud.length === 0, 'INV-9 no audit residue', `rows=${aud.length}`);
    const ops = await opsFor(ref);
    expect(ops.length === 0, 'INV-9 operation claim rolled back with the mutation', `rows=${ops.length}`);
  }

  // ---- T8: concurrency cannot overdraw (INV-11) ---------------------------
  section('T8  Concurrent LOCK attempts cannot overdraw (INV-11)');
  {
    const uid = await makeUser(100000, 0);
    const N = 8, each = 30000; // 8 x 30,000 = 240,000 > 100,000 available
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        inTx((c) => fin.lockWallet({ client: c, userId: uid, amount: each, reference: REF() + ':' + i })))
    );
    const okCount = results.filter((r) => r.status === 'fulfilled' && r.value && r.value.success).length;
    const t = await balances(uid);
    expect(t.locked === okCount * each, 'locked balance equals exactly the number of successful locks', `locked=${t.locked} ok=${okCount}`);
    expect(t.locked <= 100000, 'INV-11 concurrent locks never overdraw available balance', `locked=${t.locked} funded=100000`);
    expect(t.wallet === 100000 - t.locked, 'wallet/locked stayed consistent under concurrency', JSON.stringify(t));
    expect(okCount < N, 'INV-11 at least one concurrent lock was refused', `ok=${okCount}/${N}`);
    expect(t.wallet >= 0 && t.locked >= 0, 'INV-11 no negative balance under concurrency', JSON.stringify(t));
  }

  // ---- T9: negative / zero amount (INV-12 defect probe) -------------------
  // NOT in the original Phase 64 list, but the engine has no amount guard.
  // A negative LOCK would flip the sign of the conditional UPDATE and the
  // journal would still balance (DR == CR with negative values).
  section('T9  Negative and zero amounts must be rejected (INV-12)');
  {
    const uid = await makeUser(50000, 5000);
    const before = await balances(uid);
    const probes = [
      ['lockWallet', { amount: -1000 }],
      ['unlockWallet', { amount: -1000 }],
      ['captureLock', { amount: -1000 }],
      ['lockWallet', { amount: 0 }],
    ];
    for (const [fn, args] of probes) {
      const ref = REF();
      let threw = null, res = null;
      try { res = await inTx((c) => fin[fn]({ client: c, userId: uid, reference: ref, ...args })); }
      catch (e) { threw = e; }
      const after = await balances(uid);
      const rejected = threw !== null;
      const clean = rejected && threw.statusCode === 400;
      expect(clean, `INV-12 ${fn}(${args.amount}) is rejected with a clean 400`,
        rejected ? `threw ${threw.statusCode || '(no statusCode)'}: ${threw.message}` : `ACCEPTED, returned ${JSON.stringify(res)}`);
      expect(after.wallet === before.wallet && after.locked === before.locked,
        `INV-12 ${fn}(${args.amount}) left balances untouched`, JSON.stringify({ before, after }));
      const j = await journalFor(ref);
      expect(j.n === 0, `INV-12 ${fn}(${args.amount}) wrote no journal`, `lines=${j.n}`);
      before.wallet = after.wallet; before.locked = after.locked;
    }
  }

  // ---- T10: operation state atomicity (INV-10) ---------------------------
  section('T10  Operation state commits/rolls back atomically (INV-10)');
  {
    const uid = await makeUser(60000, 0);
    const good = REF();
    await inTx((c) => fin.lockWallet({ client: c, userId: uid, amount: 10000, reference: good }));
    let ops = await opsFor(good);
    expect(ops.length === 1 && ops[0].status === 'SUCCESS' && ops[0].operation_type === 'LOCK',
      'INV-10 committed LOCK left exactly one terminal SUCCESS operation row', JSON.stringify(ops));
    const j = await journalFor(good);
    expect(j.n === 2 && j.balanced, 'INV-10 committed LOCK left its balanced journal group', `lines=${j.n}`);

    const bad = REF();
    let threw = null;
    try {
      await inTx((c) => fin.lockWallet({
        client: c, userId: uid, amount: 10000, reference: bad, sourceAccount: 'NO_SUCH_LEDGER_ACCOUNT_XYZ' }));
    } catch (e) { threw = e; }
    ops = await opsFor(bad);
    const jBad = await journalFor(bad);
    expect(ops.length === 0 && jBad.n === 0,
      'INV-10 rolled-back LOCK left neither operation row nor journal (atomic together)', `ops=${ops.length} je=${jBad.n}`);
  }

  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'} ${passed}/${passed + failed} checks`);
  if (failures.length) console.log('Failing: ' + failures.join(' | '));
  await pool.end().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('SUITE_ERROR', e && e.stack ? e.stack : e);
  await pool.end().catch(() => {});
  process.exit(1);
});