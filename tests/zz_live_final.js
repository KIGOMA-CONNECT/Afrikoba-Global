'use strict';
/**
 * FINAL LIVE VALIDATION - financialEngine.js against afrikoba_regression :5436
 * READ-ONLY constraints respected: no migration, no schema mutation, no production.
 * NEW users + NEW references (<=15 chars) per test. TX224 never touched.
 */
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'zz_out_live.txt');
const buf = [];
const say = (s) => { buf.push(s === undefined ? 'undefined' : String(s)); };
const H = (s) => say('\n########## ' + s + ' ##########');

let ERR = 0;
function fail(msg) { ERR++; say('  !! ' + msg); }

function finish(code) {
  try { fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8'); } catch (e) {}
  process.exit(code || 0);
}
process.on('unhandledRejection', (e) => { say('\nFATAL UNHANDLED: ' + ((e && e.stack) || e)); finish(9); });
process.on('uncaughtException', (e) => { say('\nFATAL UNCAUGHT: ' + ((e && e.stack) || e)); finish(9); });

const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const engine = require(path.join(__dirname, '..', 'src', 'services', 'financialEngine'));

const NONCE = Date.now().toString(36).toUpperCase().slice(-6);
let PHONE_SEQ = 0;
const ref = (tag) => ('L' + tag + NONCE).toUpperCase().slice(0, 15);
const T = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT ' + label)), ms || 20000)),
]);

const RESULTS = {};
function record(n, invariant, status, note) {
  RESULTS[n] = { invariant, status, note: note || '' };
  say('  >> TEST #' + n + ' RESULT = ' + status + (note ? '  (' + note + ')' : ''));
}

async function newUser(tag, wallet, locked) {
  PHONE_SEQ += 1;
  const phone = '06' + String(Date.now()).slice(-7) + String(PHONE_SEQ).padStart(2, '0');
  const ins = await pool.query(
    `INSERT INTO users (full_name, phone_number, wallet_balance, locked_balance)
     VALUES ($1,$2,$3,$4) RETURNING id, wallet_balance, locked_balance, phone_number`,
    ['ZZ Live Regression ' + tag, phone, wallet, locked]
  );
  return ins.rows[0];
}
const snap = async (uid) => {
  const r = await pool.query(`SELECT wallet_balance, locked_balance FROM users WHERE id=$1`, [uid]);
  return { wallet: Number(r.rows[0].wallet_balance), locked: Number(r.rows[0].locked_balance) };
};
const opRow = async (r) => (await pool.query(
  `SELECT id, operation_type, reference_id, status, attempts, amount, last_error
     FROM financial_operations WHERE reference_id=$1`, [r])).rows[0] || null;
const journalFor = async (r) => (await pool.query(
  `SELECT je.id, la.account_code, je.direction, je.amount, je.entry_group_id
     FROM journal_entries je JOIN ledger_accounts la ON la.id=je.account_id
    WHERE je.reference_id=$1 ORDER BY je.id`, [r])).rows;
const auditFor = async (r) => (await pool.query(
  `SELECT id, account_kind, account_id, operation, amount, balance_before, balance_after
     FROM financial_audit_log WHERE reference_id=$1 ORDER BY id`, [r])).rows;
