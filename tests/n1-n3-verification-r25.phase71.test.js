#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R25: independent verification of R24-N1/N2/N3
 *   (on top of tests/business-pos-loan-r24.phase71.test.js)
 *
 *  N1  POS close never increases a customer wallet, business float or any
 *      MNO_CLEARING-backed balance; cash count / sales / variance preserved.
 *  N2  concurrent duplicates of POS close / loan approve / loan disburse get
 *      ONE success and a CONSISTENT conflict reply (409 + stable code).
 *  N3  cross-network top-up: actual contract is 200 {success:true,
 *      status:'PENDING', credited:false}; no group/member balance increase;
 *      the PENDING row is not settled by the deposit reconciler.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '')) { console.error('REFUSING: DB_NAME'); process.exit(2); }
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55471') { console.error('REFUSING: DB_HOST/DB_PORT'); process.exit(2); }

const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = { post: async () => { throw new Error('network disabled'); }, get: async () => { throw new Error('network disabled'); } };
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const business = require(path.join(ROOT, 'src/services/businessService'));
const mkoba = require(path.join(ROOT, 'src/services/mkobaService'));

let passed = 0; let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}
async function section(fn) { try { await fn(); } catch (e) { failed++; console.log(`  ✗ section aborted — ${e.message}`); } }
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const num = async (sql, p) => Number(Object.values(await q1(sql, p))[0]);
let seq = 0;
async function user(label) {
  seq++;
  return (await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id',
    [`R25V ${label} ${seq}`, `2554${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`])).id;
}
const codes = (r) => r.filter((x) => x.status === 'rejected').map((x) => `${x.reason.statusCode}:${x.reason.code || ''}`);

