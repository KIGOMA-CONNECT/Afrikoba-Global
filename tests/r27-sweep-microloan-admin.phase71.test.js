#!/usr/bin/env node
'use strict';
/* R27 sweep (principles b/c) — savingsCreditService admin/guarantor paths.
 *  [1] IV-A-8 adminDisburseMicroLoan: 4 concurrent disbursements -> credited once, one
 *      installment schedule, losers get a typed 4xx (HEAD: raw 23505 -> 500).
 *  [2] S-2 adminApproveMicroLoan: two concurrent approvals -> exactly one succeeds
 *      (HEAD: both succeed; deterministic via a pause before the first UPDATE).
 *  [3] S-3 respondGuarantor: decline paused between its read and its write while an
 *      accept commits -> never DECLINED with the guarantee still locked.
 *  [4] sequential paths unchanged (approve, disburse, accept, decline, response shapes).
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

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const num = async (s, p) => Number(Object.values(await q1(s, p))[0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
async function user(label, fund = 0) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id, phone_number', [`R27S ${label}`, `2552${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (fund) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fin.creditWallet({ client: c, userId: u.id, amount: fund, reference: `R27S-F-${u.id}-${Date.now()}`, description: 'fund' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return u;
}
const loan = (uid, status, amount = 7000, term = 1) => q1(`INSERT INTO micro_loans (user_id, amount, interest_rate, term_months, status, approved_at) VALUES ($1,$2,10,$3,$4::text, CASE WHEN $4::text='APPROVED' THEN NOW() END) RETURNING id`, [uid, amount, term, status]);
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);
const locked = (id) => num('SELECT locked_balance FROM users WHERE id=$1', [id]);
const typed = (e) => e && Number.isInteger(e.statusCode) && e.statusCode >= 400 && e.statusCode < 500;

// Pause the first pool.query whose SQL starts with `prefix` until `release` resolves or `ms` pass.
// db.js exports a get-only Proxy over the real Pool, so the patch goes on that Pool.
function pauseQuery(prefix, release, ms) {
  const real = pool._getPool();
  const orig = real.query;
  let done = false;
  real.query = async function patched(sql, ...rest) {
    if (!done && typeof sql === 'string' && sql.trim().startsWith(prefix)) {
      done = true;
      await Promise.race([release, sleep(ms)]);
    }
    return orig.call(real, sql, ...rest);
  };
  return () => { delete real.query; if (real.query !== orig) real.query = orig; };
}

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const admin = await user('admin');

  console.log('\n[1] IV-A-8: 4 concurrent adminDisburseMicroLoan');
  {
    const b = await user('borrower');
    const l = await loan(b.id, 'APPROVED');
    const w0 = await wallet(b.id);
    const res = await Promise.allSettled([1, 2, 3, 4].map(() => credit.adminDisburseMicroLoan(l.id, admin.id)));
    const ok = res.filter((x) => x.status === 'fulfilled').length;
    const losers = res.filter((x) => x.status === 'rejected').map((x) => x.reason);
    check('exactly one disbursement succeeds', ok === 1, res.map((x) => x.status));
    check('borrower credited once (+7000)', (await wallet(b.id)) - w0 === 7000, (await wallet(b.id)) - w0);
    check('one installment schedule (1 row)', (await num('SELECT COUNT(*) FROM loan_installments WHERE loan_id=$1', [l.id])) === 1);
    check('losers get a typed 4xx, not a raw DB error (500)', losers.every(typed), losers.map((e) => e.statusCode || e.code || e.message));
  }

  console.log('\n[2] S-2: two concurrent adminApproveMicoLoan');
  {
    const b = await user('applicant');
    const l = await loan(b.id, 'PENDING');
    let rel; const release = new Promise((r) => { rel = r; });
    const restore = pauseQuery('UPDATE micro_loans SET status = \'APPROVED\'', release, 1500);
    let res;
    try {
      const p1 = credit.adminApproveMicroLoan(l.id, admin.id, 'first');
      await sleep(150);
      const p2 = credit.adminApproveMicroLoan(l.id, admin.id, 'second').finally(() => rel());
      res = await Promise.allSettled([p1, p2]);
    } finally { restore(); }
    const ok = res.filter((x) => x.status === 'fulfilled').length;
    check('exactly one approval succeeds', ok === 1, res.map((x) => (x.status === 'fulfilled' ? 'ok' : x.reason.statusCode || x.reason.message)));
    check('loss is a typed 4xx', res.filter((x) => x.status === 'rejected').every((x) => typed(x.reason)));
    check('loan APPROVED', (await q1('SELECT status FROM micro_loans WHERE id=$1', [l.id])).status === 'APPROVED');
  }

  console.log('\n[3] S-3: decline paused between read and write while accept commits');
  {
    const b = await user('applicant3');
    const g = await user('guarantor', 50000);
    const l = await loan(b.id, 'PENDING', 10000, 3);
    await credit.addGuarantor(b.id, l.id, g.phone_number);
    const lk0 = await locked(g.id);
    let rel; const release = new Promise((r) => { rel = r; });
    const restore = pauseQuery('UPDATE loan_guarantors SET status = \'DECLINED\'', release, 1500);
    let res;
    try {
      const pDecline = credit.respondGuarantor(g.id, l.id, false);
      await sleep(150); // decline has read PENDING and is paused before its write
      const pAccept = credit.respondGuarantor(g.id, l.id, true).finally(() => rel());
      res = await Promise.allSettled([pDecline, pAccept]);
    } finally { restore(); }
    const row = await q1('SELECT status, blocked_amount::float AS blocked FROM loan_guarantors WHERE loan_id=$1 AND guarantor_id=$2', [l.id, g.id]);
    const lk = (await locked(g.id)) - lk0;
    check('consistent: ACCEPTED with the guarantee locked, or DECLINED with nothing locked',
      (row.status === 'ACCEPTED' && lk === row.blocked) || (row.status === 'DECLINED' && lk === 0),
      { row, lockedDelta: lk, res: res.map((x) => (x.status === 'fulfilled' ? 'ok' : x.reason.statusCode || x.reason.message)) });
    check('exactly one response succeeds', res.filter((x) => x.status === 'fulfilled').length === 1, res.map((x) => x.status));
  }

  console.log('\n[4] sequential paths unchanged');
  {
    const b = await user('seq');
    const l = await loan(b.id, 'PENDING');
    const ap = await credit.adminApproveMicroLoan(l.id, admin.id, 'ok');
    check('approve returns the loan row (APPROVED, note kept)', ap && ap.status === 'APPROVED' && ap.admin_note === 'ok', ap && ap.status);
    const again = await credit.adminApproveMicroLoan(l.id, admin.id, 'x').then(() => null, (e) => e);
    check('approving again: 404', again && again.statusCode === 404, again && again.statusCode);
    const w0 = await wallet(b.id);
    const d = await credit.adminDisburseMicroLoan(l.id, admin.id);
    check('disburse response shape (amount 7000, due 7700, 1 installment)', d.success === true && d.amount === 7000 && d.due_amount === 7700 && d.installments === 1, d);
    check('borrower +7000, loan ACTIVE', (await wallet(b.id)) - w0 === 7000 && (await q1('SELECT status FROM micro_loans WHERE id=$1', [l.id])).status === 'ACTIVE');
    const d2 = await credit.adminDisburseMicroLoan(l.id, admin.id).then(() => null, (e) => e);
    check('disbursing again: 404', d2 && d2.statusCode === 404, d2 && d2.statusCode);

    const b2 = await user('seq2'); const g1 = await user('g1', 20000); const g2 = await user('g2', 20000);
    const l2 = await loan(b2.id, 'PENDING', 10000, 3);
    await credit.addGuarantor(b2.id, l2.id, g1.phone_number);
    await credit.addGuarantor(b2.id, l2.id, g2.phone_number);
    const a = await credit.respondGuarantor(g1.id, l2.id, true);
    check('accept: response and 2000 locked', a.success === true && a.blocked_amount === 2000 && (await locked(g1.id)) === 2000, a);
    const dcl = await credit.respondGuarantor(g2.id, l2.id, false);
    check('decline: response, nothing locked', dcl.success === true && dcl.blocked_amount === 0 && (await locked(g2.id)) === 0, dcl);
    const twice = await credit.respondGuarantor(g1.id, l2.id, false).then(() => null, (e) => e);
    check('responding again: 404, ACCEPTED kept', twice && twice.statusCode === 404 && (await q1('SELECT status FROM loan_guarantors WHERE loan_id=$1 AND guarantor_id=$2', [l2.id, g1.id])).status === 'ACCEPTED', twice && twice.statusCode);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
