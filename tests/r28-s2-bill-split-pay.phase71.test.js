#!/usr/bin/env node
'use strict';
/* R28 S2 — billSplitService.paySplit must charge a participant at most what they still owe, even
 * when two payments run at the same time (double tap, retry, two devices).
 * Before: the participant row was read outside the transaction with no lock, and amount_paid was
 * written as an absolute value computed from that stale read. Two concurrent payments therefore
 * both saw the full balance outstanding: both transferred the full amount to the creator while
 * amount_paid recorded only one payment.
 *  [1] deterministic: the first payment is paused inside its transaction (after updating the
 *      participant, before the transfer); a second payment runs meanwhile -> money moves once,
 *      the late payment is refused (nothing left to pay).
 *  [2] 4 parallel full payments -> the payer is debited exactly what was owed.
 *  [3] parallel partial payments -> amount_paid equals the sum actually transferred.
 *  [4] amount is rounded to 2 decimals before it is written (100.005 -> 100.01).
 *  [5] unchanged: a sequential overpayment is capped at what is owed; the split becomes COMPLETED;
 *      a non-participant is refused; the response shape is { success, message }.
 *  [6] deterministic: two different participants pay their last shares at the same time (the
 *      first paused inside its transaction) -> the split ends COMPLETED, not PARTIAL.
 *  [7] amount_paid is rounded: 0.70 + 0.10 on 0.80 owed (0.7999999999999999 in float) -> PAID.
 * Requires a DISPOSABLE database phase71_financial_audit_<suffix> on 127.0.0.1:55481.
 */
