#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R24-B: unbacked credits + lock races
 *   src/services/businessService.js, src/services/mkobaService.js
 *
 *  R24-N1  POS close must NOT create e-money from a user-declared cash count.
 *          The session is closed and the declared cash/sales/variance are
 *          recorded, but the business float is not credited and nothing is
 *          posted against MNO_CLEARING (no settlement evidence exists).
 *  R24-N2  closePosSession / adminApproveLoan / adminDisburseLoan act once
 *          under concurrency (state claim inside the transaction), and a
 *          failure mid-disbursement rolls everything back.
 *  R24-N4  every businessService transaction rolls back explicitly on error
 *          (db.js auto-rollback only covers a client's first checkout).
 *  R24-N3  VICOBA cross-network top-up must not credit the group without a
 *          provider-confirmed settlement: recorded PENDING (as wallet deposits
 *          are), no journal, no group/member balance change.
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix> on
 * 127.0.0.1:55471. axios is stubbed: no real network.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55471') {
  console.error('REFUSING: DB_HOST/DB_PORT must be the disposable p71-ci-db (127.0.0.1:55471).');
  process.exit(2);
}

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = {
  post: async () => { throw new Error('network disabled in test'); },
  get: async () => { throw new Error('network disabled in test'); },
};
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const business = require(path.join(ROOT, 'src/services/businessService'));
const mkoba = require(path.join(ROOT, 'src/services/mkobaService'));
const fin = require(path.join(ROOT, 'src/services/financialEngine'));

let passed = 0; let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const num = async (sql, p) => Number(Object.values(await q1(sql, p))[0]);
let seq = 0;
async function user(label) {
  seq++;
  return (await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id',
    [`R24B ${label} ${seq}`, `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`])).id;
}
const journalCount = (like) => num('SELECT COUNT(*) FROM journal_entries WHERE reference_id LIKE $1', [like]);
const bizBal = (id) => num('SELECT balance FROM business_accounts WHERE id=$1', [id]);
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);
const txCount = (uid, feature) => num(`SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND meta->>'feature'=$2`, [uid, feature]);

