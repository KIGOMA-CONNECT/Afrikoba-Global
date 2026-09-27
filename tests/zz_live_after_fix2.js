'use strict';
/**
 * CORRECTED re-run of TEST #1 (holdFunds race) and TEST #9 (reconciliation).
 * Fixes to the harness, NOT to the engine:
 *   - #1: reference tags are now unique per race mode (the previous run reused
 *        the same deterministic reference, so the second mode got dedup:true
 *        and was wrongly counted as a second "winner").
 *   - #9b: "net credit" must be CR - DR; the previous query summed CR only.
 *   - #9d: operation_type lives on financial_operations, not journal_entries.
 * A completely fresh set of users and references is used so every identity is
 * computed on data this script itself produced.
 */
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'zz_out_live_after_fix2.txt');
const buf = [];
const say = (s) => buf.push(s === undefined ? 'undefined' : String(s));
const H = (s) => say('\n########## ' + s + ' ##########');
let ERR = 0;
const fail = (m) => { ERR++; say('  !! ' + m); };
function finish(c) { try { fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8'); } catch (e) {} process.exit(c || 0); }
process.on('unhandledRejection', (e) => { say('FATAL ' + ((e && e.stack) || e)); finish(9); });
process.on('uncaughtException', (e) => { say('FATAL ' + ((e && e.stack) || e)); finish(9); });

const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const engine = require(path.join(__dirname, '..', 'src', 'services', 'financialEngine'));

const NONCE = Date.now().toString(36).toUpperCase().slice(-6);
let SEQ = 0;
const REFS = [], SEED = new Map(), USERS = [];
const ref = (t) => { const r = ('R' + t + NONCE).toUpperCase().slice(0, 15); REFS.push(r); return r; };
const show = (t, o) => say('  ' + t + ' = ' + (typeof o === 'object' ? JSON.stringify(o) : o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDeadlock = (e) => e && /deadlock|40P01/i.test((e.message || '') + ' ' + (e.code || ''));
const RESULTS = {};
const record = (n, inv, st, note) => { RESULTS[n] = { inv, st, note: note || '' }; say('  >> TEST #' + n + ' = ' + st + (note ? '  [' + note + ']' : '')); };
async function newUser(tag, wallet, locked) {
  SEQ += 1;
  const phone = '09' + String(Date.now()).slice(-7) + String(SEQ).padStart(2, '0');
  const r = (await pool.query(`INSERT INTO users (full_name, phone_number, wallet_balance, locked_balance) VALUES ($1,$2,$3,$4) RETURNING id`, ['ZZ Recon ' + tag, phone, wallet, locked])).rows[0];
  SEED.set(r.id, wallet); USERS.push(r.id); return r.id;
}
const snap = async (id) => { const r = await pool.query(`SELECT wallet_balance, locked_balance FROM users WHERE id=$1`, [id]); return { wallet: Number(r.rows[0].wallet_balance), locked: Number(r.rows[0].locked_balance) }; };
const opRow = async (r) => (await pool.query(`SELECT id, operation_type, reference_id, status, amount FROM financial_operations WHERE reference_id=$1`, [r])).rows[0] || null;
const jRows = async (r) => (await pool.query(`SELECT la.account_code, je.direction, je.amount FROM journal_entries je JOIN ledger_accounts la ON la.id=je.account_id WHERE je.reference_id=$1 ORDER BY je.id`, [r])).rows;
const aCount = async (r) => (await pool.query(`SELECT count(*)::int n FROM financial_audit_log WHERE reference_id=$1`, [r])).rows[0].n;
const jCount = async (r) => (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE reference_id=$1`, [r])).rows[0].n;
async function residue(r) { return { op: await opRow(r), j: await jCount(r), a: await aCount(r) }; }
const clean = (x) => x.op === null && x.j === 0 && x.a === 0;
async function inTx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return { ok: true, r }; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); return { ok: false, err: e.message, statusCode: e.statusCode }; }
  finally { c.release(); }
}

(async () => {
  say('CORRECTED POST-FIX RE-RUN  nonce=' + NONCE);
  const id = await pool.query(`SELECT current_database() db, current_user usr`);
  show('identity', id.rows[0]);
  const b0 = (await pool.query(`SELECT (SELECT count(*)::int FROM financial_operations) ops,(SELECT count(*)::int FROM journal_entries) je,(SELECT count(*)::int FROM financial_audit_log) au,(SELECT count(*)::int FROM users) us`)).rows[0];
  show('counts at START', b0);
  const B0 = b0;

  // ================= TEST 1 (corrected) =================
  H('TEST #1 (corrected)  Hold - conditional atomic guard');
  {
    let ok = true, note = [];
    // 1a single hold
    const ua = await newUser('T1a', 100000, 0);
    const r1a = ref('1A');
    show('1a user', { id: ua, wallet: 100000, locked: 0 });
    show('1a reference', r1a);
    show('1a result', await engine.holdFunds({ userId: ua, amount: 30000, reference: r1a }));
    const s = await snap(ua);
    show('1a wallet 100000 -> ' + s.wallet + ' | locked 0 -> ' + s.locked);
    show('1a op row', await opRow(r1a));
    show('1a journal', await jRows(r1a));
    show('1a audit rows', await aCount(r1a));
    if (s.wallet !== 70000 || s.locked !== 30000) { fail('1a balances'); ok = false; note.push('1a balances'); }
    if ((await opRow(r1a)).status !== 'SUCCESS') { fail('1a not SUCCESS'); ok = false; note.push('1a status'); }
    if ((await jCount(r1a)) !== 2) { fail('1a journal rows'); ok = false; note.push('1a journal'); }

    // 1b over-hold -> rejected, zero residue
    const r1b = ref('1B');
    show('1b reference', r1b);
    show('1b state before', await snap(ua));
    let e1b = null;
    try { await engine.holdFunds({ userId: ua, amount: 999999, reference: r1b }); } catch (e) { e1b = e.message; }
    show('1b rejected with', e1b);
    show('1b state after', await snap(ua));
    show('1b RESIDUE op/journal/audit', await residue(r1b));
    if (!e1b) { fail('1b not rejected'); ok = false; note.push('1b no reject'); }
    if (!clean(await residue(r1b))) { fail('1b residue'); ok = false; note.push('1b residue'); }

    // 1c race via lockWallet, 1d race via holdFunds - UNIQUE refs each
    const races = [
      { mode: 'lockWallet', tagA: '1GA', tagB: '1GB' },
      { mode: 'holdFunds', tagA: '1HA', tagB: '1HB' },
    ];
    for (const R of races) {
      const uu = await newUser('T1' + R.mode, 70000, 0);
      const ra = ref(R.tagA), rb = ref(R.tagB);
      const before = await snap(uu);
      say('  --- 1 race via ' + R.mode + ' : 2 x 50000 against ' + before.wallet + ' available ---');
      show('refs', { a: ra, b: rb });
      const one = async (rf, label) => {
        for (let i = 1; i <= 4; i++) {
          try {
            if (R.mode === 'lockWallet') { const x = await inTx((c) => engine.lockWallet({ client: c, userId: uu, amount: 50000, reference: rf })); if (x.ok) return { label, out: 'SUCCESS', attempt: i, r: x.r }; throw Object.assign(new Error(x.err), { statusCode: x.statusCode }); }
            return { label, out: 'SUCCESS', attempt: i, r: await engine.holdFunds({ userId: uu, amount: 50000, reference: rf }) };
          } catch (e) { if (isDeadlock(e) && i < 4) { say('  ' + label + ' attempt ' + i + ' deadlock -> retry'); await sleep(150); continue; } return { label, out: 'REJECTED', attempt: i, error: e.message }; }
        }
        return { label, out: 'GAVE_UP' };
      };
      const [x, y] = await Promise.all([one(ra, 'A'), one(rb, 'B')]);
      show('execution A', x);
      show('execution B', y);
      const after = await snap(uu);
      const winners = [x, y].filter((z) => z.out === 'SUCCESS');
      show('winners (expect 1)', winners.length);
      const winRef = winners.length ? winners[0].r.reference : null;
      const loseRef = winners.length ? (winners[0].r.reference === ra ? rb : ra) : null;
      show('winner reference', winRef);
      show('loser reference', loseRef);
      show('state before -> after', { before, after });
      show('winner op row', winRef ? await opRow(winRef) : null);
      show('winner journal', winRef ? await jRows(winRef) : null);
      show('loser RESIDUE op/journal/audit', loseRef ? await residue(loseRef) : 'n/a');
      if (winners.length !== 1) { fail('1 ' + R.mode + ' winners=' + winners.length); ok = false; note.push('1 ' + R.mode + ' winners=' + winners.length); continue; }
      if (after.wallet + after.locked !== before.wallet + before.locked) { fail('1 ' + R.mode + ' not conserved'); ok = false; note.push('1 ' + R.mode + ' conservation'); }
      if (after.wallet < 0 || after.locked < 0) { fail('1 ' + R.mode + ' negative'); ok = false; note.push('1 ' + R.mode + ' negative'); }
      if (!clean(await residue(loseRef))) { fail('1 ' + R.mode + ' loser residue'); ok = false; note.push('1 ' + R.mode + ' loser residue'); }
      if ((await jCount(winRef)) !== 2) { fail('1 ' + R.mode + ' winner journal != 2'); ok = false; note.push('1 ' + R.mode + ' journal'); }
    }
    record(1, 'Hold conditional-atomic', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  // ================= TEST 9 (corrected) =================
  H('TEST #9 (corrected)  Reconciliation + TX224 untouched');
  {
    let ok = true, note = [];
    // build a self-contained scenario so the identities are exact
    const u1 = await newUser('R1', 200000, 0);   // hold -> release (net zero)
    const u2 = await newUser('R2', 200000, 0);   // lock -> capture (locked reduced)
    const u3 = await newUser('R3', 200000, 0);   // lock -> unlock (net zero)
    const u4 = await newUser('R4', 200000, 0);   // hold left open + one REJECTED release
    show('9 scenario users', { u1, u2, u3, u4 });

    const a1 = ref('RH1'), a2 = ref('RR1');                       // u1 hold+release
    await engine.holdFunds({ userId: u1, amount: 60000, reference: a1 });
    await engine.releaseHold({ userId: u1, amount: 60000, reference: a2 });
    show('9 u1 after hold+release', await snap(u1));

    const b1 = ref('RL2'), b2 = ref('RC2');                       // u2 lock+capture
    await inTx((c) => engine.lockWallet({ client: c, userId: u2, amount: 80000, reference: b1 }));
    await inTx((c) => engine.captureLock({ client: c, userId: u2, amount: 30000, reference: b2 }));
    show('9 u2 after lock+capture', await snap(u2));

    const c1 = ref('RL3'), c2 = ref('RU3');                       // u3 lock+unlock
    await inTx((c) => engine.lockWallet({ client: c, userId: u3, amount: 45000, reference: c1 }));
    await inTx((c) => engine.unlockWallet({ client: c, userId: u3, amount: 45000, reference: c2 }));
    show('9 u3 after lock+unlock', await snap(u3));

    const d1 = ref('RH4'), d2 = ref('RREJ');                      // u4 hold + REJECTED release
    await engine.holdFunds({ userId: u4, amount: 25000, reference: d1 });
    show('9 u4 after hold', await snap(u4));
    let de = null;
    try { await engine.releaseHold({ userId: u4, amount: 999999, reference: d2 }); } catch (e) { de = e.message; }
    show('9 u4 REJECTED release error', de);
    show('9 u4 state after rejected release', await snap(u4));
    show('9 u4 REJECTED reference RESIDUE op/journal/audit', await residue(d2));
    if (!clean(await residue(d2))) { fail('9 rejected release left residue'); ok = false; note.push('9 residue'); }

    say('  9a every operation of this scenario');
    const ops = (await pool.query(`SELECT reference_id, operation_type, status, amount FROM financial_operations WHERE reference_id = ANY($1) ORDER BY id`, [REFS])).rows;
    ops.forEach((o) => say('     ' + o.operation_type + ' ' + o.reference_id + ' status=' + o.status + ' amount=' + o.amount));
    if (ops.some((o) => o.status !== 'SUCCESS')) { fail('9a non-SUCCESS persisted'); ok = false; note.push('9a'); }
    show('9a operation count', ops.length);

    say('  9b IDENTITY A (corrected: net = CR - DR) : CARD_HOLD  ==  SUM(locked_balance)');
    const A = (await pool.query(
      `SELECT
        (SELECT COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0)::numeric
           - COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric
           FROM journal_entries je
          WHERE je.reference_id = ANY($1)
            AND je.account_id = (SELECT id FROM ledger_accounts WHERE account_code='CARD_HOLD')) ledger_hold,
        (SELECT COALESCE(SUM(locked_balance),0)::numeric FROM users WHERE id = ANY($2)) proj_locked`, [REFS, USERS])).rows[0];
    show('9b ledger  CARD_HOLD net (CR-DR)', A.ledger_hold);
    show('9b projection SUM(locked_balance)', A.proj_locked);
    const gapA = Number(A.ledger_hold) - Number(A.proj_locked);
    show('9b GAP (must be 0)', gapA);
    if (gapA !== 0) { fail('9b gap ' + gapA); ok = false; note.push('9b gap=' + gapA); }

    say('  9c IDENTITY B : CUSTOMER_WALLET net (CR-DR)  ==  SUM(wallet) - SUM(seed)');
    const B = (await pool.query(
      `SELECT
        (SELECT COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0)::numeric
           - COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric
           FROM journal_entries je
          WHERE je.reference_id = ANY($1)
            AND je.account_id = (SELECT id FROM ledger_accounts WHERE account_code='CUSTOMER_WALLET')) ledger_wallet,
        (SELECT COALESCE(SUM(wallet_balance),0)::numeric FROM users WHERE id = ANY($2)) proj_wallet`, [REFS, USERS])).rows[0];
    let seed = 0; USERS.forEach((i) => { seed += SEED.get(i); });
    show('9c ledger  CUSTOMER_WALLET net (CR-DR)', B.ledger_wallet);
    show('9c projection SUM(wallet_balance)', B.proj_wallet);
    show('9c seeded wallet total', seed);
    show('9c projection movement', Number(B.proj_wallet) - seed);
    const gapB = Number(B.ledger_wallet) - (Number(B.proj_wallet) - seed);
    show('9c GAP (must be 0)', gapB);
    if (gapB !== 0) { fail('9c gap ' + gapB); ok = false; note.push('9c gap=' + gapB); }

    say('  9d IDENTITY C (corrected SQL) : ledger entry with NO balance movement');
    const orphan = (await pool.query(
      `SELECT fo.reference_id, fo.operation_type, fo.status,
              COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric dr,
              count(*)::int lines
         FROM financial_operations fo
         JOIN journal_entries je ON je.reference_id = fo.reference_id
        WHERE fo.reference_id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM financial_audit_log fa WHERE fa.reference_id = fo.reference_id)
        GROUP BY fo.reference_id, fo.operation_type, fo.status
        ORDER BY fo.reference_id`, [REFS])).rows;
    say('     ' + (orphan.length ? orphan.map((o) => o.reference_id + '(' + o.operation_type + '/' + o.status + ',DR=' + o.dr + ')').join(', ') : '(none)'));
    show('9d orphan count (pre-fix run found 3)', orphan.length);
    if (orphan.length !== 0) { fail('9d ' + orphan.length + ' orphan(s)'); ok = false; note.push('9d=' + orphan.length); }

    say('  9e IDENTITY D : audit row with NO ledger group');
    const fa = (await pool.query(
      `SELECT fa.reference_id, count(*)::int n FROM financial_audit_log fa
        WHERE fa.reference_id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.reference_id = fa.reference_id)
        GROUP BY 1`, [REFS])).rows;
    show('9e audit-without-journal', fa.length ? JSON.stringify(fa) : '(none)');
    if (fa.length !== 0) { fail('9e false audit'); ok = false; note.push('9e'); }

    say('  9f double-entry on this scenario');
    const T9 = (await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric dr,
              COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric cr, count(*)::int n
         FROM journal_entries WHERE reference_id = ANY($1)`, [REFS])).rows[0];
    show('9f DR / CR / diff', { dr: T9.dr, cr: T9.cr, diff: Number(T9.dr) - Number(T9.cr), rows: T9.n });
    if (Number(T9.dr) - Number(T9.cr) !== 0) { fail('9f diff'); ok = false; note.push('9f'); }

    say('  9g non-negativity');
    const neg = (await pool.query(`SELECT count(*)::int n FROM users WHERE wallet_balance < 0 OR locked_balance < 0`)).rows[0].n;
    show('9g users with negative wallet/locked, whole DB', neg);
    if (neg !== 0) { fail('9g negative'); ok = false; note.push('9g'); }

    say('  9h PRE-FIX BASELINE UNCHANGED (no tampering, no data fix-up)');
    const bEnd = (await pool.query(`SELECT (SELECT count(*)::int FROM financial_operations) ops,(SELECT count(*)::int FROM journal_entries) je,(SELECT count(*)::int FROM financial_audit_log) au,(SELECT count(*)::int FROM users) us`)).rows[0];
    show('9h counts at END', bEnd);
    show('9h rows ADDED by this script (none removed)', { ops: bEnd.ops - B0.ops, je: bEnd.je - B0.je, au: bEnd.au - B0.au, us: bEnd.us - B0.us });
    const leg = (await pool.query(`SELECT COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric v, count(DISTINCT fo.reference_id)::int refs FROM journal_entries je JOIN financial_operations fo ON fo.reference_id=je.reference_id WHERE fo.status <> 'SUCCESS' AND NOT (fo.reference_id = ANY($1))`, [REFS])).rows[0];
    show('9h pre-fix residue still present (expected 2254998 across 9 refs)', leg.v + ' across ' + leg.refs + ' refs');
    if (Number(leg.v) !== 2254998 || leg.refs !== 9) { fail('9h baseline altered'); ok = false; note.push('9h'); }
    if (bEnd.ops < B0.ops || bEnd.je < B0.je || bEnd.au < B0.au) { fail('9h rows deleted'); ok = false; note.push('9h deleted'); }

    say('  9i TX224 / WD-3EC32D6D safety');
    let tx = 0;
    for (const t of ['financial_operations', 'journal_entries', 'wallet_ledger', 'financial_audit_log', 'financial_anomalies']) {
      const tc = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND data_type IN ('character varying','text','character')`, [t])).rows;
      for (const c of tc) {
        const n = (await pool.query(`SELECT count(*)::int n FROM "${t}" WHERE "${c.column_name}" ILIKE '%TX224%' OR "${c.column_name}" ILIKE '%3EC32D6D%'`)).rows[0].n;
        tx += n; if (n) say('     !! ' + t + '.' + c.column_name + ' = ' + n);
      }
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'financialEngine.js'), 'utf8');
    const lits = (src.match(/TX224|3EC32D6D/g) || []).length;
    const lens = REFS.map((r) => r.length);
    show('9i TX224 rows across all scanned tables', tx);
    show('9i TX224 literals in engine source', lits);
    show('9i references used', REFS.length + ' (length ' + Math.min(...lens) + '..' + Math.max(...lens) + ', limit 15)');
    if (tx !== 0 || lits !== 0 || Math.max(...lens) > 15) { fail('9i TX224/length'); ok = false; note.push('9i'); }
    record(9, 'Reconciliation + TX224 untouched', ok ? 'PASS' : 'FAIL', note.join('; '));
  }

  H('CORRECTED RESULTS');
  for (const n of [1, 9]) {
    const r = RESULTS[n];
    say(String(n).padStart(2) + '  ' + (r ? r.inv.padEnd(34) : 'MISSING').padEnd(36) + (r ? r.st : 'PENDING') + (r && r.note ? '   [' + r.note + ']' : ''));
  }
  say('assertion failures = ' + ERR);
  finish(0);
})().catch((e) => { say('\nSUITE ERROR ' + ((e && e.stack) || e)); finish(1); });
