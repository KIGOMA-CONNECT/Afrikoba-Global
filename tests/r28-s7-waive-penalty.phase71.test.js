#!/usr/bin/env node
'use strict';
/* R28 S7 — vicobaService.waivePenalty must never record a PAID penalty as WAIVED.
 * Before: the penalty was read without a lock and the WAIVED update was unconditional. A waive
 * racing the member's payPenalty (which locks the row) read UNPAID, waited for the payment to
 * commit, then overwrote PAID with WAIVED: the member was charged but the record says waived.
 *  [1] deterministic: payPenalty is paused inside its transaction (holding the row lock, before
 *      marking PAID); an officer waives meanwhile -> the waive gets the existing 400, the penalty
 *      stays PAID and the member was charged once.
 *  [2] unchanged: waive an UNPAID penalty -> WAIVED with waived_by; waive a PAID one -> 400;
 *      a non-officer -> 403; response shape { success, message }.
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
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, msg: e.message }));
let seq = 0;
async function user(label, fund = 0) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R28S7 ${label}`, `2559${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (fund) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fin.creditWallet({ client: c, userId: u.id, amount: fund, reference: `R28S7-F-${u.id}-${Date.now()}`, description: 'fund' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return u;
}
async function group() {
  const chair = await user('chair'); const member = await user('member', 20000); const plain = await user('plain');
  const g = await q1(`INSERT INTO vicoba_groups (group_name, share_value) VALUES ($1, 1000) RETURNING id`, [`R28S7 g${++seq}`]);
  await pool.query(`INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1,$2,'MWENYEKITI'),($1,$3,'MWANACHAMA'),($1,$4,'MWANACHAMA')`, [g.id, chair.id, member.id, plain.id]);
  return { g: g.id, chair, member, plain };
}
const penalty = async (g, uid, amount) => (await q1(`INSERT INTO vicoba_penalties (group_id, user_id, penalty_type, amount, reason) VALUES ($1,$2,'LATE_CONTRIBUTION',$3,'r28s7') RETURNING id`, [g, uid, amount])).id;
const prow = async (id) => q1('SELECT status, waived_by, paid_at FROM vicoba_penalties WHERE id=$1', [id]);
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const PAID_MSG = 'Faini tayari imelipwa, haiwezi kuondolewa.';

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] deterministic: waive while the member\'s payment is in progress');
  {
    const { g, chair, member } = await group();
    const pid = await penalty(g, member.id, 1500);
    const w0 = await walletC(member.id);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = "UPDATE vicoba_penalties SET status = 'PAID'"; gate.released = released; gate.onPause = paused; gate.armed = true;
    let pay; let waive;
    try {
      const pPay = attempt(vicoba.payPenalty(member.id, pid));
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[1] setup: payment paused inside its transaction', didPause);
      const pWaive = attempt(vicoba.waivePenalty(chair.id, pid));
      await sleep(400);
      release();
      [pay, waive] = await Promise.all([pPay, pWaive]);
    } finally { gate.armed = false; release(); }
    const row = await prow(pid); const dw = w0 - (await walletC(member.id));
    check('[1] payment succeeds; waive refused with the existing 400', pay.ok && !waive.ok && waive.status === 400 && waive.msg === PAID_MSG, { pay, waive });
    check('[1] penalty stays PAID (not WAIVED), waived_by empty; member charged 1500 once', row.status === 'PAID' && row.waived_by === null && dw === 150000, { row, debited: dw / 100 });
  }

  console.log('\n[2] unchanged behaviour');
  {
    const { g, chair, member, plain } = await group();
    const p1 = await penalty(g, member.id, 700);
    const n = await attempt(vicoba.waivePenalty(plain.id, p1));
    check('[2] non-officer -> 403', !n.ok && n.status === 403, n);
    const a = await attempt(vicoba.waivePenalty(chair.id, p1));
    const r1 = await prow(p1);
    check('[2] waive UNPAID -> { success, message }, WAIVED, waived_by = officer', a.ok && a.r.success === true && typeof a.r.message === 'string' && r1.status === 'WAIVED' && r1.waived_by === chair.id, { a, r1 });
    const p2 = await penalty(g, member.id, 800);
    await vicoba.payPenalty(member.id, p2);
    const b = await attempt(vicoba.waivePenalty(chair.id, p2));
    check('[2] waive PAID -> 400 with the existing message; stays PAID', !b.ok && b.status === 400 && b.msg === PAID_MSG && (await prow(p2)).status === 'PAID', b);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
