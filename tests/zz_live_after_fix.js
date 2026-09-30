'use strict';
/**
 * FINAL LIVE VALIDATION - AFTER FIX A/B/C/D
 * Target: afrikoba_regression ONLY (host port 5436). No production, no migration,
 * no schema mutation, no TX224, no changes to financialEngine.js.
 * NEW users + NEW references (<=15 chars). Pre-fix evidence files are untouched.
 *
 * New contract under test:
 *   projection guard -> rowCount check -> postJournal -> setOperationState(SUCCESS) -> COMMIT
 *   guard failure    -> FAILED marker inside the tx -> ROLLBACK  (zero residue everywhere)
 */
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'zz_out_live_after_fix.txt');
const buf = [];
const say = (s) => buf.push(s === undefined ? 'undefined' : String(s));
const H = (s) => say('\n########## ' + s + ' ##########');
let ERR = 0;
const fail = (m) => { ERR++; say('  !! ' + m); };
function finish(c) { try { fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8'); } catch (e) {} process.exit(c || 0); }
process.on('unhandledRejection', (e) => { say('\nFATAL ' + ((e && e.stack) || e)); finish(9); });
process.on('uncaughtException', (e) => { say('\nFATAL ' + ((e && e.stack) || e)); finish(9); });

const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const engine = require(path.join(__dirname, '..', 'src', 'services', 'financialEngine'));

const NONCE = Date.now().toString(36).toUpperCase().slice(-6);
let SEQ = 0;
const REFS = [];
const SEED = new Map();
const USERS = [];
const ref = (t) => { const r = ('L' + t + NONCE).toUpperCase().slice(0, 15); REFS.push(r); return r; };
const show = (t, o) => say('  ' + t + ' = ' + (typeof o === 'object' ? JSON.stringify(o) : o));
const T = (p, ms, l) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT ' + l)), ms || 20000))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDeadlock = (e) => e && /deadlock|40P01/i.test((e.message || '') + ' ' + (e.code || ''));

const RESULTS = {};
const record = (n, inv, st, note) => { RESULTS[n] = { inv, st, note: note || '' }; say('  >> TEST #' + n + ' = ' + st + (note ? '  [' + note + ']' : '')); };

async function newUser(tag, wallet, locked) {
  SEQ += 1;
  const phone = '08' + String(Date.now()).slice(-7) + String(SEQ).padStart(2, '0');
  const r = (await pool.query(
    `INSERT INTO users (full_name, phone_number, wallet_balance, locked_balance) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['ZZ PostFix ' + tag, phone, wallet, locked])).rows[0];
  SEED.set(r.id, wallet);
  USERS.push(r.id);
  return r.id;
}
const snap = async (id) => { const r = await pool.query(`SELECT wallet_balance, locked_balance FROM users WHERE id=$1`, [id]); return { wallet: Number(r.rows[0].wallet_balance), locked: Number(r.rows[0].locked_balance) }; };
const opRow = async (r) => (await pool.query(`SELECT id, operation_type, reference_id, status, attempts, amount, last_error FROM financial_operations WHERE reference_id=$1`, [r])).rows[0] || null;
const jRows = async (r) => (await pool.query(`SELECT je.id, la.account_code, je.direction, je.amount, je.entry_group_id FROM journal_entries je JOIN ledger_accounts la ON la.id=je.account_id WHERE je.reference_id=$1 ORDER BY je.id`, [r])).rows;
const aRows = async (r) => (await pool.query(`SELECT id, account_kind, account_id, operation, amount, balance_before, balance_after FROM financial_audit_log WHERE reference_id=$1 ORDER BY id`, [r])).rows;
const drCr = async (r) => { const q = await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric dr, COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric cr, count(*)::int n FROM journal_entries WHERE reference_id=$1`, [r]); const x = q.rows[0]; return { dr: Number(x.dr), cr: Number(x.cr), n: x.n, diff: Number(x.dr) - Number(x.cr) }; };
// residue = every trace a rolled-back / non-successful attempt must leave
async function residue(r) {
  return { op: await opRow(r), journal: await jRows(r), audit: await aRows(r) };
}
const residueClean = (x) => x.op === null && x.journal.length === 0 && x.audit.length === 0;
async function inTx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return { ok: true, r }; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); return { ok: false, err: e.message, statusCode: e.statusCode }; }
  finally { c.release(); }
}

