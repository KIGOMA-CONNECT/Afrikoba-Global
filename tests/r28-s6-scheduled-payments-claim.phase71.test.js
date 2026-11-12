#!/usr/bin/env node
'use strict';
/* R28 S6 — networkService.processDueScheduledPayments must execute each due scheduled payment
 * once per occurrence even when two runs overlap (cron job + admin POST /network/scheduled/process,
 * or two app instances each running the job).
 * Before: due rows were listed without any claim and advanced (next occurrence / COMPLETED) only
 * after the transfer, unconditionally, so every overlapping run executed every due payment.
 *  [1] deterministic: the first run is paused at its first scheduled_payments update; a second
 *      run executes meanwhile -> the payment is transferred once.
 *  [2] 4 overlapping runs over 2 ONCE + 1 DAILY due payments -> each transferred once; ONCE rows
 *      COMPLETED. The DAILY row is NOT rescheduled: the pre-existing reschedule UPDATE fails
 *      (42P08, next_execution DATE and scheduled_for TIMESTAMPTZ share $1) and the row is marked
 *      FAILED after its transfer. That is unchanged here (owner decision S6-OD: fixing it turns
 *      recurring debits on); the test only requires that it is transferred once.
 *  [3] unchanged: a failing transfer marks the row FAILED; not-due and CANCELLED rows untouched;
 *      result shape { processed }.
 *  [4] a transfer slower than idle_in_transaction_session_timeout (8s; slow SMS) with a second
 *      run meanwhile -> transferred once, no transaction held across the transfer.
 *  [5] deterministic, recurring: a DAILY row is claimed and its transfer is slow (SMS); a second
 *      run lists the row AFTER that claim (still ACTIVE and due) -> it must not claim the same
 *      occurrence again.
 *  [6] deterministic: the owner cancels a DAILY payment after the run listed it but before the
 *      run claims it -> nothing is transferred and the row stays CANCELLED.
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
const smsMod = require(path.join(ROOT, 'src/services/smsService'));
let slowSms = 0;
{
  const origSms = smsMod.sendSMS;
  smsMod.sendSMS = async (...a) => { if (slowSms > 0) { slowSms--; await new Promise((r) => setTimeout(r, 9000)); } return origSms(...a); };
}
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const net = require(path.join(ROOT, 'src/services/networkService'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, msg: e.message }));
let seq = 0;
async function user(label, fund = 0) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id, phone_number', [`R28S6 ${label}`, `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (fund) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fin.creditWallet({ client: c, userId: u.id, amount: fund, reference: `R28S6-F-${u.id}-${Date.now()}`, description: 'fund' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return u;
}
// scheduled_for with microseconds (NOW() - interval) like rows written by the app.
async function sched(userId, phone, amount, recurrence, { dueMinutes = 5, status = 'ACTIVE' } = {}) {
  return (await q1(`INSERT INTO scheduled_payments (user_id, recipient_phone, amount, type, description, scheduled_for, recurrence, status)
    VALUES ($1,$2,$3,'TRANSFER','r28s6', NOW() - make_interval(mins => $4), $5, $6) RETURNING id`, [userId, phone, amount, dueMinutes, recurrence, status])).id;
}
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const row = async (id) => q1('SELECT status, scheduled_for, last_executed FROM scheduled_payments WHERE id=$1', [id]);
// Isolate: retire due rows left by earlier sections so each section sees only its own rows.
const retireOthers = async () => pool.query("UPDATE scheduled_payments SET status = 'CANCELLED' WHERE status = 'ACTIVE' AND description = 'r28s6'");

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] deterministic: second run while the first is paused at its update');
  {
    const s = await user('s1', 50000); const r = await user('r1');
    const sid = await sched(s.id, r.phone_number, 1000, 'ONCE');
    const r0 = await walletC(r.id);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'UPDATE scheduled_payments SET last_executed'; gate.released = released; gate.onPause = paused; gate.armed = true;
    let a1; let a2;
    try {
      const p1 = attempt(net.processDueScheduledPayments());
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[1] setup: first run paused at its scheduled_payments update', didPause);
      a2 = await attempt(net.processDueScheduledPayments());
      release();
      a1 = await p1;
    } finally { gate.armed = false; release(); }
    const dr = (await walletC(r.id)) - r0; const rw = await row(sid);
    check('[1] recipient credited 1000 once; row COMPLETED; runs report 1 processed in total', dr === 100000 && rw.status === 'COMPLETED' && a1.ok && a2.ok && a1.r.processed + a2.r.processed === 1, { credited: dr / 100, rw, a1, a2 });
  }

  console.log('\n[2] 4 overlapping runs over 3 due payments');
  {
    await retireOthers();
    const s = await user('s2', 50000); const r = await user('r2');
    const o1 = await sched(s.id, r.phone_number, 1000, 'ONCE'); const o2 = await sched(s.id, r.phone_number, 2000, 'ONCE');
    const d1 = await sched(s.id, r.phone_number, 3000, 'DAILY', { dueMinutes: 60 });
    const before = await row(d1);
    const r0 = await walletC(r.id);
    const rs = await Promise.all([0, 1, 2, 3].map(() => attempt(net.processDueScheduledPayments())));
    const dr = (await walletC(r.id)) - r0;
    const sum = rs.filter((x) => x.ok).reduce((a, x) => a + x.r.processed, 0);
    const a = await row(o1); const b = await row(o2); const d = await row(d1);
    const advancedMs = new Date(d.scheduled_for) - new Date(before.scheduled_for);
    check('[2] recipient credited 6000 once in total; processed sums to 2 (ONCE rows; DAILY reported failed, S6-OD)', dr === 600000 && sum === 2, { credited: dr / 100, rs: rs.map((x) => (x.ok ? x.r.processed : x.msg)) });
    check('[2] ONCE rows COMPLETED; DAILY row no longer ACTIVE-and-due', a.status === 'COMPLETED' && b.status === 'COMPLETED' && d.status !== 'ACTIVE' && d.last_executed !== null, { a, b, d, advancedMs });
    const again = await attempt(net.processDueScheduledPayments());
    check('[2] a later run transfers nothing more', again.ok && again.r.processed === 0 && (await walletC(r.id)) - r0 === 600000, again);
  }

  console.log('\n[3] unchanged behaviour');
  {
    await retireOthers();
    const s = await user('s3', 50000); const r = await user('r3');
    const bad = await sched(s.id, '255799999998', 500, 'ONCE');
    const notDue = await sched(s.id, r.phone_number, 700, 'ONCE', { dueMinutes: -60 });
    const cancelled = await sched(s.id, r.phone_number, 800, 'ONCE', { status: 'CANCELLED' });
    const r0 = await walletC(r.id);
    const a = await attempt(net.processDueScheduledPayments());
    check('[3] result shape { processed }; failing transfer not counted', a.ok && Object.keys(a.r).join() === 'processed' && a.r.processed === 0, a);
    const b = await row(bad); const n = await row(notDue); const c = await row(cancelled);
    check('[3] failing transfer -> FAILED; not-due stays ACTIVE; CANCELLED untouched; no money moved', b.status === 'FAILED' && n.status === 'ACTIVE' && n.last_executed === null && c.status === 'CANCELLED' && (await walletC(r.id)) === r0, { b, n, c });
    await pool.query("UPDATE scheduled_payments SET status = 'CANCELLED' WHERE id = $1", [notDue]);
  }

  console.log('\n[4] slow transfer (> 8s idle-in-transaction timeout) with a second run meanwhile');
  {
    await retireOthers();
    const s = await user('s4', 50000); const r = await user('r4');
    const sid = await sched(s.id, r.phone_number, 1100, 'ONCE');
    const r0 = await walletC(r.id);
    slowSms = 1;
    const pA = attempt(net.processDueScheduledPayments());
    await sleep(1500);
    const b = await attempt(net.processDueScheduledPayments());
    const a = await pA;
    slowSms = 0;
    const dr = (await walletC(r.id)) - r0; const rw = await row(sid);
    check('[4] second run processes nothing; first processes 1; COMPLETED; recipient +1100 once', b.ok && b.r.processed === 0 && a.ok && a.r.processed === 1 && rw.status === 'COMPLETED' && dr === 110000, { a, b, rw, credited: dr / 100 });
  }

  console.log('\n[5] recurring: a run that lists the row after another run claimed it');
  {
    await retireOthers();
    const s = await user('s5', 50000); const r = await user('r5');
    const sid = await sched(s.id, r.phone_number, 1300, 'DAILY', { dueMinutes: 60 });
    const r0 = await walletC(r.id);
    slowSms = 1;
    const pA = attempt(net.processDueScheduledPayments());
    await sleep(1500);
    const mid = await row(sid);
    const b = await attempt(net.processDueScheduledPayments());
    const a = await pA;
    slowSms = 0;
    const dr = (await walletC(r.id)) - r0;
    check('[5] setup: row claimed (last_executed set) and still ACTIVE when the second run lists it', mid.status === 'ACTIVE' && mid.last_executed !== null, mid);
    check('[5] second run processes nothing; recipient +1300 once', b.ok && b.r.processed === 0 && dr === 130000, { a, b, credited: dr / 100, row: await row(sid) });
  }

  console.log('\n[6] recurring payment cancelled between listing and claim');
  {
    await retireOthers();
    const s = await user('s6', 50000); const r = await user('r6');
    const sid = await sched(s.id, r.phone_number, 1400, 'DAILY', { dueMinutes: 60 });
    const r0 = await walletC(r.id);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'UPDATE scheduled_payments SET last_executed = NOW() WHERE id'; gate.released = released; gate.onPause = paused; gate.armed = true;
    let a; let c;
    try {
      const pA = attempt(net.processDueScheduledPayments());
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[6] setup: run paused at its claim', didPause);
      c = await attempt(net.cancelScheduledPayment(sid, s.id));
      release();
      a = await pA;
    } finally { gate.armed = false; release(); }
    const dr = (await walletC(r.id)) - r0; const rw = await row(sid);
    check('[6] cancelled meanwhile -> nothing transferred, row CANCELLED, processed 0', c.ok && a.ok && a.r.processed === 0 && dr === 0 && rw.status === 'CANCELLED', { c, a, credited: dr / 100, rw });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
