#!/usr/bin/env node
'use strict';
/* R28 S5 — familyService.syncOfflineOps must execute each QUEUED offline operation at most once
 * per queue entry even when two syncs run at the same time (two devices, a double tap, a retry).
 * Before: the QUEUED list was read without any claim, so every concurrent sync executed every op
 * (TRANSFER -> transferWallet twice: sender debited twice, recipient credited twice).
 *  [1] deterministic: the first sync is paused after its transfer, just before marking the op
 *      PROCESSED; a second sync runs meanwhile -> the transfer happens once, op PROCESSED once.
 *  [2] 5 parallel syncs over 3 queued TRANSFER ops -> each op executed exactly once.
 *  [3] unchanged: an op that fails is marked FAILED with error_message; counts and response shape.
 *  [4] unchanged: a single sync processes QUEUED ops in order and skips already PROCESSED ones.
 *  [5] deterministic: a sync that listed an op earlier but claims it only after another sync has
 *      finished it skips it (the claim re-checks QUEUED).
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
    if (gate.armed && typeof text === 'string' && text.startsWith(gate.prefix)) {
      gate.armed = false; gate.onPause();
      return gate.released.then(() => origProtoQuery.call(this, sql, ...rest));
    }
    return origProtoQuery.call(this, sql, ...rest);
  };
}
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const family = require(path.join(ROOT, 'src/services/familyService'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, msg: e.message }));
let seq = 0;
async function user(label, fund = 0) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id, phone_number', [`R28S5 ${label}`, `2555${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (fund) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fin.creditWallet({ client: c, userId: u.id, amount: fund, reference: `R28S5-F-${u.id}-${Date.now()}`, description: 'fund' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return u;
}
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const opRow = async (id) => q1('SELECT status, error_message FROM offline_operations WHERE id=$1', [id]);

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] deterministic: second sync while the first is paused before marking PROCESSED');
  {
    const s = await user('sender1', 50000); const r = await user('recipient1');
    const op = await family.queueOfflineOp(s.id, 'TRANSFER', { toPhone: r.phone_number, amount: 1000, note: 'r28s5' });
    const r0 = await walletC(r.id);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'UPDATE offline_operations SET status = \'PROCESSED\'';
    gate.released = released; gate.onPause = paused; gate.armed = true;
    let a1; let a2;
    try {
      const p1 = attempt(family.syncOfflineOps(s.id));
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[1] setup: first sync paused after its transfer', didPause);
      a2 = await attempt(family.syncOfflineOps(s.id));
      release();
      a1 = await p1;
    } finally { gate.armed = false; release(); }
    const dr = (await walletC(r.id)) - r0;
    check('[1] recipient credited 1000 once', dr === 100000, { credited: dr / 100, a1, a2 });
    check('[1] op PROCESSED; one sync reports it processed, the other reports nothing', (await opRow(op.id)).status === 'PROCESSED' && a1.ok && a2.ok && a1.r.processed + a2.r.processed === 1 && a1.r.failed + a2.r.failed === 0, { a1, a2, row: await opRow(op.id) });
  }

  console.log('\n[2] 5 parallel syncs over 3 queued transfers');
  {
    const s = await user('sender2', 50000); const r = await user('recipient2');
    const ops = [];
    for (const amt of [1000, 2000, 3000]) ops.push(await family.queueOfflineOp(s.id, 'TRANSFER', { toPhone: r.phone_number, amount: amt }));
    const r0 = await walletC(r.id);
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => attempt(family.syncOfflineOps(s.id))));
    const dr = (await walletC(r.id)) - r0;
    const sum = rs.filter((x) => x.ok).reduce((a, x) => a + x.r.processed, 0);
    check('[2] recipient credited 6000 exactly once in total', dr === 600000, { credited: dr / 100 });
    check('[2] all ops PROCESSED, processed counts sum to 3', sum === 3 && (await Promise.all(ops.map((o) => opRow(o.id)))).every((x) => x.status === 'PROCESSED'), { sum, rs: rs.map((x) => (x.ok ? x.r.processed : x.status)) });
  }

  console.log('\n[3] failing op (unchanged)');
  {
    const s = await user('sender3', 1000);
    const bad = await family.queueOfflineOp(s.id, 'TRANSFER', { toPhone: '255799999999', amount: 500 });
    const unknown = await family.queueOfflineOp(s.id, 'TELEPORT', { x: 1 });
    const a = await attempt(family.syncOfflineOps(s.id));
    check('[3] response shape {processed, failed, message}; 0 processed, 2 failed', a.ok && a.r.processed === 0 && a.r.failed === 2 && typeof a.r.message === 'string', a);
    const b1 = await opRow(bad.id); const b2 = await opRow(unknown.id);
    check('[3] both FAILED with error_message', b1.status === 'FAILED' && b2.status === 'FAILED' && b1.error_message && b2.error_message, { b1, b2 });
  }

  console.log('\n[4] sequential sync (unchanged)');
  {
    const s = await user('sender4', 50000); const r = await user('recipient4');
    await family.queueOfflineOp(s.id, 'TRANSFER', { toPhone: r.phone_number, amount: 700 });
    const r0 = await walletC(r.id);
    const a = await attempt(family.syncOfflineOps(s.id));
    const b = await attempt(family.syncOfflineOps(s.id));
    check('[4] first sync processes 1; second processes 0; recipient +700 once', a.ok && a.r.processed === 1 && b.ok && b.r.processed === 0 && (await walletC(r.id)) - r0 === 70000, { a, b });
  }

  console.log('\n[5] deterministic: a sync that listed the op earlier claims it only after another sync finished it');
  {
    const s = await user('sender5', 50000); const r = await user('recipient5');
    const op = await family.queueOfflineOp(s.id, 'TRANSFER', { toPhone: r.phone_number, amount: 900 });
    const r0 = await walletC(r.id);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'SELECT id FROM offline_operations WHERE id = $1';
    gate.released = released; gate.onPause = paused; gate.armed = true;
    let aLate; let aFirst;
    try {
      const pLate = attempt(family.syncOfflineOps(s.id)); // lists the op, then pauses at its claim
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[5] setup: late sync paused at its claim', didPause);
      aFirst = await attempt(family.syncOfflineOps(s.id)); // runs to completion meanwhile
      release();
      aLate = await pLate;
    } finally { gate.armed = false; release(); }
    const dr = (await walletC(r.id)) - r0;
    check('[5] recipient credited 900 once; the late sync skips the finished op', dr === 90000 && aFirst.ok && aFirst.r.processed === 1 && aLate.ok && aLate.r.processed === 0, { credited: dr / 100, aFirst, aLate, row: await opRow(op.id) });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