const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55481') {
  console.error('REFUSING: disposable r26-ci-db (127.0.0.1:55481, phase71_financial_audit_*) only'); process.exit(2);
}
const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = { post: async () => { throw new Error('net off'); }, get: async () => { throw new Error('net off'); }, create() { return this; }, defaults: { headers: { common: {} } }, interceptors: { request: { use() {} }, response: { use() {} } } };
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
// Pause hook on the pg Client prototype, installed BEFORE any client exists (db.js binds
// client.query per instance on first checkout). Matches on a query text prefix.
const pgMod = require(path.join(ROOT, 'node_modules/pg'));
const gate = { armed: false, prefix: null, released: null, onPause: null };
{
  const origProtoQuery = pgMod.Client.prototype.query;
  pgMod.Client.prototype.query = function gated(sql, ...rest) {
    const text = typeof sql === 'string' ? sql : (sql && sql.text);
    if (gate.armed && typeof text === 'string' && text.trimStart().startsWith(gate.prefix)) {
      gate.armed = false; gate.onPause();
      return gate.released.then(() => origProtoQuery.call(this, sql, ...rest));
    }
    return origProtoQuery.call(this, sql, ...rest);
  };
}
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const bs = require(path.join(ROOT, 'src/services/billSplitService'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, msg: e.message }));
let seq = 0;
async function user(label, fund = 0) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R28S2 ${label}`, `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (fund) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fin.creditWallet({ client: c, userId: u.id, amount: fund, reference: `R28S2-F-${u.id}-${Date.now()}`, description: 'fund' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return u;
}
async function split(creatorId, payerIds, owed) {
  const s = await q1(`INSERT INTO bill_splits (creator_id, title, total_amount, split_count, per_person) VALUES ($1,'r28s2',$2,$3,$4) RETURNING id`, [creatorId, owed * payerIds.length, payerIds.length, owed]);
  for (const id of payerIds) await pool.query('INSERT INTO bill_split_participants (split_id, user_id, amount_owed) VALUES ($1,$2,$3)', [s.id, id, owed]);
  return s.id;
}
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const partRow = async (sid, uid) => q1('SELECT amount_paid, status FROM bill_split_participants WHERE split_id=$1 AND user_id=$2', [sid, uid]);

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] deterministic: second payment while the first is paused inside its transaction');
  {
    const c = await user('creator1'); const p = await user('payer1', 50000); const o = await user('other1');
    const sid = await split(c.id, [p.id, o.id], 1000);
    const c0 = await walletC(c.id); const p0 = await walletC(p.id);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'INSERT INTO transactions'; gate.released = released; gate.onPause = paused; gate.armed = true;
    let a1; let a2;
    try {
      const p1 = attempt(bs.paySplit(sid, p.id, 1000));
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[1] setup: first payment paused inside its transaction', didPause);
      const p2 = attempt(bs.paySplit(sid, p.id, 1000));
      await sleep(400);
      release();
      [a1, a2] = await Promise.all([p1, p2]);
    } finally { gate.armed = false; release(); }
    const dc = (await walletC(c.id)) - c0; const dp = p0 - (await walletC(p.id));
    check('[1] creator credited 1000 once, payer debited 1000 once', dc === 100000 && dp === 100000, { credited: dc / 100, debited: dp / 100, a1, a2 });
    check('[1] first payment succeeds; late payment refused with 400', a1.ok && a1.r.success === true && !a2.ok && a2.status === 400, { a1, a2 });
    const pr = await partRow(sid, p.id);
    check('[1] participant PAID with amount_paid 1000', pr.status === 'PAID' && cents(pr.amount_paid) === 100000, pr);
  }

  console.log('\n[2] 4 parallel full payments');
  {
    const c = await user('creator2'); const p = await user('payer2', 50000); const o = await user('other2');
    const sid = await split(c.id, [p.id, o.id], 2500);
    const p0 = await walletC(p.id); const c0 = await walletC(c.id);
    const rs = await Promise.all([0, 1, 2, 3].map(() => attempt(bs.paySplit(sid, p.id, 2500))));
    const dp = p0 - (await walletC(p.id)); const dc = (await walletC(c.id)) - c0;
    check('[2] payer debited 2500 exactly once; creator credited the same', dp === 250000 && dc === 250000, { debited: dp / 100, credited: dc / 100, rs: rs.map((x) => (x.ok ? 'ok' : x.status)) });
    check('[2] exactly one payment succeeds', rs.filter((x) => x.ok).length === 1, rs.map((x) => (x.ok ? 'ok' : `${x.status}:${x.msg}`)));
  }

  console.log('\n[3] parallel partial payments');
  {
    const c = await user('creator3'); const p = await user('payer3', 50000); const o = await user('other3');
    const sid = await split(c.id, [p.id, o.id], 3000);
    const p0 = await walletC(p.id);
    const rs = await Promise.all([700, 800, 900].map((a) => attempt(bs.paySplit(sid, p.id, a))));
    const dp = p0 - (await walletC(p.id)); const pr = await partRow(sid, p.id);
    check('[3] all 3 partial payments succeed; amount_paid 2400 equals the sum debited', rs.every((x) => x.ok) && dp === 240000 && cents(pr.amount_paid) === 240000 && pr.status === 'PENDING', { debited: dp / 100, pr, rs });
  }

  console.log('\n[4] rounding to 2 decimals');
  {
    const c = await user('creator4'); const p = await user('payer4', 50000); const o = await user('other4');
    const sid = await split(c.id, [p.id, o.id], 1000);
    const c0 = await walletC(c.id);
    const a = await attempt(bs.paySplit(sid, p.id, 100.005));
    const dc = (await walletC(c.id)) - c0; const pr = await partRow(sid, p.id);
    const op = await q1(`SELECT amount FROM financial_operations WHERE reference_id = (SELECT reference_id FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 1)`, [p.id]).catch((e) => ({ err: e.message }));
    check('[4] 100.005 is charged as 100.01 everywhere (wallet, amount_paid, financial_operations); message says 100.01', a.ok && op && Number(op.amount) === 100.01 && dc === 10001 && cents(pr.amount_paid) === 10001 && /100\.01/.test(a.r.message) && !/100\.005/.test(a.r.message), { a, credited: dc / 100, pr, op });
  }

  console.log('\n[5] unchanged behaviour');
  {
    const c = await user('creator5'); const p = await user('payer5', 50000); const o = await user('other5', 50000); const x = await user('stranger5', 50000);
    const sid = await split(c.id, [p.id, o.id], 1200);
    const p0 = await walletC(p.id);
    const a = await attempt(bs.paySplit(sid, p.id, 5000));
    check('[5] overpayment capped at 1200; response { success, message }', a.ok && a.r.success === true && typeof a.r.message === 'string' && p0 - (await walletC(p.id)) === 120000, a);
    const b = await attempt(bs.paySplit(sid, o.id, 1200));
    const st = await q1('SELECT status FROM bill_splits WHERE id=$1', [sid]);
    check('[5] split COMPLETED after everyone paid', b.ok && st.status === 'COMPLETED', { b, st });
    const n = await attempt(bs.paySplit(sid, x.id, 100));
    check('[5] non-participant refused with the same message', !n.ok && n.msg === 'Huwezi kulipa split hii.', n);
    const again = await attempt(bs.paySplit(sid, p.id, 100));
    check('[5] paying again after PAID is refused with 400 and moves nothing', !again.ok && again.status === 400 && p0 - (await walletC(p.id)) === 120000, again);
  }

  console.log('\n[6] deterministic: two participants finish the split at the same time');
  {
    const c = await user('creator6'); const p = await user('payer6', 50000); const o = await user('other6', 50000);
    const sid = await split(c.id, [p.id, o.id], 600);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'INSERT INTO transactions'; gate.released = released; gate.onPause = paused; gate.armed = true;
    let a1; let a2;
    try {
      const p1 = attempt(bs.paySplit(sid, p.id, 600));
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[6] setup: first participant paused inside its transaction', didPause);
      const p2 = attempt(bs.paySplit(sid, o.id, 600));
      await sleep(400);
      release();
      [a1, a2] = await Promise.all([p1, p2]);
    } finally { gate.armed = false; release(); }
    const st = await q1('SELECT status FROM bill_splits WHERE id=$1', [sid]);
    check('[6] both payments succeed and the split is COMPLETED', a1.ok && a2.ok && st.status === 'COMPLETED', { a1, a2, st });
  }

  console.log('\n[7] amount_paid rounding (0.70 + 0.10 = 0.80 owed)');
  {
    const c = await user('creator7'); const p = await user('payer7', 1000); const o = await user('other7');
    const sid = await split(c.id, [p.id, o.id], 0.8);
    const a = await attempt(bs.paySplit(sid, p.id, 0.7));
    const b = await attempt(bs.paySplit(sid, p.id, 0.1));
    const pr = await partRow(sid, p.id);
    check('[7] participant PAID with amount_paid 0.80', a.ok && b.ok && pr.status === 'PAID' && pr.amount_paid === '0.80', { a, b, pr });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
