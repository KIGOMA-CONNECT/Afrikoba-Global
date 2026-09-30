'use strict';
/** Focused re-test of TEST #1 (Hold conditional-atomic guard).
 *  The first attempt used an over-funded race (2 x 80000 vs 70000 available) so
 *  BOTH sides legitimately failed the pre-check -> "0 winners" proved nothing about
 *  the conditional effect guard. Here each claim is individually affordable but
 *  the pair is not, so the guard is the only thing that can stop the second one.
 *  Deadlock (40P01) is retried because a deadlock is a transient, safe failure.
 */
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'zz_out_t1r.txt');
const buf = [];
const say = (s) => buf.push(s === undefined ? 'undefined' : String(s));
const H = (s) => say('\n########## ' + s + ' ##########');
function finish(c) { try { fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8'); } catch (e) {} process.exit(c || 0); }
process.on('unhandledRejection', (e) => { say('FATAL ' + ((e && e.stack) || e)); finish(9); });

const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const engine = require(path.join(__dirname, '..', 'src', 'services', 'financialEngine'));
const NONCE = Date.now().toString(36).toUpperCase().slice(-6);
let SEQ = 0;
const ref = (t) => ('L' + t + NONCE).toUpperCase().slice(0, 15);
const snap = async (id) => { const r = await pool.query(`SELECT wallet_balance, locked_balance FROM users WHERE id=$1`, [id]); return { wallet: Number(r.rows[0].wallet_balance), locked: Number(r.rows[0].locked_balance) }; };
const opRow = async (r) => (await pool.query(`SELECT id, operation_type, reference_id, status, amount, last_error FROM financial_operations WHERE reference_id=$1`, [r])).rows[0] || null;
const jRows = async (r) => (await pool.query(`SELECT je.id, la.account_code, je.direction, je.amount FROM journal_entries je JOIN ledger_accounts la ON la.id=je.account_id WHERE je.reference_id=$1 ORDER BY je.id`, [r])).rows;
const show = (t, o) => say('  ' + t + ' = ' + (typeof o === 'object' ? JSON.stringify(o) : o));

async function newUser(tag, wallet, locked) {
  SEQ += 1;
  const phone = '07' + String(Date.now()).slice(-7) + String(SEQ).padStart(2, '0');
  return (await pool.query(
    `INSERT INTO users (full_name, phone_number, wallet_balance, locked_balance) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['ZZ Live Regression ' + tag, phone, wallet, locked])).rows[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDeadlock = (e) => e && /deadlock|40P01/i.test(e.message + ' ' + (e.code || ''));

(async () => {
  say('TEST #1R focused re-test nonce=' + NONCE);

  // ---------- A : concurrent lockWallet, each claim affordable, pair is not ----------
  H('#1R-A  lockWallet race: 2 x 50000 against 70000 available');
  {
    const u = await newUser('T1RA', 70000, 0);
    show('A user', { id: u.id });
    const before = await snap(u.id);
    show('A state BEFORE', before);
    const rA = ref('1RA'), rB = ref('1RB');
    show('A refs', { a: rA, b: rB });
    show('A each claim 50000 <= 70000 available, but 2 x 50000 = 100000 > 70000');
    const attempt = async (rf, label) => {
      for (let i = 1; i <= 4; i++) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await engine.lockWallet({ client: c, userId: u.id, amount: 50000, reference: rf });
          await c.query('COMMIT');
          return { label, outcome: 'SUCCESS', attempt: i, result: r };
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          if (isDeadlock(e) && i < 4) { say('  A ' + label + ' attempt ' + i + ' -> deadlock, retrying'); await sleep(150); continue; }
          return { label, outcome: 'REJECTED', attempt: i, error: e.message };
        } finally { c.release(); }
      }
      return { label, outcome: 'GAVE_UP' };
    };
    const [ra, rb] = await Promise.all([attempt(rA, 'A'), attempt(rB, 'B')]);
    show('A execution A', ra);
    show('A execution B', rb);
    const after = await snap(u.id);
    show('A state AFTER', after);
    show('A op row A', await opRow(rA));
    show('A op row B', await opRow(rB));
    show('A journal A', await jRows(rA));
    show('A journal B', await jRows(rB));
    const winners = [ra, rb].filter((x) => x.outcome === 'SUCCESS').length;
    show('A WINNERS (expect exactly 1)', winners);
    show('A total funds before -> after', (before.wallet + before.locked) + ' -> ' + (after.wallet + after.locked));
    const ok = winners === 1
      && after.wallet === 20000 && after.locked === 50000
      && (after.wallet + after.locked) === before.wallet + before.locked
      && after.wallet >= 0 && after.locked >= 0
      && (await jRows(rA)).length === 2 && (await jRows(rB)).length === 0;
    say('  >> #1R-A VERDICT = ' + (ok ? 'PASS' : 'FAIL') + '  (exactly one claim honoured, second blocked by conditional guard, funds conserved)');
    if (!ok) say('  !! #1R-A assertion mismatch');
  }

  // ---------- B : concurrent holdFunds (public API, own transaction) ----------
  H('#1R-B  holdFunds race: 2 x 50000 against 70000 available');
  {
    const u = await newUser('T1RB', 70000, 0);
    show('B user', { id: u.id });
    const before = await snap(u.id);
    show('B state BEFORE', before);
    const rA = ref('1RC'), rB = ref('1RD');
    const attempt = async (rf, label) => {
      for (let i = 1; i <= 4; i++) {
        try { return { label, outcome: 'SUCCESS', attempt: i, result: await engine.holdFunds({ userId: u.id, amount: 50000, reference: rf }) }; }
        catch (e) {
          if (isDeadlock(e) && i < 4) { say('  B ' + label + ' attempt ' + i + ' -> deadlock, retrying'); await sleep(150); continue; }
          return { label, outcome: 'REJECTED', attempt: i, error: e.message };
        }
      }
      return { label, outcome: 'GAVE_UP' };
    };
    const [ra, rb] = await Promise.all([attempt(rA, 'A'), attempt(rB, 'B')]);
    show('B execution A', ra);
    show('B execution B', rb);
    const after = await snap(u.id);
    show('B state AFTER', after);
    show('B op row A', await opRow(rA));
    show('B op row B', await opRow(rB));
    show('B journal A', await jRows(rA));
    show('B journal B', await jRows(rB));
    const winners = [ra, rb].filter((x) => x.outcome === 'SUCCESS').length;
    show('B WINNERS (expect exactly 1)', winners);
    show('B total funds before -> after', (before.wallet + before.locked) + ' -> ' + (after.wallet + after.locked));
    const ok = winners === 1
      && (after.wallet + after.locked) === before.wallet + before.locked
      && after.wallet >= 0 && after.locked >= 0
      && (await jRows(rA)).length === 2 && (await jRows(rB)).length === 0;
    say('  >> #1R-B VERDICT = ' + (ok ? 'PASS' : 'FAIL'));
    if (!ok) say('  !! #1R-B assertion mismatch');
  }

  // ---------- C : sequential second claim on the same wallet (no race) ----------
  H('#1R-C  sequential: single affordable lock, then an unaffordable one');
  {
    const u = await newUser('T1RC', 40000, 0);
    show('C user', { id: u.id });
    const before = await snap(u.id);
    show('C state BEFORE', before);
    const r1 = ref('1RE'), r2 = ref('1RF');
    const c1 = await pool.connect();
    await c1.query('BEGIN');
    const res1 = await engine.lockWallet({ client: c1, userId: u.id, amount: 40000, reference: r1 });
    await c1.query('COMMIT'); c1.release();
    show('C lock 1 (40000 of 40000) result', res1);
    show('C state after lock 1', await snap(u.id));
    show('C op row 1', await opRow(r1));
    let res2 = null, err2 = null;
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      res2 = await engine.lockWallet({ client: c2, userId: u.id, amount: 1, reference: r2 });
      await c2.query('COMMIT'); c2.release();
    } catch (e) { err2 = e.message; await c2.query('ROLLBACK').catch(() => {}); c2.release(); }
    show('C lock 2 (1 with 0 available) result', res2);
    show('C lock 2 error', err2);
    const after = await snap(u.id);
    show('C state AFTER', after);
    show('C op row 2 (rolled back -> must be null)', await opRow(r2));
    show('C journal 2 (must be empty)', await jRows(r2));
    const ok = after.wallet === 0 && after.locked === 40000
      && !!err2 && !(await opRow(r2)) && (await jRows(r2)).length === 0;
    say('  >> #1R-C VERDICT = ' + (ok ? 'PASS' : 'FAIL'));
    if (!ok) say('  !! #1R-C assertion mismatch');
  }

  say('\nFOCUSED RE-TEST COMPLETE');
  finish(0);
})().catch((e) => { say('SUITE ERROR ' + ((e && e.stack) || e)); finish(1); });
