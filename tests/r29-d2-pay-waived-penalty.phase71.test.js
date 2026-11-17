#!/usr/bin/env node
'use strict';
/* R29 D2 (owner decision) — vicobaService.payPenalty must refuse a WAIVED penalty and never
 * overwrite WAIVED with PAID. Before: payPenalty refused nothing but PAID (idempotent), so a
 * member could pay a penalty an officer had already waived, and a payment queued behind a waive
 * charged the wallet and rewrote WAIVED as PAID.
 *  [1] pay a WAIVED penalty -> 409 PENALTY_WAIVED; stays WAIVED; wallet and transactions untouched.
 *  [2] deterministic race: waivePenalty is paused before its COMMIT (holding the row lock, row
 *      already WAIVED in its tx); payPenalty runs meanwhile and waits on FOR UPDATE -> after the
 *      waive commits, the payment gets 409 PENALTY_WAIVED, nothing is charged, row stays WAIVED.
 *  [3] unchanged: pay UNPAID -> success/PAID/charged once; pay again -> idempotent success with
 *      no second charge; someone else's penalty -> 404.
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
const vicoba = require(path.join(ROOT, 'src/services/vicobaService'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, code: e.code, msg: e.message }));
let seq = 0;
async function user(label, fund = 0) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R29D2 ${label}`, `2559${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (fund) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fin.creditWallet({ client: c, userId: u.id, amount: fund, reference: `R29D2-F-${u.id}-${Date.now()}`, description: 'fund' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return u;
}
async function group() {
  const chair = await user('chair'); const member = await user('member', 20000); const plain = await user('plain');
  const g = await q1(`INSERT INTO vicoba_groups (group_name, share_value) VALUES ($1, 1000) RETURNING id`, [`R29D2 g${++seq}`]);
  await pool.query(`INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1,$2,'MWENYEKITI'),($1,$3,'MWANACHAMA'),($1,$4,'MWANACHAMA')`, [g.id, chair.id, member.id, plain.id]);
  return { g: g.id, chair, member, plain };
}
const penalty = async (g, uid, amount) => (await q1(`INSERT INTO vicoba_penalties (group_id, user_id, penalty_type, amount, reason) VALUES ($1,$2,'LATE_CONTRIBUTION',$3,'r29d2') RETURNING id`, [g, uid, amount])).id;
const prow = async (id) => q1('SELECT status, waived_by, paid_at FROM vicoba_penalties WHERE id=$1', [id]);
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);

const txCount = async (pid) => Number((await q1("SELECT count(*) n FROM transactions WHERE type='VICOBA_PENALTY' AND meta->>'penalty_id' = $1", [String(pid)])).n);
const refused = (x) => !x.ok && x.status === 409 && x.code === 'PENALTY_WAIVED' && typeof x.msg === 'string' && x.msg.length > 0;

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] paying a penalty that is already WAIVED');
  {
    const { g, chair, member } = await group();
    const pid = await penalty(g, member.id, 1200);
    await vicoba.waivePenalty(chair.id, pid);
    const w0 = await walletC(member.id);
    const r = await attempt(vicoba.payPenalty(member.id, pid));
    const row = await prow(pid);
    check('[1] refused with 409 PENALTY_WAIVED', refused(r), r);
    check('[1] stays WAIVED (waived_by kept, paid_at null); wallet unchanged; no penalty transaction', row.status === 'WAIVED' && row.waived_by === chair.id && row.paid_at === null && (await walletC(member.id)) === w0 && (await txCount(pid)) === 0, { row });
    // The WAIVED refusal is decided before any debit: a member with no balance gets 409, not an
    // insufficient-funds error from the wallet.
    const pid2 = await penalty(g, chair.id, 500);
    await vicoba.waivePenalty(chair.id, pid2);
    const r2 = await attempt(vicoba.payPenalty(chair.id, pid2));
    check('[1] zero-balance member paying a WAIVED penalty -> 409 PENALTY_WAIVED (not a funds error)', refused(r2) && (await prow(pid2)).status === 'WAIVED', r2);
  }

  console.log('\n[2] deterministic: payment arrives while the waive holds the row lock');
  {
    const { g, chair, member } = await group();
    const pid = await penalty(g, member.id, 1500);
    const w0 = await walletC(member.id);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'COMMIT'; gate.released = released; gate.onPause = paused; gate.armed = true;
    let pay; let waive;
    try {
      const pWaive = attempt(vicoba.waivePenalty(chair.id, pid));
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[2] setup: waive paused before COMMIT', didPause);
      const pPay = attempt(vicoba.payPenalty(member.id, pid));
      await sleep(400);
      release();
      [waive, pay] = await Promise.all([pWaive, pPay]);
    } finally { gate.armed = false; release(); }
    const row = await prow(pid);
    check('[2] waive succeeds; payment refused with 409 PENALTY_WAIVED', waive.ok && refused(pay), { waive, pay });
    check('[2] row stays WAIVED, paid_at null; member not charged; no penalty transaction', row.status === 'WAIVED' && row.paid_at === null && (await walletC(member.id)) === w0 && (await txCount(pid)) === 0, { row, debited: (w0 - (await walletC(member.id))) / 100 });
  }

  console.log('\n[2b] same race, member has no balance: the WAIVED decision is taken under the lock');
  {
    const { g, chair } = await group();
    const pid = await penalty(g, chair.id, 700);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'COMMIT'; gate.released = released; gate.onPause = paused; gate.armed = true;
    let pay; let waive;
    try {
      const pWaive = attempt(vicoba.waivePenalty(chair.id, pid));
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[2b] setup: waive paused before COMMIT', didPause);
      const pPay = attempt(vicoba.payPenalty(chair.id, pid));
      await sleep(400);
      release();
      [waive, pay] = await Promise.all([pWaive, pPay]);
    } finally { gate.armed = false; release(); }
    check('[2b] waive succeeds; payment 409 PENALTY_WAIVED (not a funds error); row WAIVED', waive.ok && refused(pay) && (await prow(pid)).status === 'WAIVED', { waive, pay });
  }

  console.log('\n[3] unchanged behaviour');
  {
    const { g, member, plain } = await group();
    const pid = await penalty(g, member.id, 900);
    const w0 = await walletC(member.id);
    const a = await attempt(vicoba.payPenalty(member.id, pid));
    const row = await prow(pid);
    check('[3] pay UNPAID -> success, PAID, charged 900 once', a.ok && a.r.success === true && row.status === 'PAID' && row.paid_at !== null && w0 - (await walletC(member.id)) === 90000 && (await txCount(pid)) === 1, { a, row });
    const b = await attempt(vicoba.payPenalty(member.id, pid));
    check('[3] pay again -> idempotent success, no second charge', b.ok && b.r.success === true && w0 - (await walletC(member.id)) === 90000 && (await txCount(pid)) === 1, b);
    const c = await attempt(vicoba.payPenalty(plain.id, pid));
    check('[3] another user -> 404', !c.ok && c.status === 404, c);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