(async () => {
  say('POST-FIX LIVE VALIDATION  nonce=' + NONCE);
  say('target = ' + process.env.DB_NAME + ' via host port 5436');
  const id = await pool.query(`SELECT current_database() db, current_user usr`);
  show('identity', id.rows[0]);
  const b0 = await pool.query(`SELECT (SELECT count(*)::int FROM financial_operations) ops,(SELECT count(*)::int FROM journal_entries) je,(SELECT count(*)::int FROM financial_audit_log) au,(SELECT count(*)::int FROM users) us`);
  show('counts at START of this run (baseline included)', b0.rows[0]);
  const B0 = b0.rows[0];

  // ============ TEST 1 : Hold - conditional atomic guard ============
  H('TEST #1  Hold - conditional atomic guard');
  {
    let ok = true, note = [];
    const u = await newUser('T1', 100000, 0);
    show('1a user', { id: u, wallet: 100000, locked: 0 });
    const r1 = ref('1A');
    show('1a reference', r1 + ' (len ' + r1.length + ')');
    const res = await T(engine.holdFunds({ userId: u, amount: 30000, reference: r1 }), 20000, '1a');
    show('1a result', res);
    const s1 = await snap(u);
    show('1a wallet 100000 -> ' + s1.wallet);
    show('1a locked 0 -> ' + s1.locked);
    show('1a operation row', await opRow(r1));
    show('1a journal rows', await jRows(r1));
    show('1a DR/CR', await drCr(r1));
    show('1a audit rows', await aRows(r1));
    const d1 = await drCr(r1);
    if (s1.wallet !== 70000 || s1.locked !== 30000) { fail('1a balances wrong'); ok = false; note.push('1a balances'); }
    if (d1.diff !== 0 || d1.n !== 2) { fail('1a journal wrong'); ok = false; note.push('1a journal'); }
    if ((await opRow(r1)).status !== 'SUCCESS') { fail('1a not SUCCESS'); ok = false; note.push('1a status'); }

    // 1b over-hold must be rejected AND leave zero residue
    const r1b = ref('1B');
    show('1b reference', r1b);
    show('1b state before', await snap(u));
    show('1b request holdFunds amount=999999');
    let err = null;
    try { await T(engine.holdFunds({ userId: u, amount: 999999, reference: r1b }), 20000, '1b'); }
    catch (e) { err = e.message; }
    show('1b rejected with error', err);
    const s1b = await snap(u);
    show('1b state after', s1b);
    const res1b = await residue(r1b);
    show('1b RESIDUE (op / journal / audit)', { op: res1b.op, journalRows: res1b.journal.length, auditRows: res1b.audit.length });
    if (!err) { fail('1b over-hold not rejected'); ok = false; note.push('1b no rejection'); }
    if (s1b.wallet !== s1.wallet || s1b.locked !== s1.locked) { fail('1b state changed'); ok = false; note.push('1b state changed'); }
    if (!residueClean(res1b)) { fail('1b residue left behind'); ok = false; note.push('1b residue'); }

    // 1c/1d races: each claim affordable alone, pair is not
    for (const mode of ['lockWallet', 'holdFunds']) {
      const uu = await newUser('T1' + mode, 70000, 0);
      const ra = ref('1C'), rb = ref('1D');
      const before = await snap(uu);
      const one = async (rf, label) => {
        for (let i = 1; i <= 4; i++) {
          try {
            if (mode === 'lockWallet') { const x = await inTx((c) => engine.lockWallet({ client: c, userId: uu, amount: 50000, reference: rf })); if (x.ok) return { label, out: 'SUCCESS', attempt: i, r: x.r }; throw Object.assign(new Error(x.err), { statusCode: x.statusCode }); }
            return { label, out: 'SUCCESS', attempt: i, r: await engine.holdFunds({ userId: uu, amount: 50000, reference: rf }) };
          } catch (e) { if (isDeadlock(e) && i < 4) { say('  1' + mode + ' ' + label + ' attempt ' + i + ' deadlock -> retry'); await sleep(150); continue; } return { label, out: 'REJECTED', attempt: i, error: e.message }; }
        }
        return { label, out: 'GAVE_UP' };
      };
      const [x, y] = await Promise.all([one(ra, 'A'), one(rb, 'B')]);
      show('1-' + mode + ' execution A', x);
      show('1-' + mode + ' execution B', y);
      const after = await snap(uu);
      show('1-' + mode + ' state before -> after', { before, after });
      const winners = [x, y].filter((z) => z.out === 'SUCCESS').length;
      const winRef = x.out === 'SUCCESS' ? ra : rb, loseRef = x.out === 'SUCCESS' ? rb : ra;
      show('1-' + mode + ' winners (expect 1)', winners);
      show('1-' + mode + ' winner op row', await opRow(winRef));
      show('1-' + mode + ' loser residue', await residue(loseRef));
      show('1-' + mode + ' winner journal', await jRows(winRef));
      if (winners !== 1) { fail('1-' + mode + ' winners=' + winners); ok = false; note.push('1-' + mode + ' winners'); }
      if (after.wallet + after.locked !== before.wallet + before.locked) { fail('1-' + mode + ' funds not conserved'); ok = false; note.push('1-' + mode + ' conservation'); }
      if (after.wallet < 0 || after.locked < 0) { fail('1-' + mode + ' negative'); ok = false; note.push('1-' + mode + ' negative'); }
      if (!residueClean(await residue(loseRef))) { fail('1-' + mode + ' loser left residue'); ok = false; note.push('1-' + mode + ' loser residue'); }
    }
    record(1, 'Hold conditional-atomic', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ============ TEST 2 : Release + idempotency (actual repeated request) ============
  H('TEST #2  Release - restores balance + idempotency');
  {
    let ok = true, note = [];
    // 2a releaseHold
    const u = await newUser('T2A', 100000, 0);
    const rh = ref('2AH'), rr = ref('2AR');
    show('2a user', { id: u });
    show('2a refs', { hold: rh, release: rr });
    await T(engine.holdFunds({ userId: u, amount: 25000, reference: rh }), 20000, '2a hold');
    show('2a state after hold', await snap(u));
    show('2a request', 'releaseHold amount=25000 ref=' + rr);
    const first = await T(engine.releaseHold({ userId: u, amount: 25000, reference: rr }), 20000, '2a r1');
    show('2a FIRST execution', first);
    const sF = await snap(u);
    show('2a financial state after FIRST', sF);
    show('2a journal after FIRST', await jRows(rr));
    show('2a effective ledger entries after FIRST', (await drCr(rr)).n);
    show('2a op row after FIRST', await opRow(rr));
    const second = await T(engine.releaseHold({ userId: u, amount: 25000, reference: rr }), 20000, '2a r2');
    show('2a SECOND execution (identical request)', second);
    const sS = await snap(u);
    show('2a financial state after SECOND', sS);
    show('2a journal after SECOND', await jRows(rr));
    show('2a effective ledger entries after SECOND', (await drCr(rr)).n);
    show('2a op row after SECOND', await opRow(rr));
    if (sF.wallet !== 100000 || sF.locked !== 0) { fail('2a not restored'); ok = false; note.push('2a not restored'); }
    if (sS.wallet !== sF.wallet || sS.locked !== sF.locked) { fail('2a duplicate double-effected'); ok = false; note.push('2a double'); }
    if ((await drCr(rr)).n !== 2) { fail('2a journal grew'); ok = false; note.push('2a journal'); }

    // 2b unlockWallet
    const u2 = await newUser('T2B', 80000, 0);
    const lh = ref('2BH'), ur = ref('2BR');
    show('2b user', { id: u2 });
    const lk = await inTx((c) => engine.lockWallet({ client: c, userId: u2, amount: 40000, reference: lh }));
    show('2b lockWallet', lk.r);
    show('2b state after lock', await snap(u2));
    show('2b lock op row', await opRow(lh));
    const b1 = await inTx((c) => engine.unlockWallet({ client: c, userId: u2, amount: 40000, reference: ur }));
    show('2b FIRST unlockWallet', b1.r);
    const bF = await snap(u2);
    show('2b financial state after FIRST', bF);
    show('2b journal after FIRST', await jRows(ur));
    show('2b effective ledger entries after FIRST', (await drCr(ur)).n);
    const b2 = await inTx((c) => engine.unlockWallet({ client: c, userId: u2, amount: 40000, reference: ur }));
    show('2b SECOND unlockWallet (identical request)', b2.r);
    const bS = await snap(u2);
    show('2b financial state after SECOND', bS);
    show('2b journal after SECOND', await jRows(ur));
    show('2b effective ledger entries after SECOND', (await drCr(ur)).n);
    show('2b op row after SECOND', await opRow(ur));
    if (bF.wallet !== 80000 || bF.locked !== 0) { fail('2b not restored'); ok = false; note.push('2b not restored'); }
    if (bS.wallet !== bF.wallet || bS.locked !== bF.locked) { fail('2b duplicate double-effected'); ok = false; note.push('2b double'); }
    if ((await drCr(ur)).n !== 2) { fail('2b journal grew'); ok = false; note.push('2b journal'); }
    record(2, 'Release + idempotency', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ============ TEST 3 : Duplicate release - no double effect ============
  H('TEST #3  Duplicate release - no double effect');
  {
    let ok = true, note = [];
    const u = await newUser('T3', 60000, 0);
    const h = ref('3H'), r = ref('3R');
    show('3 user', { id: u });
    await T(engine.holdFunds({ userId: u, amount: 20000, reference: h }), 20000, '3 hold');
    show('3 state after hold', await snap(u));
    show('3 identical release request repeated 4x (ref ' + r + ', amount 20000)');
    const tr = [];
    for (let i = 1; i <= 4; i++) {
      const out = await T(engine.releaseHold({ userId: u, amount: 20000, reference: r }), 20000, '3 r' + i);
      const s = await snap(u);
      tr.push({ attempt: i, result: out, wallet: s.wallet, locked: s.locked, ledgerEntries: (await drCr(r)).n });
    }
    tr.forEach((t) => show('3 attempt ' + t.attempt, t));
    show('3 final op row', await opRow(r));
    show('3 final journal rows', await jRows(r));
    show('3 final audit rows', await aRows(r));
    const f = tr[0], l = tr[3];
    if (f.wallet !== 60000 || f.locked !== 0) { fail('3 first not restored'); ok = false; note.push('3 first'); }
    if (l.wallet !== f.wallet || l.locked !== f.locked) { fail('3 final drifted'); ok = false; note.push('3 drift'); }
    if (l.ledgerEntries !== 2) { fail('3 ledgerEntries=' + l.ledgerEntries); ok = false; note.push('3 entries=' + l.ledgerEntries); }
    record(3, 'Duplicate release', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ============ TEST 4 : Combined effect guards (direct regression for the old defect) ============
  H('TEST #4  Combined effect guards - no orphan journal, no false success');
  {
    let ok = true, note = [];
    const u = await newUser('T4', 50000, 0);
    show('4 user', { id: u, wallet: 50000, locked: 0 });
    show('4 state before', await snap(u));
    const before = await snap(u);

    // 4a unlockWallet over-release
    const ra = ref('4A');
    show('4a reference', ra);
    show('4a request', 'unlockWallet amount=999999 with locked_balance=0');
    const a = await inTx((c) => engine.unlockWallet({ client: c, userId: u, amount: 999999, reference: ra }));
    show('4a returned ok?', a.ok);
    show('4a error (must be a 400 rejection, NOT success:true)', a.err);
    show('4a state after', await snap(u));
    const resa = await residue(ra);
    show('4a RESIDUE op', resa.op);
    show('4a RESIDUE journal (THE OLD DEFECT WAS 2 ORPHAN ROWS HERE)', resa.journal);
    show('4a RESIDUE audit', resa.audit);
    if (a.ok) { fail('4a reported success'); ok = false; note.push('4a success'); }
    if (a.statusCode !== 400) { fail('4a not a 400 rejection, got ' + a.statusCode); ok = false; note.push('4a code'); }
    if (!residueClean(resa)) { fail('4a residue left'); ok = false; note.push('4a residue'); }

    // 4b releaseHold over-release
    const rb = ref('4B');
    show('4b reference', rb);
    show('4b request', 'releaseHold amount=999999 with locked_balance=0');
    let eb = null, okb = true, retb = null;
    try { retb = await T(engine.releaseHold({ userId: u, amount: 999999, reference: rb }), 20000, '4b'); }
    catch (e) { okb = false; eb = e.message; }
    show('4b returned without throwing?', okb);
    show('4b return value', retb);
    show('4b error', eb);
    show('4b state after', await snap(u));
    const resb = await residue(rb);
    show('4b RESIDUE op', resb.op);
    show('4b RESIDUE journal (OLD DEFECT: journal posted + success:true)', resb.journal);
    show('4b RESIDUE audit (OLD DEFECT: false audit rows)', resb.audit);
    if (okb) { fail('4b did not reject'); ok = false; note.push('4b no reject'); }
    if (!residueClean(resb)) { fail('4b residue left'); ok = false; note.push('4b residue'); }

    // 4c captureLock over-capture
    const rc = ref('4C');
    show('4c reference', rc);
    show('4c request', 'captureLock amount=999999 with locked_balance=0');
    const c = await inTx((cl) => engine.captureLock({ client: cl, userId: u, amount: 999999, reference: rc }));
    show('4c returned ok?', c.ok);
    show('4c error', c.err);
    const resc = await residue(rc);
    show('4c RESIDUE op', resc.op);
    show('4c RESIDUE journal', resc.journal);
    show('4c RESIDUE audit', resc.audit);
    if (c.ok) { fail('4c reported success'); ok = false; note.push('4c success'); }
    if (!residueClean(resc)) { fail('4c residue left'); ok = false; note.push('4c residue'); }

    const after = await snap(u);
    show('4 state after ALL rejected attempts (must equal before)', after);
    if (after.wallet !== before.wallet || after.locked !== before.locked) { fail('4 projection changed'); ok = false; note.push('4 projection'); }

    // 4d DB backstop
    show('4d request', 'UPDATE users SET locked_balance=-1 (must be refused by CHECK)');
    let refused = false, refErr = null;
    try { const cl = await pool.connect(); await cl.query('BEGIN'); await cl.query(`UPDATE users SET locked_balance=-1 WHERE id=$1`, [u]); await cl.query('ROLLBACK'); cl.release(); }
    catch (e) { refused = true; refErr = e.message; }
    show('4d refused', refused);
    show('4d error', refErr);
    if (!refused) { fail('4d CHECK did not refuse'); ok = false; note.push('4d check'); }
    const negAll = await pool.query(`SELECT count(*)::int n FROM users WHERE wallet_balance < 0 OR locked_balance < 0`);
    show('4 users in whole DB with a negative wallet/locked', negAll.rows[0].n);
    if (negAll.rows[0].n !== 0) { fail('4 negative balance exists'); ok = false; note.push('4 negative'); }
    record(4, 'Combined effect guards', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ============ TEST 5 : terminal state ============
  H('TEST #5  SUCCESS/FAILED terminal state');
  {
    let ok = true, note = [];
    const u = await newUser('T5', 90000, 0);
    show('5 user', { id: u });
    const rL = ref('5LK'), rC = ref('5CP'), rH = ref('5HL'), rR = ref('5RL');
    show('5a lockWallet 20000  ', await inTx((c) => engine.lockWallet({ client: c, userId: u, amount: 20000, reference: rL })));
    show('5b captureLock 10000 ', await inTx((c) => engine.captureLock({ client: c, userId: u, amount: 10000, reference: rC })));
    show('5c holdFunds  30000  ', await T(engine.holdFunds({ userId: u, amount: 30000, reference: rH }), 20000, '5c'));
    show('5d releaseHold 30000', await T(engine.releaseHold({ userId: u, amount: 30000, reference: rR }), 20000, '5d'));
    show('5 state after', await snap(u));
    for (const [lbl, r] of [['5a lock', rL], ['5b capture', rC], ['5c hold', rH], ['5d release', rR]]) {
      show(lbl + ' op row', await opRow(r));
      const o = await opRow(r);
      if (!o || o.status !== 'SUCCESS') { fail(lbl + ' not SUCCESS'); ok = false; note.push(lbl + '=' + (o ? o.status : 'none')); }
    }
    const mine = await pool.query(`SELECT reference_id, operation_type, status FROM financial_operations WHERE reference_id = ANY($1) ORDER BY id`, [REFS]);
    say('  5e EVERY operation created by THIS run:');
    mine.rows.forEach((o) => say('     ' + o.operation_type + ' ' + o.reference_id + ' status=' + o.status));
    const newMine = mine.rows.filter((o) => o.status === 'NEW');
    show('5e operations of this run left in NEW', newMine);
    if (newMine.length > 0) { fail('5e ' + newMine.length + ' left in NEW'); ok = false; note.push('5e NEW=' + newMine.length); }
    const legacy = await pool.query(`SELECT reference_id, operation_type, status FROM financial_operations WHERE status <> 'SUCCESS' AND NOT (reference_id = ANY($1)) ORDER BY id`, [REFS]);
    show('5f PRE-EXISTING non-SUCCESS rows from the pre-fix run (disclosed, not touched, not this run\'s verdict)', legacy.rows);
    record(5, 'SUCCESS/FAILED terminal state', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ============ TEST 6 : retry cannot double the financial effect ============
  H('TEST #6  Retry - no double financial effect');
  {
    let ok = true, note = [];
    const u = await newUser('T6', 70000, 0);
    const rf = ref('6RT'), fund = ref('6FD');
    show('6 user', { id: u });
    show('6 reference that will fail its guard first', rf);
    show('6 state before', await snap(u));
    const before = await snap(u);
    // first execution: guard fails -> 400, fully rolled back
    const f1 = await inTx((c) => engine.unlockWallet({ client: c, userId: u, amount: 60000, reference: rf }));
    show('6 FIRST execution ok?', f1.ok);
    show('6 FIRST execution error', f1.err);
    const s1 = await snap(u);
    show('6 financial state after FIRST', s1);
    const r1 = await residue(rf);
    show('6 residue after FIRST (op / journal / audit)', { op: r1.op, journalRows: r1.journal.length, auditRows: r1.audit.length });
    show('6 effective ledger entries after FIRST', (await drCr(rf)).n);
    if (f1.ok) { fail('6 first did not fail its guard'); ok = false; note.push('6 first ok'); }
    if (!residueClean(r1)) { fail('6 residue after failed attempt'); ok = false; note.push('6 residue'); }
    if (s1.wallet !== before.wallet || s1.locked !== before.locked) { fail('6 failed attempt moved money'); ok = false; note.push('6 moved'); }
    // now fund it and retry the SAME reference
    show('6 funding hold ' + fund + ' then RETRY of ' + rf);
    await T(engine.holdFunds({ userId: u, amount: 60000, reference: fund }), 20000, '6 fund');
    show('6 state after funding hold', await snap(u));
    const f2 = await inTx((c) => engine.unlockWallet({ client: c, userId: u, amount: 60000, reference: rf }));
    show('6 SECOND execution (retry, same reference)', f2.r);
    const s2 = await snap(u);
    show('6 financial state after SECOND (retry)', s2);
    show('6 journal after SECOND', await jRows(rf));
    show('6 effective ledger entries after SECOND (must be exactly 2)', (await drCr(rf)).n);
    show('6 op row after SECOND', await opRow(rf));
    const n2 = (await drCr(rf)).n;
    if (n2 !== 2) { fail('6 retry produced ' + n2 + ' ledger rows, expected exactly 2'); ok = false; note.push('6 entries=' + n2); }
    if (s2.locked !== 0) { fail('6 retry did not release exactly once'); ok = false; note.push('6 locked=' + s2.locked); }
    // and a third retry of an already-successful reference
    const f3 = await inTx((c) => engine.unlockWallet({ client: c, userId: u, amount: 60000, reference: rf }));
    show('6 THIRD execution (retry of a SUCCESS reference)', f3.r);
    const s3 = await snap(u);
    show('6 financial state after THIRD', s3);
    show('6 effective ledger entries after THIRD (must still be 2)', (await drCr(rf)).n);
    if (s3.wallet !== s2.wallet || s3.locked !== s2.locked) { fail('6 third retry double-effected'); ok = false; note.push('6 third double'); }
    if ((await drCr(rf)).n !== 2) { fail('6 third retry added ledger rows'); ok = false; note.push('6 third entries'); }
    if (!f3.r || f3.r.dedup !== true) { fail('6 third retry was not deduped'); ok = false; note.push('6 not deduped'); }
    record(6, 'Retry - no double financial effect', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ============ TEST 7 : single-transaction atomicity ============
  H('TEST #7  Single-transaction atomicity');
  {
    let ok = true, note = [];
    const u = await newUser('T7', 120000, 0);
    const r = ref('7TX');
    show('7 user', { id: u });
    show('7 reference', r);
    const before = await snap(u);
    const c0 = await pool.query(`SELECT (SELECT count(*)::int FROM financial_operations) o,(SELECT count(*)::int FROM journal_entries) j,(SELECT count(*)::int FROM financial_audit_log) a`);
    show('7 BEFORE balances', before);
    show('7 BEFORE row counts', c0.rows[0]);
    let inside = null, jIn = null, oIn = null, forced = null;
    const c = await pool.connect();
    await c.query('BEGIN');
    say('  7 --- inside BEGIN ---');
    const lr = await engine.lockWallet({ client: c, userId: u, amount: 45000, reference: r });
    show('7 inside-tx lockWallet', lr);
    const q = await c.query(`SELECT wallet_balance, locked_balance FROM users WHERE id=$1`, [u]);
    inside = { wallet: Number(q.rows[0].wallet_balance), locked: Number(q.rows[0].locked_balance) };
    show('7 inside-tx balances AFTER mutation (uncommitted)', inside);
    jIn = (await c.query(`SELECT la.account_code, je.direction, je.amount FROM journal_entries je JOIN ledger_accounts la ON la.id=je.account_id WHERE je.reference_id=$1 ORDER BY je.id`, [r])).rows;
    show('7 inside-tx journal (uncommitted)', jIn);
    oIn = (await c.query(`SELECT operation_type, status FROM financial_operations WHERE reference_id=$1`, [r])).rows;
    show('7 inside-tx operation row (uncommitted)', oIn);
    say('  7 --- forcing failure INSIDE the transaction ---');
    try { await c.query(`SELECT * FROM tbl_zz_nonexistent_force_error`); } catch (e) { forced = e.message; }
    show('7 forced failure', forced);
    await c.query('ROLLBACK'); c.release();
    say('  7 --- ROLLBACK ---');
    const after = await snap(u);
    const c1 = await pool.query(`SELECT (SELECT count(*)::int FROM financial_operations) o,(SELECT count(*)::int FROM journal_entries) j,(SELECT count(*)::int FROM financial_audit_log) a`);
    show('7 AFTER balances', after);
    const res = await residue(r);
    show('7 AFTER residue op', res.op);
    show('7 AFTER residue journal', res.journal);
    show('7 AFTER residue audit', res.audit);
    show('7 AFTER row counts', c1.rows[0]);
    if (inside.wallet !== before.wallet - 45000) { fail('7 in-tx mutation not visible (test invalid)'); ok = false; note.push('7 in-tx'); }
    if (after.wallet !== before.wallet || after.locked !== before.locked) { fail('7 rollback incomplete'); ok = false; note.push('7 rollback'); }
    if (!residueClean(res)) { fail('7 residue survived rollback'); ok = false; note.push('7 residue'); }
    if (c1.rows[0].o !== c0.rows[0].o || c1.rows[0].j !== c0.rows[0].j || c1.rows[0].a !== c0.rows[0].a) { fail('7 counts drifted'); ok = false; note.push('7 counts'); }
    record(7, 'Single-tx atomicity', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ============ TEST 8 : double entry ============
  H('TEST #8  Double-entry DR == CR (this run only)');
  {
    let ok = true, note = [];
    const g = await pool.query(
      `SELECT je.entry_group_id, je.reference_id,
              COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric dr,
              COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0)::numeric cr,
              count(*)::int lines
         FROM journal_entries je WHERE je.reference_id = ANY($1) GROUP BY 1,2 ORDER BY 1`, [REFS]);
    say('  8 per-group breakdown (this run):');
    g.rows.forEach((r) => { const d = Number(r.dr) - Number(r.cr); say('     ' + r.entry_group_id + ' DR=' + r.dr + ' CR=' + r.cr + ' diff=' + d + ' lines=' + r.lines); if (d !== 0) { fail('8 unbalanced ' + r.entry_group_id); ok = false; note.push('8 unbalanced'); } if (r.lines < 2) { fail('8 single-sided ' + r.entry_group_id); ok = false; note.push('8 single-sided'); } });
    const t = (await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric dr, COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric cr, count(*)::int n FROM journal_entries WHERE reference_id = ANY($1)`, [REFS])).rows[0];
    show('8 TOTAL DR (this run)', t.dr);
    show('8 TOTAL CR (this run)', t.cr);
    show('8 DIFFERENCE', Number(t.dr) - Number(t.cr));
    show('8 groups / rows', g.rowCount + ' / ' + t.n);
    const nonpos = await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE reference_id = ANY($1) AND amount <= 0`, [REFS]);
    show('8 non-positive amounts', nonpos.rows[0].n);
    if (Number(t.dr) - Number(t.cr) !== 0) { fail('8 global diff'); ok = false; note.push('8 global'); }
    if (nonpos.rows[0].n !== 0) { fail('8 non-positive amount'); ok = false; note.push('8 nonpos'); }
    const gal = await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric dr, COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric cr FROM journal_entries`);
    show('8 whole-DB DR (baseline + this run)', gal.rows[0].dr);
    show('8 whole-DB CR (baseline + this run)', gal.rows[0].cr);
    show('8 whole-DB difference', Number(gal.rows[0].dr) - Number(gal.rows[0].cr));
    record(8, 'Double-entry DR == CR', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ============ TEST 9 : reconciliation + TX224 ============
  H('TEST #9  Reconciliation + TX224 untouched');
  {
    let ok = true, note = [];
    say('  9a test users of THIS run:');
    const urows = (await pool.query(`SELECT id, wallet_balance, locked_balance FROM users WHERE id = ANY($1) ORDER BY id`, [USERS])).rows;
    urows.forEach((u) => say('     user#' + u.id + ' wallet=' + u.wallet_balance + ' locked=' + u.locked_balance + ' seed=' + SEED.get(u.id)));
    const neg = await pool.query(`SELECT count(*)::int n FROM users WHERE id = ANY($1) AND (wallet_balance < 0 OR locked_balance < 0)`, [USERS]);
    show('9a negative balances among this run\'s users', neg.rows[0].n);
    if (neg.rows[0].n !== 0) { fail('9a negative'); ok = false; note.push('9a'); }

    say('  9b IDENTITY A : CARD_HOLD net credit  ==  SUM(users.locked_balance)');
    const a = (await pool.query(
      `SELECT
        (SELECT COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0)::numeric FROM journal_entries je WHERE je.reference_id = ANY($1) AND je.account_id=(SELECT id FROM ledger_accounts WHERE account_code='CARD_HOLD')) hold_net,
        (SELECT COALESCE(SUM(locked_balance),0)::numeric FROM users WHERE id = ANY($2)) proj_locked`, [REFS, USERS])).rows[0];
    show('9b ledger  CARD_HOLD net credit', a.hold_net);
    show('9b projection SUM(locked_balance)', a.proj_locked);
    const gapA = Number(a.hold_net) - Number(a.proj_locked);
    show('9b GAP (must be 0)', gapA);
    if (gapA !== 0) { fail('9b identity gap ' + gapA); ok = false; note.push('9b gap=' + gapA); }

    say('  9c IDENTITY B : CUSTOMER_WALLET net credit  ==  SUM(wallet) - SUM(seed)');
    const b = (await pool.query(
      `SELECT
        (SELECT COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0)::numeric - COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric FROM journal_entries je WHERE je.reference_id = ANY($1) AND je.account_id=(SELECT id FROM ledger_accounts WHERE account_code='CUSTOMER_WALLET')) wacct_net,
        (SELECT COALESCE(SUM(wallet_balance),0)::numeric FROM users WHERE id = ANY($2)) proj_wallet`, [REFS, USERS])).rows[0];
    let seedSum = 0; USERS.forEach((i) => { seedSum += SEED.get(i); });
    show('9c ledger  CUSTOMER_WALLET net credit', b.wacct_net);
    show('9c projection SUM(wallet_balance)', b.proj_wallet);
    show('9c seeded (pre-test) wallet total', seedSum);
    show('9c projection movement', Number(b.proj_wallet) - seedSum);
    const gapB = Number(b.wacct_net) - (Number(b.proj_wallet) - seedSum);
    show('9c GAP (must be 0)', gapB);
    if (gapB !== 0) { fail('9c identity gap ' + gapB); ok = false; note.push('9c gap=' + gapB); }

    say('  9d IDENTITY C : no ledger entry without a matching balance movement');
    const orphan = (await pool.query(
      `SELECT je.reference_id, je.operation_type, je.status, COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric dr
         FROM journal_entries je JOIN financial_operations fo ON fo.reference_id = je.reference_id
        WHERE je.reference_id = ANY($1)
        GROUP BY je.reference_id, je.operation_type, je.status
       HAVING count(*) FILTER (WHERE true) > 0
          AND NOT EXISTS (SELECT 1 FROM financial_audit_log fa WHERE fa.reference_id = je.reference_id)
        ORDER BY je.reference_id`, [REFS])).rows;
    say('  9d operations of this run with a ledger entry but NO balance movement:');
    if (orphan.length === 0) say('     (none)');
    orphan.forEach((o) => say('     ' + o.reference_id + ' ' + o.operation_type + ' status=' + o.status + ' DR=' + o.dr));
    show('9d orphan count (this is what the pre-fix run found: 3)', orphan.length);
    if (orphan.length !== 0) { fail('9d ' + orphan.length + ' orphan group(s)'); ok = false; note.push('9d=' + orphan.length); }

    say('  9e IDENTITY D : no audit row without a matching ledger group');
    const falseAudit = (await pool.query(
      `SELECT fa.reference_id, count(*)::int n FROM financial_audit_log fa
        WHERE fa.reference_id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.reference_id = fa.reference_id)
        GROUP BY 1`, [REFS])).rows;
    say('  9e audit-without-journal groups: ' + (falseAudit.length === 0 ? '(none)' : JSON.stringify(falseAudit)));
    if (falseAudit.length !== 0) { fail('9e false audit rows'); ok = false; note.push('9e'); }

    say('  9f every operation of this run is SUCCESS and fully reconciled');
    const st = (await pool.query(`SELECT status, count(*)::int n FROM financial_operations WHERE reference_id = ANY($1) GROUP BY status ORDER BY status`, [REFS])).rows;
    show('9f status distribution (this run)', st);
    if (st.some((r) => r.status !== 'SUCCESS')) { fail('9f non-SUCCESS persisted'); ok = false; note.push('9f'); }

    say('  9g PRE-FIX BASELINE MUST BE UNCHANGED (proves no tampering / no data fix-up)');
    const b1 = await pool.query(`SELECT (SELECT count(*)::int FROM financial_operations) ops,(SELECT count(*)::int FROM journal_entries) je,(SELECT count(*)::int FROM financial_audit_log) au,(SELECT count(*)::int FROM users) us`);
    show('9g counts at END of this run', b1.rows[0]);
    const grew = { ops: b1.rows[0].ops - B0.ops, je: b1.rows[0].je - B0.je, au: b1.rows[0].au - B0.au, us: b1.rows[0].us - B0.us };
    show('9g rows ADDED by this run (never removed)', grew);
    const legacyRes = (await pool.query(`SELECT COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric v, count(DISTINCT fo.reference_id)::int refs FROM journal_entries je JOIN financial_operations fo ON fo.reference_id=je.reference_id WHERE fo.status <> 'SUCCESS'`)).rows[0];
    show('9g pre-fix residue still present (was 2254998 across 9 refs)', legacyRes.v + ' across ' + legacyRes.refs + ' refs');
    if (Number(legacyRes.v) !== 2254998 || legacyRes.refs !== 9) { fail('9g baseline was altered'); ok = false; note.push('9g baseline'); }
    if (grew.ops < 0 || grew.je < 0 || grew.au < 0) { fail('9g rows were DELETED'); ok = false; note.push('9g deleted'); }

    say('  9h TX224 / WD-3EC32D6D safety');
    let tx = 0;
    for (const t of ['financial_operations', 'journal_entries', 'wallet_ledger', 'financial_audit_log', 'financial_anomalies']) {
      const tc = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND data_type IN ('character varying','text','character')`, [t])).rows;
      for (const c of tc.rows) {
        const q = (await pool.query(`SELECT count(*)::int n FROM "${t}" WHERE "${c.column_name}" ILIKE '%TX224%' OR "${c.column_name}" ILIKE '%3EC32D6D%'`)).rows[0].n;
        tx += q; if (q) say('     !! ' + t + '.' + c.column_name + ' = ' + q);
      }
    }
    show('9h total TX224/WD-3EC32D6D rows across all scanned tables', tx);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'financialEngine.js'), 'utf8');
    show('9h TX224 literals in engine source', (src.match(/TX224|3EC32D6D/g) || []).length);
    const lens = REFS.map((r) => r.length);
    show('9h references used in this run', REFS.length + ' (length ' + Math.min(...lens) + '..' + Math.max(...lens) + ', limit 15)');
    if (tx !== 0) { fail('9h TX224 artifact'); ok = false; note.push('9h tx'); }
    if ((src.match(/TX224|3EC32D6D/g) || []).length !== 0) { fail('9h literal in source'); ok = false; note.push('9h literal'); }
    if (Math.max(...lens) > 15) { fail('9h ref too long'); ok = false; note.push('9h ref'); }
    record(9, 'Reconciliation + TX224 untouched', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  H('FINAL MATRIX');
  for (let n = 1; n <= 9; n++) {
    const r = RESULTS[n];
    say(String(n).padStart(2) + '  ' + (r ? r.inv.padEnd(34) : 'MISSING').padEnd(36) + (r ? r.st : 'PENDING') + (r && r.note ? '   [' + r.note + ']' : ''));
  }
  H('SUMMARY');
  const st = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (RESULTS[n] ? RESULTS[n].st : 'PENDING'));
  say('LIVE results = ' + st.join(', '));
  say('PASS=' + st.filter((x) => x === 'PASS').length + ' FAIL=' + st.filter((x) => x === 'FAIL').length + ' PENDING=' + st.filter((x) => x === 'PENDING').length);
  say('assertion failures = ' + ERR);
  finish(0);
})().catch((e) => { say('\nSUITE ERROR ' + ((e && e.stack) || e)); finish(1); });