async function expectReject(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

(async () => {
  const id = await q1('SELECT current_database() db, inet_server_port() port, inet_server_addr() addr');
  console.log(`DB identity: database=${id.db} server_addr=${id.addr} server_port=${id.port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  // ------------------------------------------------------------------ N1
  console.log('\n[1] R24-N1 POS close records the cash count but creates no e-money');
  {
    const owner = await user('owner');
    const biz = await business.registerBusiness(owner, { business_name: 'R24B shop 1' });
    const s = await business.openPosSession(biz.id, owner, 0);
    const w0 = await wallet(owner);
    const r = await business.closePosSession(s.id, owner, 1000000, 1000000);
    const row = await q1('SELECT status, closing_cash, sales_total, closed_at FROM pos_sessions WHERE id=$1', [s.id]);
    check('session CLOSED with declared closing_cash and sales recorded',
      row.status === 'CLOSED' && Number(row.closing_cash) === 1000000 && Number(row.sales_total) === 1000000 && row.closed_at, row);
    check('business float NOT credited (0)', (await bizBal(biz.id)) === 0, await bizBal(biz.id));
    check('no MNO_CLEARING/BUSINESS_WALLET journal for the session', (await journalCount(`BIZPOS:${s.id}:%`)) === 0);
    check('no DEPOSIT transaction for pos_sales', (await txCount(owner, 'pos_sales')) === 0);
    check('result reports deposited 0 and float_credited false', r.deposited === 0 && r.float_credited === false, r);
    check('result reports cash variance vs opening (1,000,000)', Number(r.cash_variance) === 1000000, r);
    const e = await expectReject(() => business.businessToWallet(biz.id, owner, 1000000));
    check('businessToWallet of the declared amount is refused', !!e, e && e.message);
    check('customer wallet unchanged', (await wallet(owner)) === w0);
  }

  console.log('\n[2] R24-N1 invalid cash counts rejected with 400, session stays OPEN');
  {
    const owner = await user('owner');
    const biz = await business.registerBusiness(owner, { business_name: 'R24B shop 2' });
    const s = await business.openPosSession(biz.id, owner, 100);
    for (const bad of [-1, 'abc', 'Infinity', '12abc']) {
      const e = await expectReject(() => business.closePosSession(s.id, owner, bad, 0));
      check(`closing_cash=${JSON.stringify(bad)} → 400`, e && e.statusCode === 400, e ? `${e.statusCode} ${e.message}` : 'accepted');
    }
    const e2 = await expectReject(() => business.closePosSession(s.id, owner, 200, -5));
    check('sales_total=-5 → 400', e2 && e2.statusCode === 400, e2 ? `${e2.statusCode} ${e2.message}` : 'accepted');
    const row = await q1('SELECT status FROM pos_sessions WHERE id=$1', [s.id]);
    check('session still OPEN, float unchanged', row.status === 'OPEN' && (await bizBal(biz.id)) === 0, row);
    const outsider = await user('outsider');
    const e3 = await expectReject(() => business.closePosSession(s.id, outsider, 200, 100));
    check('outsider cannot close another business session (403/404)', e3 && [403, 404].includes(e3.statusCode), e3 && e3.statusCode);
    check('session still OPEN after outsider attempt', (await q1('SELECT status FROM pos_sessions WHERE id=$1', [s.id])).status === 'OPEN');
  }

  // ------------------------------------------------------------------ N2
  console.log('\n[3] R24-N2 concurrent POS closes: exactly one succeeds');
  {
    const owner = await user('owner');
    const biz = await business.registerBusiness(owner, { business_name: 'R24B shop 3' });
    const s = await business.openPosSession(biz.id, owner, 0);
    const r = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => business.closePosSession(s.id, owner, 500 + i, 500)));
    const ok = r.filter((x) => x.status === 'fulfilled').length;
    const codes = r.filter((x) => x.status === 'rejected').map((x) => x.reason.statusCode);
    check('exactly 1 of 5 fulfilled', ok === 1, { ok, codes });
    check('others rejected 409/404 (already closed)', codes.length === 4 && codes.every((c) => c === 409 || c === 404), codes);
    check('float unchanged (0)', (await bizBal(biz.id)) === 0);
    check('no journal for the session', (await journalCount(`BIZPOS:${s.id}:%`)) === 0);
  }

  console.log('\n[4] R24-N2 concurrent loan disbursement: exactly one credit');
  {
    const owner = await user('owner');
    const admin = await user('admin');
    const biz = await business.registerBusiness(owner, { business_name: 'R24B shop 4' });
    const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status)
                           VALUES ($1,$2,10000,10,12,'APPROVED') RETURNING id`, [biz.id, owner]);
    const r = await Promise.allSettled([1, 2, 3, 4, 5].map(() => business.adminDisburseLoan(loan.id, admin)));
    const ok = r.filter((x) => x.status === 'fulfilled').length;
    const codes = r.filter((x) => x.status === 'rejected').map((x) => x.reason.statusCode);
    check('exactly 1 of 5 fulfilled', ok === 1, { ok, codes });
    check('others rejected 409/404', codes.every((c) => c === 409 || c === 404), codes);
    check('business balance 10,000 (not ×N)', (await bizBal(biz.id)) === 10000, await bizBal(biz.id));
    check('exactly one disbursement journal (2 lines)', (await journalCount(`BIZLOAN:${loan.id}:DISBURSE`)) === 2);
    check('exactly one DEPOSIT transaction', (await txCount(owner, 'business_loan')) === 1);
    const l = await q1('SELECT status, due_amount FROM business_loans WHERE id=$1', [loan.id]);
    check('loan DISBURSED, due 11,000', l.status === 'DISBURSED' && Number(l.due_amount) === 11000, l);
    const e = await expectReject(() => business.adminDisburseLoan(loan.id, admin));
    check('re-disbursement after the fact rejected', !!e && [404, 409].includes(e.statusCode), e && e.statusCode);
  }

  console.log('\n[5] R24-N2 disbursement failure rolls back (no partial credit)');
  {
    const owner = await user('owner');
    const admin = await user('admin');
    const biz = await business.registerBusiness(owner, { business_name: 'R24B shop 5' });
    const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status)
                           VALUES ($1,$2,7000,10,12,'APPROVED') RETURNING id`, [biz.id, owner]);
    const orig = fin.postJournal;
    fin.postJournal = async () => { throw new Error('injected journal failure'); };
    let e;
    try { e = await expectReject(() => business.adminDisburseLoan(loan.id, admin)); } finally { fin.postJournal = orig; }
    check('disbursement failed', !!e, e && e.message);
    const l = await q1('SELECT status, disbursed_at FROM business_loans WHERE id=$1', [loan.id]);
    check('loan still APPROVED', l.status === 'APPROVED' && !l.disbursed_at, l);
    check('business balance unchanged (0)', (await bizBal(biz.id)) === 0);
    check('no transaction row', (await txCount(owner, 'business_loan')) === 0);
    let ok = null;
    try { ok = await business.adminDisburseLoan(loan.id, admin); } catch (err) { ok = { success: false, error: err.message }; }
    check('retry after rollback disburses once', ok.success && (await bizBal(biz.id)) === 7000, { ok, balance: await bizBal(biz.id) });
  }

  console.log('\n[6] R24-N2 concurrent loan approval: exactly one');
  {
    const owner = await user('owner');
    const admin = await user('admin');
    const biz = await business.registerBusiness(owner, { business_name: 'R24B shop 6' });
    const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status)
                           VALUES ($1,$2,5000,10,12,'PENDING') RETURNING id`, [biz.id, owner]);
    const ePending = await expectReject(() => business.adminDisburseLoan(loan.id, admin));
    check('PENDING loan cannot be disbursed', !!ePending && (await bizBal(biz.id)) === 0, ePending && ePending.statusCode);
    const r = await Promise.allSettled([1, 2, 3].map((i) => business.adminApproveLoan(loan.id, admin, `note ${i}`)));
    check('exactly 1 of 3 approvals fulfilled', r.filter((x) => x.status === 'fulfilled').length === 1,
      r.map((x) => x.status === 'fulfilled' ? 'ok' : x.reason.statusCode));
    check('loan APPROVED', (await q1('SELECT status FROM business_loans WHERE id=$1', [loan.id])).status === 'APPROVED');
  }

  // ------------------------------------------------------------------ N3
  console.log('\n[7] R24-N3 cross-network top-up is recorded PENDING and credits nothing');
  {
    const member = await user('member');
    const g = await q1(`INSERT INTO vicoba_groups (group_name, cycle_type, share_value, created_by_user_id)
                        VALUES ('R24B group', 'MONTHLY', 1000, $1) RETURNING id`, [member]);
    await pool.query('INSERT INTO vicoba_members (group_id, user_id) VALUES ($1,$2)', [g.id, member]);
    const jBefore = await num(`SELECT COUNT(*) FROM journal_entries WHERE reference_id LIKE '%:GTOP'`);
    const r = await mkoba.processCrossNetworkTopUp(g.id, member,
      { amount: 250000, provider: 'M-PESA', externalRef: 'FAKE-REF-1', phone: '255700000000' });
    check('accepted as PENDING, credited false (API contract kept: success true)',
      r.success === true && r.status === 'PENDING' && r.credited === false && r.referenceId, r);
    const tx = await q1('SELECT status, type, wallet_amount, meta FROM transactions WHERE reference_id=$1', [r.referenceId]);
    check('transactions row PENDING / VICOBA_SHARE / 250000 / awaiting confirmation',
      tx && tx.status === 'PENDING' && tx.type === 'VICOBA_SHARE' && Number(tx.wallet_amount) === 250000 && tx.meta.awaiting_provider_confirmation === true, tx);
    const grp = await q1('SELECT group_wallet_balance FROM vicoba_groups WHERE id=$1', [g.id]);
    const mem = await q1('SELECT contribution_balance FROM vicoba_members WHERE group_id=$1 AND user_id=$2', [g.id, member]);
    check('group balance unchanged (0)', Number(grp.group_wallet_balance) === 0, grp);
    check('member contribution unchanged (0)', Number(mem.contribution_balance) === 0, mem);
    check('no GTOP / MNO_CLEARING journal', (await num(`SELECT COUNT(*) FROM journal_entries WHERE reference_id LIKE '%:GTOP'`)) === jBefore);
    for (const bad of [-5, 'abc', 0]) {
      const e = await expectReject(() => mkoba.processCrossNetworkTopUp(g.id, member, { amount: bad, provider: 'M-PESA' }));
      check(`amount=${JSON.stringify(bad)} → 400`, e && e.statusCode === 400, e ? e.statusCode : 'accepted');
    }
    const eP = await expectReject(() => mkoba.processCrossNetworkTopUp(g.id, member, { amount: 5000, provider: 'BITCOIN' }));
    check('invalid provider → 400', eP && eP.statusCode === 400, eP && eP.statusCode);
    const outsider = await user('outsider');
    const eO = await expectReject(() => mkoba.processCrossNetworkTopUp(g.id, outsider, { amount: 5000, provider: 'M-PESA' }));
    check('non-member → 403, no row', eO && eO.statusCode === 403 && (await num('SELECT COUNT(*) FROM transactions WHERE user_id=$1', [outsider])) === 0, eO && eO.statusCode);
  }

  console.log('\n[9] R24-N4 failed business transactions never leak an open transaction to the pool');
  {
    const owner = await user('owner');
    const biz = await business.registerBusiness(owner, { business_name: 'R24B shop 9' });
    let rejected = 0;
    for (let i = 0; i < 30; i++) {
      const e = await expectReject(() => business.businessToWallet(biz.id, owner, 999999));
      if (e) rejected++;
    }
    check('30 insufficient-balance withdrawals rejected', rejected === 30);
    const probes = await Promise.allSettled(Array.from({ length: 40 }, () =>
      pool.query("SELECT now() = statement_timestamp() AS fresh, txid_current_if_assigned() AS txid")));
    const bad = probes.filter((x) => x.status === 'rejected' || x.value.rows[0].fresh !== true || x.value.rows[0].txid !== null);
    check('40 subsequent pool queries run outside any leaked transaction', bad.length === 0,
      bad.slice(0, 3).map((x) => x.status === 'rejected' ? x.reason.message : x.value.rows[0]));
    check('business balance still 0, wallet untouched', (await bizBal(biz.id)) === 0 && (await wallet(owner)) === 0);
  }

  // ------------------------------------------------------------------ static
  console.log('\n[8] static');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/businessService.js'), 'utf8');
    check('no FOR UPDATE through pool.query in businessService', !/pool\.query\([^)]*FOR UPDATE/.test(src));
    check('every BEGIN in businessService has an explicit ROLLBACK', (src.match(/query\('BEGIN'\)/g) || []).length === (src.match(/query\('ROLLBACK'\)/g) || []).length);
    const pos = src.slice(src.indexOf('async function closePosSession'));
    check('closePosSession posts no MNO_CLEARING', !/MNO_CLEARING/.test(pos.slice(0, pos.indexOf('\n}\n'))));
    const rec = fs.readFileSync(path.join(ROOT, 'src/jobs/reconciliationCron.js'), 'utf8');
    check('pending-deposit reconciler only settles type DEPOSIT (PENDING VICOBA_SHARE never auto-credited)',
      /t\.status = 'PENDING'\s*AND t\.type = 'DEPOSIT'/.test(rec));
    const mk = fs.readFileSync(path.join(ROOT, 'src/services/mkobaService.js'), 'utf8');
    const cn = mk.slice(mk.indexOf('async function processCrossNetworkTopUp'));
    check('cross-network top-up posts no journal / balance update', !/postJournal|group_wallet_balance =|contribution_balance =/.test(cn.slice(0, cn.indexOf('\n}\n'))));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.log('FATAL', e.stack || e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