const drCr = async (r) => {
  const q = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric dr,
            COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric cr,
            count(*)::int n
       FROM journal_entries WHERE reference_id=$1`, [r]);
  const x = q.rows[0];
  return { dr: Number(x.dr), cr: Number(x.cr), n: x.n, diff: Number(x.dr) - Number(x.cr) };
};
const show = (t, o) => say('  ' + t + ' = ' + (typeof o === 'object' ? JSON.stringify(o) : o));

(async () => {
  say('LIVE VALIDATION RUN nonce=' + NONCE);
  say('target: ' + process.env.DB_NAME + ' @ localhost:' + process.env.DB_PORT + ' (container 5436)');
  const ident = await pool.query(`SELECT current_database() db, current_user usr`);
  show('identity', ident.rows[0]);

  // ================= TEST 1 : HOLD - conditional atomic guard =================
  H('TEST #1  Hold - conditional atomic guard');
  let t1ok = true, t1note = [];
  {
    const u = await newUser('T1', 100000, 0);
    show('1a new user', { id: u.id, wallet: Number(u.wallet_balance), locked: Number(u.locked_balance) });
    const r1 = ref('1A');
    show('1a reference', r1 + ' (len=' + r1.length + ')');
    let res;
    try { res = await T(engine.holdFunds({ userId: u.id, amount: 30000, reference: r1 }), 20000, 'holdFunds'); }
    catch (e) { fail('1a holdFunds threw: ' + e.message); t1ok = false; }
    show('1a result', res);
    const s1 = await snap(u.id);
    show('1a wallet before->after', '100000 -> ' + s1.wallet);
    show('1a locked before->after', '0 -> ' + s1.locked);
    show('1a operation row', await opRow(r1));
    show('1a journal rows', await journalFor(r1));
    const d1 = await drCr(r1);
    show('1a DR/CR/diff', d1);
    if (!(s1.wallet === 70000 && s1.locked === 30000)) { fail('1a balances wrong'); t1ok = false; t1note.push('1a balances'); }
    if (d1.diff !== 0) { fail('1a unbalanced journal'); t1ok = false; t1note.push('1a DR!=CR'); }
    const o1 = await opRow(r1);
    if (!o1) { fail('1a no operation row'); t1ok = false; t1note.push('1a no op row'); }
    else if (o1.status === 'NEW') { fail('1a operation left NEW (no terminal state)'); t1ok = false; t1note.push('1a holdFunds status=NEW'); }
    else show('1a operation status', o1.status);

    // 1b : guard must REJECT an over-hold and change nothing
    const r1b = ref('1B');
    const before1b = await snap(u.id);
    show('1b reference', r1b);
    show('1b state before', before1b);
    let threw1b = false, msg1b = '';
    try { await T(engine.holdFunds({ userId: u.id, amount: 999999, reference: r1b }), 20000, 'holdFunds-over'); }
    catch (e) { threw1b = true; msg1b = e.message; }
    const after1b = await snap(u.id);
    show('1b request amount=999999 > available');
    show('1b error thrown', threw1b + ' :: ' + msg1b);
    show('1b state after', after1b);
    show('1b journal rows (must be 0)', await journalFor(r1b));
    show('1b operation row (must be null - rolled back)', await opRow(r1b));
    if (!threw1b) { fail('1b over-hold was NOT rejected'); t1ok = false; t1note.push('1b no rejection'); }
    if (before1b.wallet !== after1b.wallet || before1b.locked !== after1b.locked) { fail('1b state changed on rejected hold'); t1ok = false; t1note.push('1b state mutated'); }
    if ((await journalFor(r1b)).length !== 0) { fail('1b journal written despite rejection'); t1ok = false; t1note.push('1b journal leaked'); }
    if (await opRow(r1b)) { fail('1b operation row leaked'); t1ok = false; t1note.push('1b op row leaked'); }

    // 1c : CONCURRENT double-hold on the same wallet - only one may win
    const rc1 = ref('1C'), rc2 = ref('1D');
    show('1c concurrent refs', { a: rc1, b: rc2 });
    const beforeC = await snap(u.id);
    show('1c state before', beforeC);
    show('1c available for each claim', beforeC.wallet + ' each; 2 x 80000 = 160000 > available');
    const cA = await pool.connect(), cB = await pool.connect();
    const runOne = async (client, rf) => {
      try { await client.query('BEGIN'); const r = await engine.lockWallet({ client, userId: u.id, amount: 80000, reference: rf });
        await client.query('COMMIT'); return { ref: rf, ok: true, r }; }
      catch (e) { await client.query('ROLLBACK').catch(() => {}); return { ref: rf, ok: false, err: e.message }; }
      finally { client.release(); }
    };
    const conc = await Promise.all([runOne(cA, rc1), runOne(cB, rc2)]);
    show('1c execution A', conc[0]);
    show('1c execution B', conc[1]);
    const afterC = await snap(u.id);
    show('1c state after', afterC);
    show('1c op row A', await opRow(rc1));
    show('1c op row B', await opRow(rc2));
    const winners = conc.filter((x) => x.ok).length;
    show('1c winners (must be 1)', winners);
    if (winners !== 1) { fail('1c concurrent guard allowed ' + winners + ' winners'); t1ok = false; t1note.push('1c winners=' + winners); }
    if (afterC.locked < 0 || afterC.wallet < 0) { fail('1c negative balance after race'); t1ok = false; t1note.push('1c negative'); }
    if (afterC.wallet + afterC.locked !== beforeC.wallet + beforeC.locked) { fail('1c funds not conserved'); t1ok = false; t1note.push('1c not conserved'); }
    record(1, 'Hold conditional-atomic', t1ok ? 'PASS' : 'FAIL', t1note.join('; '));
  }

  // ================= TEST 2 : RELEASE - restores balance + idempotency =================
  H('TEST #2  Release - restores balance + idempotency');
  {
    let ok = true, note = [];
    // 2a : releaseHold (public, own transaction)
    const u = await newUser('T2A', 100000, 0);
    show('2a user', { id: u.id });
    const rh = ref('2AH'), rr = ref('2AR');
    show('2a hold ref / release ref', { hold: rh, release: rr });
    await T(engine.holdFunds({ userId: u.id, amount: 25000, reference: rh }), 20000, '2a hold');
    const afterHold = await snap(u.id);
    show('2a state after hold', afterHold);
    show('2a release request', { userId: u.id, amount: 25000, reference: rr });
    const r1st = await T(engine.releaseHold({ userId: u.id, amount: 25000, reference: rr }), 20000, '2a release1');
    show('2a FIRST execution result', r1st);
    const after1 = await snap(u.id);
    show('2a financial state after FIRST', after1);
    const d2a = await drCr(rr);
    show('2a journal after FIRST', await journalFor(rr));
    show('2a effective ledger entries after FIRST', d2a.n);
    const r2nd = await T(engine.releaseHold({ userId: u.id, amount: 25000, reference: rr }), 20000, '2a release2');
    show('2a SECOND execution result (identical request)', r2nd);
    const after2 = await snap(u.id);
    show('2a financial state after SECOND', after2);
    const d2a2 = await drCr(rr);
    show('2a journal after SECOND', await journalFor(rr));
    show('2a effective ledger entries after SECOND', d2a2.n);
    show('2a op row', await opRow(rr));
    if (after1.wallet !== 100000 || after1.locked !== 0) { fail('2a release did not restore balance'); ok = false; note.push('2a not restored'); }
    if (after2.wallet !== after1.wallet || after2.locked !== after1.locked) { fail('2a duplicate release double-effected'); ok = false; note.push('2a double effect'); }
    if (d2a2.n !== d2a.n) { fail('2a duplicate release added journal rows'); ok = false; note.push('2a journal grew'); }
    const o2a = await opRow(rr);
    if (o2a && o2a.status === 'NEW') { fail('2a releaseHold left status NEW'); ok = false; note.push('2a status NEW'); }
    else show('2a operation status', o2a ? o2a.status : 'NO ROW');

    // 2b : unlockWallet (in-transaction, effect-guarded) with real repeat
    const u2 = await newUser('T2B', 80000, 0);
    show('2b user', { id: u2.id });
    const lh = ref('2BH'), ur = ref('2BR');
    show('2b lock ref / unlock ref', { lock: lh, unlock: ur });
    {
      const c = await pool.connect();
      await c.query('BEGIN');
      const lr = await engine.lockWallet({ client: c, userId: u2.id, amount: 40000, reference: lh });
      await c.query('COMMIT'); c.release();
      show('2b lockWallet result', lr);
    }
    show('2b state after lock', await snap(u2.id));
    show('2b lock op status', await opRow(lh));
    const firstB = await (async () => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await engine.unlockWallet({ client: c, userId: u2.id, amount: 40000, reference: ur }); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    })();
    show('2b FIRST unlockWallet execution', firstB);
    const sB1 = await snap(u2.id);
    show('2b financial state after FIRST', sB1);
    const dB1 = await drCr(ur);
    show('2b journal after FIRST', await journalFor(ur));
    show('2b effective ledger entries after FIRST', dB1.n);
    const secondB = await (async () => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await engine.unlockWallet({ client: c, userId: u2.id, amount: 40000, reference: ur }); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    })();
    show('2b SECOND unlockWallet execution (identical request)', secondB);
    const sB2 = await snap(u2.id);
    show('2b financial state after SECOND', sB2);
    const dB2 = await drCr(ur);
    show('2b journal after SECOND', await journalFor(ur));
    show('2b effective ledger entries after SECOND', dB2.n);
    show('2b op row', await opRow(ur));
    if (sB1.wallet !== 80000 || sB1.locked !== 0) { fail('2b unlock did not restore'); ok = false; note.push('2b not restored'); }
    if (sB2.wallet !== sB1.wallet || sB2.locked !== sB1.locked) { fail('2b duplicate unlock double-effected'); ok = false; note.push('2b double effect'); }
    if (dB2.n !== dB1.n) { fail('2b duplicate unlock added journal rows'); ok = false; note.push('2b journal grew'); }
    record(2, 'Release + idempotency', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= TEST 3 : DUPLICATE RELEASE - no double effect =================
  H('TEST #3  Duplicate release - no double effect');
  {
    let ok = true, note = [];
    const u = await newUser('T3', 60000, 0);
    show('3 user', { id: u.id });
    const h = ref('3H'), r = ref('3R');
    await T(engine.holdFunds({ userId: u.id, amount: 20000, reference: h }), 20000, '3 hold');
    show('3 state after hold', await snap(u.id));
    show('3 same release request repeated 4x on reference ' + r + ' (amount=20000)');
    const trace = [];
    for (let i = 1; i <= 4; i++) {
      const out = await T(engine.releaseHold({ userId: u.id, amount: 20000, reference: r }), 20000, '3 rel' + i);
      const s = await snap(u.id);
      const d = await drCr(r);
      trace.push({ attempt: i, result: out, wallet: s.wallet, locked: s.locked, ledgerEntries: d.n });
    }
    trace.forEach((t) => show('3 attempt ' + t.attempt, t));
    show('3 final op row', await opRow(r));
    show('3 final journal rows', await journalFor(r));
    show('3 final audit rows', await auditFor(r));
    const first = trace[0], last = trace[trace.length - 1];
    if (first.wallet !== 60000 || first.locked !== 0) { fail('3 first release did not restore'); ok = false; note.push('3 first not restored'); }
    if (last.wallet !== first.wallet || last.locked !== first.locked) { fail('3 repeated release changed final state'); ok = false; note.push('3 final state drifted'); }
    if (last.ledgerEntries !== 2) { fail('3 expected exactly 2 ledger rows (1 DR+1 CR), got ' + last.ledgerEntries); ok = false; note.push('3 ledgerEntries=' + last.ledgerEntries); }
    if (last.wallet + last.locked !== 60000) { fail('3 funds not conserved'); ok = false; note.push('3 not conserved'); }
    record(3, 'Duplicate release', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= TEST 4 : COMBINED EFFECT GUARDS =================
  H('TEST #4  Combined effect guards - wallet/locked never negative');
  {
    let ok = true, note = [];
    const u = await newUser('T4', 50000, 0);
    show('4 user', { id: u.id, wallet: 50000, locked: 0 });
    show('4 state before', await snap(u.id));

    // 4a : unlockWallet with amount > locked -> guard must block, mark FAILED
    const r4a = ref('4A');
    show('4a reference', r4a);
    show('4a request', 'unlockWallet amount=999999 while locked_balance=0');
    const before4a = await snap(u.id);
    let out4a = null, err4a = null;
    try {
      const c = await pool.connect();
      await c.query('BEGIN');
      out4a = await engine.unlockWallet({ client: c, userId: u.id, amount: 999999, reference: r4a });
      await c.query('COMMIT'); c.release();
    } catch (e) { err4a = e.message; try { await c.query('ROLLBACK'); } catch (_) {} if (c) c.release(); }
    show('4a result', out4a);
    show('4a error', err4a);
    const after4a = await snap(u.id);
    show('4a state after (must equal before)', after4a);
    show('4a op row (FAILED expected, last_error set)', await opRow(r4a));
    show('4a journal rows', await journalFor(r4a));
    show('4a audit rows', await auditFor(r4a));
    const o4a = await opRow(r4a);
    if (after4a.wallet !== before4a.wallet || after4a.locked !== before4a.locked) { fail('4a balances mutated on blocked unlock'); ok = false; note.push('4a state mutated'); }
    if (!o4a || o4a.status !== 'FAILED') { fail('4a not marked FAILED (got ' + (o4a ? o4a.status : 'NO ROW') + ')'); ok = false; note.push('4a status=' + (o4a ? o4a.status : 'none')); }

    // 4b : releaseHold with amount > locked -> does it report success while doing nothing?
    const r4b = ref('4B');
    show('4b reference', r4b);
    show('4b request', 'releaseHold amount=999999 while locked_balance=0');
    const before4b = await snap(u.id);
    let out4b = null, err4b = null;
    try { out4b = await T(engine.releaseHold({ userId: u.id, amount: 999999, reference: r4b }), 20000, '4b release-over'); }
    catch (e) { err4b = e.message; }
    show('4b result', out4b);
    show('4b error', err4b);
    const after4b = await snap(u.id);
    show('4b state after', after4b);
    show('4b op row', await opRow(r4b));
    show('4b journal rows', await journalFor(r4b));
    const o4b = await opRow(r4b);
    if (out4b && out4b.success === true) { fail('4b releaseHold reported success=true but moved nothing (silent no-op)'); ok = false; note.push('4b silent no-op reported success'); }
    if (after4b.wallet !== before4b.wallet || after4b.locked !== before4b.locked) { fail('4b balances mutated'); ok = false; note.push('4b state mutated'); }

    // 4c : DB-level backstop - direct negative write must be refused by CHECK
    show('4c request', 'UPDATE users SET locked_balance=-1 (must be refused by chk_users_locked_balance_check)');
    let refused = false, refErr = null;
    try {
      const c = await pool.connect();
      await c.query('BEGIN');
      await c.query(`UPDATE users SET locked_balance = -1 WHERE id=$1`, [u.id]);
      await c.query('ROLLBACK'); c.release();
    } catch (e) { refused = true; refErr = e.message; }
    show('4c refused by DB', refused);
    show('4c error', refErr);
    show('4c state after', await snap(u.id));
    if (!refused) { fail('4c DB CHECK did NOT refuse negative locked_balance'); ok = false; note.push('4c check missing'); }
    if (after4b.locked < 0 || after4b.wallet < 0) { fail('4 negative balance observed'); ok = false; note.push('4 negative seen'); }
    record(4, 'Combined effect guards', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= TEST 5 : FINALIZE - terminal state =================
  H('TEST #5  Finalize - SUCCESS/FAILED terminal state');
  {
    let ok = true, note = [];
    // build a SUCCESS op and a FAILED op
    const u = await newUser('T5', 90000, 0);
    show('5 user', { id: u.id });
    const rOk = ref('5OK'), rFail = ref('5FL'), rCap = ref('5CP');
    const c1 = await pool.connect();
    await c1.query('BEGIN');
    const lockRes = await engine.lockWallet({ client: c1, userId: u.id, amount: 10000, reference: rOk });
    await c1.query('COMMIT'); c1.release();
    show('5a lockWallet result', lockRes);
    show('5a op row (expect SUCCESS)', await opRow(rOk));
    const c2 = await pool.connect();
    await c2.query('BEGIN');
    const failRes = await engine.unlockWallet({ client: c2, userId: u.id, amount: 999999, reference: rFail });
    await c2.query('COMMIT'); c2.release();
    show('5b insufficient-unlock result (expect failure signal)', failRes);
    show('5b op row (expect FAILED)', await opRow(rFail));
    // captureLock path
    const c3 = await pool.connect();
    await c3.query('BEGIN');
    let capRes = null, capErr = null;
    try { capRes = await engine.captureLock({ client: c3, userId: u.id, amount: 10000, reference: rCap }); }
    catch (e) { capErr = e.message; }
    await c3.query('COMMIT'); c3.release();
    show('5c captureLock result', capRes);
    show('5c captureLock error', capErr);
    const capOp = await opRow(rCap);
    show('5c op row after captureLock', capOp);
    show('5c audit rows', await auditFor(rCap));

    const oOk = await opRow(rOk), oFail = await opRow(rFail);
    if (!oOk || oOk.status !== 'SUCCESS') { fail('5a lockWallet not SUCCESS (got ' + (oOk ? oOk.status : 'NO ROW') + ')'); ok = false; note.push('5a=' + (oOk ? oOk.status : 'none')); }
    if (!oFail || oFail.status !== 'FAILED') { fail('5b not FAILED (got ' + (oFail ? oFail.status : 'NO ROW') + ')'); ok = false; note.push('5b=' + (oFail ? oFail.status : 'none')); }
    if (!oFail || !oFail.last_error) { fail('5b FAILED row has no last_error'); ok = false; note.push('5b no last_error'); }
    if (capOp && capOp.status === 'NEW') { fail('5c captureLock left operation in transient NEW (never finalized)'); ok = false; note.push('5c captureLock status=NEW'); }
    const allNew = await pool.query(`SELECT reference_id, operation_type, status FROM financial_operations WHERE status='NEW' ORDER BY id`);
    show('5d ALL operations still in NEW state', allNew.rows);
    if (allNew.rowCount > 0) { fail('5d ' + allNew.rowCount + ' operation(s) left in NEW'); ok = false; note.push('5d NEW rows=' + allNew.rowCount); }
    record(5, 'SUCCESS/FAILED terminal state', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= TEST 6 : RETRY FAILED - no double financial effect =================
  H('TEST #6  Retry FAILED - no double financial effect');
  {
    let ok = true, note = [];
    const u = await newUser('T6', 70000, 0);
    show('6 user', { id: u.id });
    const r = ref('6RT');
    show('6 reference (will first FAIL, then be retried)', r);
    show('6 state before', await snap(u.id));
    const before6 = await snap(u.id);
    // first execution -> insufficient locked -> FAILED
    let first = null, ferr = null;
    try {
      const c = await pool.connect();
      await c.query('BEGIN');
      first = await engine.unlockWallet({ client: c, userId: u.id, amount: 60000, reference: r });
      await c.query('COMMIT'); c.release();
    } catch (e) { ferr = e.message; if (c) { await c.query('ROLLBACK').catch(() => {}); c.release(); } }
    show('6 FIRST execution result', first);
    show('6 FIRST execution error', ferr);
    const s6a = await snap(u.id);
    show('6 financial state after FIRST', s6a);
    const op6a = await opRow(r);
    show('6 operation row after FIRST', op6a);
    const dj6a = await drCr(r);
    show('6 effective ledger entries after FIRST', dj6a);
    show('6 journal rows after FIRST', await journalFor(r));
    // retry with corrected amount but SAME reference
    show('6 RETRY = same reference ' + r + ', amount now 60000 after funding lock');
    const fundH = ref('6FH');
    await T(engine.holdFunds({ userId: u.id, amount: 60000, reference: fundH }), 20000, '6 fund hold');
    show('6 state after funding hold', await snap(u.id));
    let second = null, serr = null;
    try {
      const c = await pool.connect();
      await c.query('BEGIN');
      second = await engine.unlockWallet({ client: c, userId: u.id, amount: 60000, reference: r });
      await c.query('COMMIT'); c.release();
    } catch (e) { serr = e.message; if (c) { await c.query('ROLLBACK').catch(() => {}); c.release(); } }
    show('6 SECOND execution result', second);
    show('6 SECOND execution error', serr);
    const s6b = await snap(u.id);
    show('6 financial state after SECOND (retry)', s6b);
    const op6b = await opRow(r);
    show('6 operation row after SECOND', op6b);
    const dj6b = await drCr(r);
    show('6 effective ledger entries after SECOND', dj6b);
    show('6 journal rows after SECOND', await journalFor(r));
    if (op6a.status !== 'FAILED') { fail('6 first execution was not FAILED'); ok = false; note.push('6 first not FAILED'); }
    if (!second || second.dedup !== true) { fail('6 retry was NOT deduped (double financial effect possible)'); ok = false; note.push('6 retry not deduped'); }
    if (op6b && op6b.status !== 'FAILED') { fail('6 retry changed terminal FAILED status to ' + op6b.status); ok = false; note.push('6 status changed to ' + op6b.status); }
    if (dj6b.n !== dj6a.n) { fail('6 retry added ledger entries ' + dj6a.n + ' -> ' + dj6b.n); ok = false; note.push('6 ledger grew'); }
    if (s6a.wallet !== before6.wallet || s6a.locked !== before6.locked) { fail('6 FAILED execution moved money'); ok = false; note.push('6 failed exec moved money'); }
    show('6 NOTE: balances after retry reflect ONLY the funding hold, retry itself had zero effect');
    record(6, 'FAILED retry no double effect', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= TEST 7 : SINGLE-TRANSACTION ATOMICITY =================
  H('TEST #7  Single-transaction atomicity (rollback leaves no partial state)');
  {
    let ok = true, note = [];
    const u = await newUser('T7', 120000, 0);
    const r = ref('7TX');
    show('7 user', { id: u.id });
    show('7 reference', r);
    const before7 = await snap(u.id);
    const opBefore = await opRow(r);
    const jBefore = await journalFor(r);
    show('7 BEFORE  balances', before7);
    show('7 BEFORE  operation row', opBefore);
    show('7 BEFORE  journal rows', jBefore);
    const countsB = await pool.query(`SELECT (SELECT count(*) FROM financial_operations)::int o,(SELECT count(*) FROM journal_entries)::int j,(SELECT count(*) FROM financial_audit_log)::int a`);
    show('7 BEFORE  row counts', countsB.rows[0]);
    let insideSnap = null, forcedErr = null;
    const c = await pool.connect();
    await c.query('BEGIN');
    say('7 --- inside BEGIN ---');
    const lr = await engine.lockWallet({ client: c, userId: u.id, amount: 45000, reference: r });
    show('7 inside-tx lockWallet result', lr);
    insideSnap = await (async () => { const q = await c.query(`SELECT wallet_balance, locked_balance FROM users WHERE id=$1`, [u.id]); return { wallet: Number(q.rows[0].wallet_balance), locked: Number(q.rows[0].locked_balance) }; })();
    show('7 inside-tx balances AFTER mutation (uncommitted)', insideSnap);
    const jInside = await c.query(`SELECT je.id, la.account_code, je.direction, je.amount FROM journal_entries je JOIN ledger_accounts la ON la.id=je.account_id WHERE je.reference_id=$1 ORDER BY je.id`, [r]);
    show('7 inside-tx journal rows (uncommitted)', jInside.rows);
    const oInside = await c.query(`SELECT id, operation_type, reference_id, status FROM financial_operations WHERE reference_id=$1`, [r]);
    show('7 inside-tx operation row (uncommitted)', oInside.rows);
    say('7 --- forcing failure INSIDE the transaction ---');
    try { await c.query(`SELECT * FROM tbl_zz_nonexistent_force_error`); }
    catch (e) { forcedErr = e.message; }
    show('7 forced failure SQLSTATE/message', forcedErr);
    await c.query('ROLLBACK');
    c.release();
    say('7 --- ROLLBACK executed ---');
    const after7 = await snap(u.id);
    show('7 AFTER  balances', after7);
    show('7 AFTER  operation row', await opRow(r));
    show('7 AFTER  journal rows', await journalFor(r));
    show('7 AFTER  audit rows', await auditFor(r));
    const countsA = await pool.query(`SELECT (SELECT count(*) FROM financial_operations)::int o,(SELECT count(*) FROM journal_entries)::int j,(SELECT count(*) FROM financial_audit_log)::int a`);
    show('7 AFTER  row counts', countsA.rows[0]);
    if (insideSnap.wallet !== before7.wallet - 45000) { fail('7 mutation not visible inside tx (test invalid)'); ok = false; note.push('7 in-tx not mutated'); }
    if (after7.wallet !== before7.wallet || after7.locked !== before7.locked) { fail('7 ROLLBACK did not restore balances'); ok = false; note.push('7 rollback incomplete'); }
    if (await opRow(r)) { fail('7 operation row survived ROLLBACK'); ok = false; note.push('7 op row survived'); }
    if ((await journalFor(r)).length !== 0) { fail('7 journal rows survived ROLLBACK'); ok = false; note.push('7 journal survived'); }
    if ((await auditFor(r)).length !== 0) { fail('7 audit rows survived ROLLBACK'); ok = false; note.push('7 audit survived'); }
    if (countsA.rows[0].o !== countsB.rows[0].o || countsA.rows[0].j !== countsB.rows[0].j || countsA.rows[0].a !== countsB.rows[0].a) { fail('7 row counts changed after ROLLBACK'); ok = false; note.push('7 counts drifted'); }
    record(7, 'Single-tx atomicity', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= TEST 8 : DOUBLE ENTRY DR == CR =================
  H('TEST #8  Double-entry journal - DR == CR');
  {
    let ok = true, note = [];
    const g = await pool.query(
      `SELECT je.entry_group_id, je.reference_id,
              COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric dr,
              COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0)::numeric cr,
              count(*)::int lines
         FROM journal_entries je GROUP BY je.entry_group_id, je.reference_id ORDER BY je.entry_group_id`
    );
    say('8 per-group breakdown:');
    g.rows.forEach((r) => {
      const d = Number(r.dr) - Number(r.cr);
      say('   group=' + r.entry_group_id + ' ref=' + r.reference_id + ' DR=' + r.dr + ' CR=' + r.cr + ' diff=' + d + ' lines=' + r.lines);
      if (d !== 0) { fail('8 group ' + r.entry_group_id + ' unbalanced diff=' + d); ok = false; note.push('8 unbalanced ' + r.entry_group_id); }
      if (r.lines < 2) { fail('8 group ' + r.entry_group_id + ' has fewer than 2 lines'); ok = false; note.push('8 single-sided ' + r.entry_group_id); }
    });
    const tot = await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric dr,
              COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric cr,
              count(*)::int n FROM journal_entries`
    );
    const t = tot.rows[0];
    const td = Number(t.dr) - Number(t.cr);
    show('8 TOTAL DR', t.dr);
    show('8 TOTAL CR', t.cr);
    show('8 DIFFERENCE', td);
    show('8 total journal rows', t.n);
    show('8 groups checked', g.rowCount);
    if (td !== 0) { fail('8 global DR != CR, diff=' + td); ok = false; note.push('8 global diff=' + td); }
    if (g.rowCount === 0) { fail('8 no journal rows produced at all'); ok = false; note.push('8 no rows'); }
    const neg = await pool.query(`SELECT count(*)::int c FROM journal_entries WHERE amount <= 0`);
    show('8 non-positive journal amounts', neg.rows[0].c);
    if (neg.rows[0].c > 0) { fail('8 non-positive journal amount found'); ok = false; note.push('8 non-positive amounts'); }
    record(8, 'Double-entry DR == CR', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= TEST 9 : RECONCILIATION + TX224 UNTOUCHED =================
  H('TEST #9  Reconciliation + TX224 untouched');
  {
    let ok = true, note = [];
    const users = await pool.query(`SELECT id, full_name, wallet_balance, locked_balance FROM users WHERE full_name LIKE 'ZZ Live Regression %' ORDER BY id`);
    say('9 all test users created in this run:');
    users.rows.forEach((u) => {
      show('   user ' + u.id, { wallet: Number(u.wallet_balance), locked: Number(u.locked_balance), total: Number(u.wallet_balance) + Number(u.locked_balance) });
    });
    const negs = await pool.query(`SELECT id, wallet_balance, locked_balance FROM users WHERE full_name LIKE 'ZZ Live Regression %' AND (wallet_balance < 0 OR locked_balance < 0)`);
    show('9 test users with negative wallet/locked', negs.rows);
    if (negs.rowCount > 0) { fail('9 negative balance found'); ok = false; note.push('9 negative balance'); }

    const ops = await pool.query(`SELECT id, operation_type, reference_id, status, amount, attempts FROM financial_operations ORDER BY id`);
    say('9 every operation row created in this run:');
    ops.rows.forEach((o) => say('   #' + o.id + ' ' + o.operation_type + ' ref=' + o.reference_id + ' status=' + o.status + ' amount=' + o.amount + ' attempts=' + o.attempts));
    const st = await pool.query(`SELECT status, count(*)::int c FROM financial_operations GROUP BY status ORDER BY status`);
    show('9 operation status distribution', st.rows);
    if (st.rows.some((r) => r.status === 'NEW')) { fail('9 operations left in NEW state'); ok = false; note.push('9 NEW status remains'); }

    const aud = await pool.query(`SELECT account_kind, operation, count(*)::int c, sum(amount)::numeric total FROM financial_audit_log GROUP BY 1,2 ORDER BY 1,2`);
    show('9 financial_audit_log summary', aud.rows);
    const audNeg = await pool.query(`SELECT count(*)::int c FROM financial_audit_log WHERE amount < 0`);
    show('9 negative audit amounts', audNeg.rows[0].c);

    // reconciliation: engine ledger vs projection
    const recon = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0) FROM journal_entries WHERE account_id=(SELECT id FROM ledger_accounts WHERE account_code='CUSTOMER_WALLET')) cr_wallet_acct,
         (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0) FROM journal_entries WHERE account_id=(SELECT id FROM ledger_accounts WHERE account_code='CUSTOMER_WALLET')) dr_wallet_acct,
         (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0) FROM journal_entries WHERE account_id=(SELECT id FROM ledger_accounts WHERE account_code='CARD_HOLD')) cr_hold_acct,
         (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0) FROM journal_entries WHERE account_id=(SELECT id FROM ledger_accounts WHERE account_code='CARD_HOLD')) dr_hold_acct`
    );
    const R = recon.rows[0];
    show('9 CUSTOMER_WALLET account DR', R.dr_wallet_acct);
    show('9 CUSTOMER_WALLET account CR', R.cr_wallet_acct);
    show('9 CARD_HOLD account DR', R.dr_hold_acct);
    show('9 CARD_HOLD account CR', R.cr_hold_acct);
    const sumLocked = await pool.query(`SELECT COALESCE(SUM(locked_balance),0)::numeric s FROM users WHERE full_name LIKE 'ZZ Live Regression %'`);
    show('9 SUM(users.locked_balance) for test users', sumLocked.rows[0].s);
    show('9 journal CARD_HOLD CR - DR (expected to equal sum locked)', Number(R.cr_hold_acct) - Number(R.dr_hold_acct));
    const projDiff = Number(R.cr_hold_acct) - Number(R.dr_hold_acct) - Number(sumLocked.rows[0].s);
    show('9 RECONCILIATION difference (CARD_HOLD net vs projection)', projDiff);
    if (projDiff !== 0) { fail('9 reconciliation difference = ' + projDiff); ok = false; note.push('9 recon diff=' + projDiff); }

    // TX224 safety
    const txOps = await pool.query(`SELECT count(*)::int c FROM financial_operations WHERE reference_id='WD-3EC32D6D' OR reference_id ILIKE '%TX224%' OR reference_id ILIKE '%3EC32D6D%'`);
    show('9 TX224/WD-3EC32D6D operation rows', txOps.rows[0].c);
    const txJ = await pool.query(`SELECT count(*)::int c FROM journal_entries WHERE reference_id ILIKE '%TX224%' OR entry_group_id ILIKE '%TX224%' OR entry_group_id ILIKE '%3EC32D6D%' OR description ILIKE '%TX224%' OR product_ref ILIKE '%TX224%'`);
    show('9 TX224/WD-3EC32D6D journal rows', txJ.rows[0].c);
    const txL = await pool.query(`SELECT count(*)::int c FROM wallet_ledger WHERE reference_id ILIKE '%TX224%' OR description ILIKE '%TX224%'`);
    show('9 TX224 wallet_ledger rows', txL.rows[0].c);
    const txA = await pool.query(`SELECT count(*)::int c FROM financial_audit_log WHERE reference_id ILIKE '%TX224%'`);
    show('9 TX224 audit rows', txA.rows[0].c);
    if (txOps.rows[0].c !== 0 || txJ.rows[0].c !== 0 || txL.rows[0].c !== 0 || txA.rows[0].c !== 0) { fail('9 TX224 artifact detected'); ok = false; note.push('9 TX224 artifact'); }
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'financialEngine.js'), 'utf8');
    const lit = (src.match(/TX224|3EC32D6D|WD-3EC32D6D/g) || []);
    show('9 TX224 literals in financialEngine.js source', lit.length);
    if (lit.length !== 0) { fail('9 engine source contains TX224 literal'); ok = false; note.push('9 literal in source'); }
    const refs = ops.rows.map((o) => o.reference_id);
    show('9 every reference used in this run', refs);
    const longest = refs.reduce((m, r) => Math.max(m, r.length), 0);
    show('9 longest reference length (limit 15)', longest);
    if (longest > 15) { fail('9 reference longer than 15 chars'); ok = false; note.push('9 ref too long'); }
    record(9, 'Reconciliation + TX224 untouched', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= FINAL MATRIX =================
  H('FINAL MATRIX');
  for (let n = 1; n <= 9; n++) {
    const r = RESULTS[n];
    say(String(n).padStart(2) + '  ' + (r ? r.invariant.padEnd(34) : 'MISSING').padEnd(36) + (r ? r.status : 'PENDING') + (r && r.note ? '   [' + r.note + ']' : ''));
  }
  H('SUMMARY');
  const st = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (RESULTS[n] ? RESULTS[n].status : 'PENDING'));
  say('LIVE results = ' + st.join(', '));
  say('PASS=' + st.filter((x) => x === 'PASS').length + ' FAIL=' + st.filter((x) => x === 'FAIL').length + ' PENDING=' + st.filter((x) => x === 'PENDING').length);
  say('assertion failures logged = ' + ERR);
  finish(0);
})().catch((e) => { say('\nSUITE ERROR: ' + ((e && e.stack) || e)); finish(1); });