(async () => {
  const id = await q1('SELECT current_database() db, inet_server_addr() addr, inet_server_port() port');
  console.log(`DB identity: database=${id.db} server_addr=${id.addr} server_port=${id.port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING');

  console.log('\n[1] N1 POS close: no balance of any kind is created; cash data preserved');
  await section(async () => {
    const o = await user('pos');
    const biz = await business.registerBusiness(o, { business_name: 'R25V pos' });
    const s = await business.openPosSession(biz.id, o, 250);
    const w0 = await num('SELECT wallet_balance FROM users WHERE id=$1', [o]);
    const mno0 = await num(`SELECT COALESCE(SUM(CASE WHEN je.direction='DR' THEN je.amount ELSE -je.amount END),0) FROM journal_entries je JOIN ledger_accounts la ON la.id=je.account_id WHERE la.account_code='MNO_CLEARING'`);
    const r = await business.closePosSession(s.id, o, 1250.5, 1100);
    const row = await q1('SELECT opening_cash, closing_cash, sales_total, status FROM pos_sessions WHERE id=$1', [s.id]);
    check('opening/closing/sales stored (250 / 1250.50 / 1100), CLOSED',
      Number(row.opening_cash) === 250 && Number(row.closing_cash) === 1250.5 && Number(row.sales_total) === 1100 && row.status === 'CLOSED', row);
    check('variance reported (1000.50), float_credited false, deposited 0', r.cash_variance === 1000.5 && r.float_credited === false && r.deposited === 0, r);
    check('customer wallet unchanged', (await num('SELECT wallet_balance FROM users WHERE id=$1', [o])) === w0);
    check('business float 0', (await num('SELECT balance FROM business_accounts WHERE id=$1', [biz.id])) === 0);
    check('global MNO_CLEARING net unchanged', (await num(`SELECT COALESCE(SUM(CASE WHEN je.direction='DR' THEN je.amount ELSE -je.amount END),0) FROM journal_entries je JOIN ledger_accounts la ON la.id=je.account_id WHERE la.account_code='MNO_CLEARING'`)) === mno0);
  });

  console.log('\n[2] N2 consistent conflict reply for concurrent duplicates');
  await section(async () => {
    const o = await user('n2'); const admin = await user('n2a');
    const biz = await business.registerBusiness(o, { business_name: 'R25V n2' });
    const s = await business.openPosSession(biz.id, o, 0);
    const rc = await Promise.allSettled(Array.from({ length: 6 }, () => business.closePosSession(s.id, o, 10, 10)));
    check('POS close: 1 success, 5 × 409:POS_SESSION_NOT_OPEN',
      rc.filter((x) => x.status === 'fulfilled').length === 1 && codes(rc).length === 5 && codes(rc).every((c) => c === '409:POS_SESSION_NOT_OPEN'), codes(rc));
    const l1 = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status) VALUES ($1,$2,3000,10,12,'PENDING') RETURNING id`, [biz.id, o]);
    const ra = await Promise.allSettled(Array.from({ length: 6 }, () => business.adminApproveLoan(l1.id, admin, 'x')));
    check('approve: 1 success, 5 × 409:LOAN_STATE_CONFLICT',
      ra.filter((x) => x.status === 'fulfilled').length === 1 && codes(ra).every((c) => c === '409:LOAN_STATE_CONFLICT') && codes(ra).length === 5, codes(ra));
    const rd = await Promise.allSettled(Array.from({ length: 6 }, () => business.adminDisburseLoan(l1.id, admin)));
    check('disburse: 1 success, 5 × 409:LOAN_STATE_CONFLICT',
      rd.filter((x) => x.status === 'fulfilled').length === 1 && codes(rd).every((c) => c === '409:LOAN_STATE_CONFLICT') && codes(rd).length === 5, codes(rd));
    check('float credited exactly 3,000', (await num('SELECT balance FROM business_accounts WHERE id=$1', [biz.id])) === 3000);
    const eMissing = await business.adminDisburseLoan(999999999, admin).catch((e) => e);
    check('unknown loan → 404 (distinct from conflict)', eMissing.statusCode === 404, eMissing.statusCode);
  });

  console.log('\n[3] N3 actual contract and no unbacked group balance');
  await section(async () => {
    const m = await user('n3');
    const g = await q1(`INSERT INTO vicoba_groups (group_name, cycle_type, share_value, created_by_user_id) VALUES ('R25V g','MONTHLY',1000,$1) RETURNING id`, [m]);
    await pool.query('INSERT INTO vicoba_members (group_id, user_id) VALUES ($1,$2)', [g.id, m]);
    const rs = await Promise.allSettled([1, 2, 3].map((i) => mkoba.processCrossNetworkTopUp(g.id, m, { amount: 1000 * i, provider: 'AIRTEL', externalRef: `X${i}` })));
    const vals = rs.filter((x) => x.status === 'fulfilled').map((x) => x.value);
    check('3/3 return {success:true, status:PENDING, credited:false}', vals.length === 3 && vals.every((v) => v.success === true && v.status === 'PENDING' && v.credited === false), rs.map((x) => x.status));
    check('group balance 0; member contribution 0',
      (await num('SELECT group_wallet_balance FROM vicoba_groups WHERE id=$1', [g.id])) === 0 && (await num('SELECT contribution_balance FROM vicoba_members WHERE group_id=$1 AND user_id=$2', [g.id, m])) === 0);
    check('3 PENDING VICOBA_SHARE rows; 0 SUCCESS', (await num(`SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND type='VICOBA_SHARE' AND status='PENDING'`, [m])) === 3
      && (await num(`SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND type='VICOBA_SHARE' AND status='SUCCESS'`, [m])) === 0);
    const rec = require(path.join(ROOT, 'src/jobs/reconciliationCron.js'));
    check('deposit reconciler exposes no path that settles VICOBA_SHARE (static: DEPOSIT-only selector)',
      /t\.status = 'PENDING'\s*AND t\.type = 'DEPOSIT'/.test(require('fs').readFileSync(path.join(ROOT, 'src/jobs/reconciliationCron.js'), 'utf8')) && typeof rec === 'object');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.log('FATAL', e.stack || e.message); await pool.end().catch(() => {}); process.exit(1); });
