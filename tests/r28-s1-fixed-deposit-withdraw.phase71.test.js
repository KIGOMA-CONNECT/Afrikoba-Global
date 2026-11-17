#!/usr/bin/env node
'use strict';
/* R28 S1 — savingsCreditService.withdrawFixedDeposit must pay out and record a fixed deposit
 * withdrawal once, even when two withdrawals of the same deposit run at the same time.
 * Before: the deposit was read (status ACTIVE) outside the transaction with no lock and the
 * status UPDATE was unconditional. A second concurrent withdrawal waited for the first, then
 * overwrote the status, wrote a second set of FIXED_DEPOSIT / PENALTY / INTEREST transactions
 * rows and answered success with a payout; only the idempotent credit reference SCFD:<id>:WITH
 * kept the wallet from being credited twice.
 *  [1] deterministic: the first withdrawal is paused inside its transaction; a second runs
 *      meanwhile -> the second gets the existing 404, one set of transactions rows, one credit.
 *  [2] 4 parallel early withdrawals -> exactly one succeeds, one credit, one row set.
 *  [3] 4 parallel matured withdrawals -> exactly one succeeds, interest row written once.
 *  [4] unchanged: not matured without allow_early -> 400 and stays ACTIVE; another user's deposit
 *      -> 404; response shape of a successful withdrawal.
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
const sc = require(path.join(ROOT, 'src/services/savingsCreditService'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, msg: e.message }));
let seq = 0;
async function user(label) {
  seq++;
  return q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R28S1 ${label}`, `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
}
async function deposit(userId, amount, matured) {
  return (await q1(`INSERT INTO fixed_deposits (user_id, amount, term_months, annual_rate, maturity_date, status)
    VALUES ($1,$2,6,10.00, CURRENT_DATE + $3::int, 'ACTIVE') RETURNING id`, [userId, amount, matured ? -1 : 90])).id;
}
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const txCount = async (uid, did) => q1(`SELECT COUNT(*) FILTER (WHERE type='FIXED_DEPOSIT')::int fd, COUNT(*) FILTER (WHERE type='FIXED_DEPOSIT_PENALTY')::int pen,
  COUNT(*) FILTER (WHERE type='FIXED_DEPOSIT_INTEREST')::int int FROM transactions WHERE user_id=$1 AND meta->>'deposit_id' = $2`, [uid, String(did)]);
const NOT_FOUND = 'Mchango huu haupatikani au umechukuliwa.';

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] deterministic: second withdrawal while the first is paused inside its transaction');
  {
    const u = await user('u1'); const did = await deposit(u.id, 10000, false);
    const w0 = await walletC(u.id);
    let release; const released = new Promise((x) => { release = x; });
    let paused; const isPaused = new Promise((x) => { paused = x; });
    gate.prefix = 'INSERT INTO transactions (reference_id, user_id, wallet_amount, commission'; gate.released = released; gate.onPause = paused; gate.armed = true;
    let a1; let a2;
    try {
      const p1 = attempt(sc.withdrawFixedDeposit(u.id, did, { allow_early: true }));
      const didPause = await Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]);
      check('[1] setup: first withdrawal paused inside its transaction', didPause);
      const p2 = attempt(sc.withdrawFixedDeposit(u.id, did, { allow_early: true }));
      await sleep(400);
      release();
      [a1, a2] = await Promise.all([p1, p2]);
    } finally { gate.armed = false; release(); }
    const dw = (await walletC(u.id)) - w0; const tc = await txCount(u.id, did);
    check('[1] wallet credited 9800 once', dw === 980000, { credited: dw / 100 });
    check('[1] first succeeds; second gets the existing 404', a1.ok && a1.r.payout === 9800 && !a2.ok && a2.status === 404 && a2.msg === NOT_FOUND, { a1, a2 });
    check('[1] one FIXED_DEPOSIT and one PENALTY transactions row', tc.fd === 1 && tc.pen === 1, tc);
  }

  console.log('\n[2] 4 parallel early withdrawals');
  {
    const u = await user('u2'); const did = await deposit(u.id, 5000, false);
    const w0 = await walletC(u.id);
    const rs = await Promise.all([0, 1, 2, 3].map(() => attempt(sc.withdrawFixedDeposit(u.id, did, { allow_early: 'true' }))));
    const dw = (await walletC(u.id)) - w0; const tc = await txCount(u.id, did);
    check('[2] exactly one succeeds, the others 404; credited 4900 once; one row set', rs.filter((x) => x.ok).length === 1 && rs.filter((x) => !x.ok && x.status === 404).length === 3 && dw === 490000 && tc.fd === 1 && tc.pen === 1,
      { rs: rs.map((x) => (x.ok ? 'ok' : `${x.status}`)), credited: dw / 100, tc });
  }

  console.log('\n[3] 4 parallel matured withdrawals');
  {
    const u = await user('u3'); const did = await deposit(u.id, 12000, true);
    const w0 = await walletC(u.id);
    const rs = await Promise.all([0, 1, 2, 3].map(() => attempt(sc.withdrawFixedDeposit(u.id, did, {}))));
    const dw = (await walletC(u.id)) - w0; const tc = await txCount(u.id, did);
    const st = await q1('SELECT status, interest_accrued FROM fixed_deposits WHERE id=$1', [did]);
    check('[3] exactly one succeeds; credited 12600 once; one FIXED_DEPOSIT and one INTEREST row; MATURED', rs.filter((x) => x.ok).length === 1 && dw === 1260000 && tc.fd === 1 && tc.int === 1 && st.status === 'MATURED' && cents(st.interest_accrued) === 60000,
      { rs: rs.map((x) => (x.ok ? 'ok' : `${x.status}`)), credited: dw / 100, tc, st });
  }

  console.log('\n[4] unchanged behaviour');
  {
    const u = await user('u4'); const o = await user('o4'); const did = await deposit(u.id, 3000, false);
    const a = await attempt(sc.withdrawFixedDeposit(u.id, did, {}));
    const st = await q1('SELECT status FROM fixed_deposits WHERE id=$1', [did]);
    check('[4] not matured without allow_early -> 400, stays ACTIVE', !a.ok && a.status === 400 && st.status === 'ACTIVE', { a, st });
    const b = await attempt(sc.withdrawFixedDeposit(o.id, did, { allow_early: true }));
    check('[4] another user -> 404 with the existing message', !b.ok && b.status === 404 && b.msg === NOT_FOUND, b);
    const c = await attempt(sc.withdrawFixedDeposit(u.id, did, { allow_early: true }));
    check('[4] success shape', c.ok && c.r.success === true && c.r.deposit_id === did && c.r.payout === 2940 && c.r.principal === 3000 && c.r.interest === 0 && c.r.penalty === 60 && c.r.status === 'WITHDRAWN_EARLY', c);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
