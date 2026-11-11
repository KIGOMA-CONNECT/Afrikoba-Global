#!/usr/bin/env node
'use strict';
/* R28 F2c — a guarantor may only ACCEPT (and so have funds locked) while the micro loan can still
 * be disbursed (PENDING or APPROVED). Guarantees are released only by adminDisburseMicroLoan, so a
 * hold placed on an ACTIVE/REPAID loan was never released.
 *  [1] unchanged: accept on a PENDING loan locks 20% of the amount; on an APPROVED loan too.
 *  [2] invitation still PENDING when the loan is disbursed; accepting afterwards -> 409, invitation
 *      stays PENDING, nothing locked (HEAD: 200, hold locked with no release path).
 *  [3] same for a REPAID loan.
 *  [4] unchanged: declining after disbursement is still allowed, nothing locked.
 *  [5] concurrency (10 rounds): a second guarantor's accept racing the disbursement. End state is
 *      either accept refused (PENDING, nothing locked) or accepted before disbursement and released
 *      by it (RELEASED, nothing left locked); never ACCEPTED with funds locked on an ACTIVE loan.
 *  [6] deterministic: accept paused right after its loan check while a disbursement runs; the
 *      disbursement must wait for the accept (loan share lock) and then release the hold.
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
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const credit = require(path.join(ROOT, 'src/services/savingsCreditService'));
// Pause hook for [6]: installed on the pg Client prototype BEFORE any client exists, because
// src/config/db.js binds client.query per instance on first checkout.
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

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
let seq = 0;
async function user(label, fund = 0) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id, phone_number', [`R28F2C ${label}`, `2553${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (fund) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fin.creditWallet({ client: c, userId: u.id, amount: fund, reference: `R28F2C-F-${u.id}-${Date.now()}`, description: 'fund' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return u;
}
const loan = (uid, status, amount = 10000, term = 3) => q1(`INSERT INTO micro_loans (user_id, amount, interest_rate, term_months, status, approved_at) VALUES ($1,$2,10,$3,$4::text, CASE WHEN $4::text='APPROVED' THEN NOW() END) RETURNING id`, [uid, amount, term, status]);
const lockedC = async (id) => cents((await q1('SELECT locked_balance FROM users WHERE id=$1', [id])).locked_balance);
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const inv = async (loanId, gid) => (await q1('SELECT status FROM loan_guarantors WHERE loan_id=$1 AND guarantor_id=$2', [loanId, gid])).status;
const lstatus = async (id) => (await q1('SELECT status FROM micro_loans WHERE id=$1', [id])).status;
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, code: e.code, msg: e.message }));

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const admin = await user('admin');

  console.log('\n[1] accept on PENDING and APPROVED loans (unchanged)');
  for (const st of ['PENDING', 'APPROVED']) {
    const b = await user(`b1${st}`);
    const g = await user(`g1${st}`, 50000);
    const l = await loan(b.id, 'PENDING');
    await credit.addGuarantor(b.id, l.id, g.phone_number);
    if (st === 'APPROVED') await credit.adminApproveMicroLoan(l.id, admin.id, 'ok');
    const lk0 = await lockedC(g.id);
    const a = await attempt(credit.respondGuarantor(g.id, l.id, true));
    check(`[1] ${st}: accept succeeds, 2000 locked, invitation ACCEPTED`, a.ok && a.r.blocked_amount === 2000 && (await lockedC(g.id)) - lk0 === 200000 && (await inv(l.id, g.id)) === 'ACCEPTED', a);
  }

  async function disbursedWithPendingSecond(label, repay) {
    const b = await user(`b${label}`, repay ? 20000 : 0);
    const g1 = await user(`g1${label}`, 50000);
    const g2 = await user(`g2${label}`, 50000);
    const l = await loan(b.id, 'PENDING');
    await credit.addGuarantor(b.id, l.id, g1.phone_number);
    await credit.addGuarantor(b.id, l.id, g2.phone_number);
    await credit.respondGuarantor(g1.id, l.id, true);
    await credit.adminApproveMicroLoan(l.id, admin.id, 'ok');
    await credit.adminDisburseMicroLoan(l.id, admin.id);
    if (repay) await credit.payoffLoan(b.id, l.id);
    return { b, g1, g2, l };
  }

  console.log('\n[2] accept after disbursement (loan ACTIVE)');
  {
    const { g2, l } = await disbursedWithPendingSecond('2', false);
    const lk0 = await lockedC(g2.id); const w0 = await walletC(g2.id);
    const a = await attempt(credit.respondGuarantor(g2.id, l.id, true));
    check('[2] setup: loan ACTIVE, second invitation PENDING', (await lstatus(l.id)) === 'ACTIVE' && a !== null);
    check('[2] accept refused with 409', !a.ok && a.status === 409, a);
    check('[2] nothing locked, invitation still PENDING', (await lockedC(g2.id)) === lk0 && (await walletC(g2.id)) === w0 && (await inv(l.id, g2.id)) === 'PENDING', { lk: (await lockedC(g2.id)) - lk0, inv: await inv(l.id, g2.id) });
  }

  console.log('\n[3] accept after the loan is REPAID');
  {
    const { g2, l } = await disbursedWithPendingSecond('3', true);
    const lk0 = await lockedC(g2.id);
    const a = await attempt(credit.respondGuarantor(g2.id, l.id, true));
    check('[3] setup: loan REPAID', (await lstatus(l.id)) === 'REPAID');
    check('[3] accept refused with 409, nothing locked, invitation PENDING', !a.ok && a.status === 409 && (await lockedC(g2.id)) === lk0 && (await inv(l.id, g2.id)) === 'PENDING', a);
  }

  console.log('\n[4] decline after disbursement (unchanged)');
  {
    const { g2, l } = await disbursedWithPendingSecond('4', false);
    const lk0 = await lockedC(g2.id);
    const a = await attempt(credit.respondGuarantor(g2.id, l.id, false));
    check('[4] decline succeeds, DECLINED, nothing locked', a.ok && a.r.blocked_amount === 0 && (await inv(l.id, g2.id)) === 'DECLINED' && (await lockedC(g2.id)) === lk0, a);
  }

  console.log('\n[5] concurrency: second guarantor accept racing disbursement (10 rounds)');
  {
    const bad = [];
    for (let i = 0; i < 10; i++) {
      const b = await user(`b5_${i}`);
      const g1 = await user(`g1_5_${i}`, 50000);
      const g2 = await user(`g2_5_${i}`, 50000);
      const l = await loan(b.id, 'PENDING');
      await credit.addGuarantor(b.id, l.id, g1.phone_number);
      await credit.addGuarantor(b.id, l.id, g2.phone_number);
      await credit.respondGuarantor(g1.id, l.id, true);
      await credit.adminApproveMicroLoan(l.id, admin.id, 'ok');
      const lk0 = await lockedC(g2.id);
      const [acc, dis] = await Promise.all([attempt(credit.respondGuarantor(g2.id, l.id, true)), attempt(credit.adminDisburseMicroLoan(l.id, admin.id))]);
      const st = await inv(l.id, g2.id); const lk = (await lockedC(g2.id)) - lk0; const ls = await lstatus(l.id);
      const refused = !acc.ok && st === 'PENDING' && lk === 0;
      const releasedBy = acc.ok && st === 'RELEASED' && lk === 0;
      if (!(dis.ok && ls === 'ACTIVE' && (refused || releasedBy))) bad.push({ acc: acc.ok || acc.status, dis: dis.ok || dis.status, st, lk, ls });
    }
    check('[5] never ACCEPTED with funds locked on an ACTIVE loan; disbursement always succeeds', bad.length === 0, bad);
  }

  console.log('\n[6] deterministic: accept paused after its loan check while a disbursement runs');
  {
    const b = await user('b6');
    const g1 = await user('g1_6', 50000);
    const g2 = await user('g2_6', 50000);
    const l = await loan(b.id, 'PENDING');
    await credit.addGuarantor(b.id, l.id, g1.phone_number);
    await credit.addGuarantor(b.id, l.id, g2.phone_number);
    await credit.respondGuarantor(g1.id, l.id, true);
    await credit.adminApproveMicroLoan(l.id, admin.id, 'ok');
    const lk0 = await lockedC(g2.id);
    let release; const released = new Promise((r) => { release = r; });
    let paused; const isPaused = new Promise((r) => { paused = r; });
    gate.prefix = 'SELECT * FROM loan_guarantors WHERE id = $1 AND status = \'PENDING\' FOR UPDATE';
    gate.released = released; gate.onPause = paused; gate.armed = true;
    let acc; let dis; let disDoneDuringPause = false;
    try {
      const pAcc = attempt(credit.respondGuarantor(g2.id, l.id, true));
      const didPause = await Promise.race([isPaused.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
      check('[6] setup: accept paused after its loan check', didPause);
      const pDis = attempt(credit.adminDisburseMicroLoan(l.id, admin.id)).then((x) => { dis = x; return x; });
      await new Promise((r) => setTimeout(r, 1500));
      disDoneDuringPause = dis !== undefined;
      release();
      [acc] = await Promise.all([pAcc, pDis]);
    } finally { gate.armed = false; release(); }
    const st = await inv(l.id, g2.id); const lk = (await lockedC(g2.id)) - lk0;
    check('[6] disbursement waits for the in-flight accept (blocked by the loan share lock)', !disDoneDuringPause, { disDoneDuringPause });
    check('[6] accept then disbursement: hold released (RELEASED, nothing left locked), loan ACTIVE', acc.ok && dis.ok && st === 'RELEASED' && lk === 0 && (await lstatus(l.id)) === 'ACTIVE', { acc, dis: dis && (dis.ok || dis.status), st, lk });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
