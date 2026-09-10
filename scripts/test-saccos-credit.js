/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - CREDIT
 * Increment 4 regression: loan applications -> OWNER/BOARD
 * approval -> disbursement (DR SACCOS<id>_LOANS_RECEIVABLE /
 * CR CUSTOMER_WALLET) -> flat-interest repayment (DR wallet /
 * CR LOANS_RECEIVABLE principal + CR SACCOS<id>_INTEREST_INCOME
 * interest), auto- or manual-disburse (config.lending
 * {interestRate,minAmount,maxAmount,maxTermMonths,maxActiveLoans,
 * autoDisburse}), close at zero outstanding, member RBAC 403,
 * cross-entity isolation 404 incl. distinct ASSET/REVENUE codes,
 * platform ADMIN oversight, audit trail. Suite 48.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const crypto = require('crypto');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++; failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label); else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method, headers,
    body: !isGet && body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
async function makeAdmin(reg, depth = 0) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (depth < 1) {
    const backup = await register('255679' + nowSuffix(), 'Credit Admin Backup');
    return makeAdmin(backup, depth + 1);
  }
  return null;
}
function nowSuffix() { return String(Date.now()).slice(-6); }
async function fundWallet(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = 'TST-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const tx = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'DEPOSIT', $4) RETURNING id`,
      [ref, userId, amount, JSON.stringify({ note: 'test-funding' })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
    await client.query(
      'INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description) VALUES ($1, $2, $3, $4, $5)',
      [tx.rows[0].id, ref, userId, amount, 'Test funding']
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function wallet(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (104_saccos_credit)');
  const appCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_applications'`);
  const appOk = ['requested_amount', 'term_months', 'status', 'reference_id'].every((c) => appCols.rows.some((r) => r.column_name === c));
  await expect(appOk, 'saccos_loan_applications columns present');

  const loanCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loans'`);
  const loanOk = ['application_id', 'principal', 'interest_rate', 'total_repayable', 'amount_outstanding', 'status'].every((c) => loanCols.rows.some((r) => r.column_name === c));
  await expect(loanOk, 'saccos_loans columns present');

  const repCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_repayments'`);
  const repOk = ['loan_id', 'principal_part', 'interest_part', 'reference_id'].every((c) => repCols.rows.some((r) => r.column_name === c));
  await expect(repOk, 'saccos_loan_repayments columns present');

  // ---------- 2. Setup ----------
  await section('Setup: auto-disburse org + member');
  const ownerReg = await register(phone(4001), 'Mikopo Haya');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, {
    name: 'Asasi Mikopo ' + suffix,
    config: { lending: { interestRate: 12, minAmount: 20000, maxAmount: 200000, maxTermMonths: 12, maxActiveLoans: 1, autoDisburse: true } },
  });
  await expect(create.status === 201, 'owner creates SACCOS with lending config');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  const mReg = await register(phone(4002), 'M Mikopo');
  const mTok = mReg.data.token;
  const mInv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(4002) });
  await api('POST', `/api/saccos/${orgId}/members/${mInv.data.result.id}/accept`, mTok);
  await fundWallet(mReg.data.user.id, 300000);

  // ---------- 3. Application guards ----------
  await section('Application guards');
  const badAmt = await api('POST', `/api/saccos/${orgId}/loans/apply`, mTok, { amount: -50, termMonths: 12 });
  await expect(badAmt.status === 400 && badAmt.data.code === 'SACCOS_LOAN_AMOUNT_INVALID', 'apply -50 -> SACCOS_LOAN_AMOUNT_INVALID');
  const belowMin = await api('POST', `/api/saccos/${orgId}/loans/apply`, mTok, { amount: 5000, termMonths: 12 });
  await expect(belowMin.status === 400 && belowMin.data.code === 'SACCOS_LOAN_BELOW_MIN', 'apply 5000 (min 20000) -> SACCOS_LOAN_BELOW_MIN');
  const aboveMax = await api('POST', `/api/saccos/${orgId}/loans/apply`, mTok, { amount: 300000, termMonths: 12 });
  await expect(aboveMax.status === 400 && aboveMax.data.code === 'SACCOS_LOAN_ABOVE_MAX', 'apply 300000 (max 200000) -> SACCOS_LOAN_ABOVE_MAX');
  const longTerm = await api('POST', `/api/saccos/${orgId}/loans/apply`, mTok, { amount: 100000, termMonths: 24 });
  await expect(longTerm.status === 400 && longTerm.data.code === 'SACCOS_LOAN_TERM_TOO_LONG', 'term 24 (> max 12) -> SACCOS_LOAN_TERM_TOO_LONG');

  const apply = await api('POST', `/api/saccos/${orgId}/loans/apply`, mTok, { amount: 100000, termMonths: 12, purpose: 'Boda' });
  await expect(apply.status === 201 && String(apply.data.result.reference_id).startsWith('SCL-') && apply.data.result.status === 'PENDING',
    'valid apply 100000/12m -> SCL-* PENDING', `${apply.status}/${apply.data.code || ''}`);
  const appId = apply.data.result.id;

  // ---------- 4. Auto-disburse approval ----------
  await section('Auto-disburse approval + disbursement ledger');
  const memberDecide = await api('POST', `/api/saccos/${orgId}/loans/applications/${appId}/approve`, mTok);
  await expect(memberDecide.status === 403 && memberDecide.data.code === 'SACCOS_RBAC', 'plain MEMBER cannot approve -> 403');

  const before = await wallet(mReg.data.user.id);
  const approve = await api('POST', `/api/saccos/${orgId}/loans/applications/${appId}/approve`, ownerTok);
  await expect(approve.status === 200 && approve.data.result.status === 'APPROVED', 'OWNER approves (autoDisburse)');

  const loanRow = await pool.query(`SELECT * FROM saccos_loans WHERE application_id = $1`, [appId]);
  await expect(loanRow.rows.length === 1 && loanRow.rows[0].status === 'ACTIVE' && Number(loanRow.rows[0].principal) === 100000
    && Number(loanRow.rows[0].total_repayable) === 112000 && Number(loanRow.rows[0].interest_rate) === 12,
    'loan ACTIVE, principal 100000, flat interest 12% 12m -> total 112000', JSON.stringify(loanRow.rows[0]).slice(0, 120));
  const lnsRef = loanRow.rows[0].reference_id;
  await expect((await wallet(mReg.data.user.id)) === before + 100000, 'wallet credited +100000');

  const disbJournal = await pool.query(
    `SELECT j.direction, j.amount, l.account_code FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE j.reference_id = $1 ORDER BY j.direction`, [lnsRef]);
  const drR = disbJournal.rows.find((r) => r.direction === 'DR' && r.account_code === `SACCOS${orgId}_LOANS_RECEIVABLE`);
  const crC = disbJournal.rows.find((r) => r.direction === 'CR' && r.account_code === 'CUSTOMER_WALLET');
  await expect(drR && crC && Number(drR.amount) === 100000 && Number(crC.amount) === 100000,
    'disbursement journal DR LOANS_RECEIVABLE / CR CUSTOMER_WALLET (100k)',
    JSON.stringify(disbJournal.rows.map((r) => `${r.account_code}:${r.direction}:${r.amount}`)));

  const disbTxn = await pool.query(`SELECT type FROM transactions WHERE reference_id = $1`, [lnsRef]);
  await expect(disbTxn.rows.length === 1 && disbTxn.rows[0].type === 'SACCOS_LOAN_DISBURSEMENT', 'transactions SACCOS_LOAN_DISBURSEMENT row');

  const appAfter = await pool.query(`SELECT status, loan_id FROM saccos_loan_applications WHERE id = $1`, [appId]);
  await expect(appAfter.rows[0].status === 'DISBURSED' && appAfter.rows[0].loan_id === loanRow.rows[0].id, 'application DISBURSED linked to loan');

  const atLimit = await api('POST', `/api/saccos/${orgId}/loans/apply`, mTok, { amount: 50000, termMonths: 6 });
  await expect(atLimit.status === 400 && atLimit.data.code === 'SACCOS_LOANS_AT_LIMIT', 'second apply with 1 active loan -> SACCOS_LOANS_AT_LIMIT');

  const dupApprove = await api('POST', `/api/saccos/${orgId}/loans/applications/${appId}/approve`, ownerTok);
  await expect(dupApprove.status === 400 && dupApprove.data.code === 'SACCOS_LOAN_APPLICATION_DECIDED', 're-approve -> SACCOS_LOAN_APPLICATION_DECIDED');

  // ---------- 5. Repayments ----------
  await section('Repayments (principal/interest split)');
  const loanId = loanRow.rows[0].id;
  const balBefore = await wallet(mReg.data.user.id);
  const repay = await api('POST', `/api/saccos/${orgId}/loans/${loanId}/repay`, mTok, { amount: 10000 });
  await expect(repay.status === 201 && repay.data.result.principalPart === 8928.57 && repay.data.result.interestPart === 1071.43
    && repay.data.result.outstanding === 102000 && repay.data.result.closed === false,
    'repay 10000 -> principal 8928.57 / interest 1071.43 / outstanding 102000', JSON.stringify(repay.data.result));
  await expect((await wallet(mReg.data.user.id)) === balBefore - 10000, 'wallet debited 10000');

  const repJournal = await pool.query(
    `SELECT j.direction, j.amount, l.account_code FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE j.reference_id = $1 ORDER BY l.account_code`, [repay.data.result.reference]);
  const drW = repJournal.rows.find((r) => r.direction === 'DR' && r.account_code === 'CUSTOMER_WALLET');
  const crR = repJournal.rows.find((r) => r.direction === 'CR' && r.account_code === `SACCOS${orgId}_LOANS_RECEIVABLE`);
  const crI = repJournal.rows.find((r) => r.direction === 'CR' && r.account_code === `SACCOS${orgId}_INTEREST_INCOME`);
  await expect(drW && crR && crI && Number(drW.amount) === 10000 && Number(crR.amount) === 8928.57 && Number(crI.amount) === 1071.43,
    'repayment journal DR wallet 10000 / CR receivable 8928.57 / CR interest 1071.43',
    JSON.stringify(repJournal.rows.map((r) => `${r.account_code}:${r.direction}:${r.amount}`)));

  const repTxn = await pool.query(`SELECT type FROM transactions WHERE reference_id = $1`, [repay.data.result.reference]);
  await expect(repTxn.rows.length === 1 && repTxn.rows[0].type === 'SACCOS_LOAN_REPAYMENT', 'transactions SACCOS_LOAN_REPAYMENT row');

  const repayList = await api('GET', `/api/saccos/${orgId}/loans/${loanId}/repayments`, ownerTok);
  await expect(repayList.status === 200 && repayList.data.result.length === 1 && repayList.data.result[0].amount === 10000,
    'owner lists loan repayments');

  const overRepay = await api('POST', `/api/saccos/${orgId}/loans/${loanId}/repay`, mTok, { amount: 200000 });
  await expect(overRepay.status === 400 && overRepay.data.code === 'SACCOS_LOAN_REPAY_EXCEEDS', 'repay 200000 (> outstanding) -> SACCOS_LOAN_REPAY_EXCEEDS');

  const close = await api('POST', `/api/saccos/${orgId}/loans/${loanId}/repay`, mTok, { amount: 102000 });
  await expect(close.status === 201 && close.data.result.closed === true && close.data.result.outstanding === 0,
    'repay 102000 -> loan CLOSED outstanding 0');

  const closedLoan = await pool.query(`SELECT status FROM saccos_loans WHERE id = $1`, [loanId]);
  const closedApp = await pool.query(`SELECT status FROM saccos_loan_applications WHERE id = $1`, [appId]);
  await expect(closedLoan.rows[0].status === 'CLOSED' && closedApp.rows[0].status === 'REPAID', 'loan CLOSED + application REPAID');

  const repayClosed = await api('POST', `/api/saccos/${orgId}/loans/${loanId}/repay`, mTok, { amount: 1000 });
  await expect(repayClosed.status === 400 && repayClosed.data.code === 'SACCOS_LOAN_ALREADY_CLOSED', 'repay after CLOSED -> SACCOS_LOAN_ALREADY_CLOSED');

  const summary = await api('GET', `/api/saccos/${orgId}/loans/summary`, ownerTok);
  await expect(summary.status === 200 && Number(summary.data.result.principal_repaid) === 100000 && Number(summary.data.result.interest_earned) === 12000
    && summary.data.result.active_loans === 0 && Number(summary.data.result.outstanding) === 0,
    'summary principal_repaid 100000 / interest_earned 12000 / 0 active');

  // ---------- 6. Manual disburse + reject + insufficient ----------
  await section('Manual disburse (autoDisburse=false)');
  const o2 = await register(phone(4003), 'S2 Mikopo');
  const o2Tok = o2.data.token;
  const s2 = await api('POST', '/api/v1/saccos', o2Tok, {
    name: 'Mkopo Makini ' + suffix,
    config: { lending: { interestRate: 10, minAmount: 10000, maxActiveLoans: 3, autoDisburse: false } },
  });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);

  const fReg = await register(phone(4004), 'F Mikopo');
  const fTok = fReg.data.token;
  const fInv = await api('POST', `/api/saccos/${s2Id}/members`, o2Tok, { phoneNumber: phone(4004) });
  await api('POST', `/api/saccos/${s2Id}/members/${fInv.data.result.id}/accept`, fTok);
  await fundWallet(fReg.data.user.id, 20000);

  const g_apply = await api('POST', `/api/saccos/${s2Id}/loans/apply`, fTok, { amount: 20000, termMonths: 12 });
  const g_appId = g_apply.data.result.id;
  const fBal = await wallet(fReg.data.user.id);
  const g_approve = await api('POST', `/api/saccos/${s2Id}/loans/applications/${g_appId}/approve`, o2Tok);
  await expect(g_approve.status === 200 && g_approve.data.result.status === 'APPROVED', 'gated: OWNER approves -> APPROVED');
  const g_loan = await pool.query(`SELECT * FROM saccos_loans WHERE application_id = $1`, [g_appId]);
  await expect(g_loan.rows[0].status === 'PENDING', 'gated: loan created PENDING (not disbursed)');
  await expect((await wallet(fReg.data.user.id)) === fBal, 'gated: wallet unchanged before disbursement');

  const g_loanId = g_loan.rows[0].id;
  const memberDisburse = await api('POST', `/api/saccos/${s2Id}/loans/${g_loanId}/disburse`, fTok);
  await expect(memberDisburse.status === 403 && memberDisburse.data.code === 'SACCOS_RBAC', 'gated: member cannot disburse -> 403');

  const missingLoan = await api('POST', `/api/saccos/${s2Id}/loans/999999/disburse`, o2Tok);
  await expect(missingLoan.status === 404 && missingLoan.data.code === 'SACCOS_LOAN_NOT_FOUND', 'unknown loan disburse -> 404');

  const disburse = await api('POST', `/api/saccos/${s2Id}/loans/${g_loanId}/disburse`, o2Tok);
  await expect(disburse.status === 200 && disburse.data.result.status === 'ACTIVE', 'OWNER disburses -> ACTIVE');
  await expect((await wallet(fReg.data.user.id)) === fBal + 20000, 'gated: wallet credited +20000 on disbursement');

  const reDisburse = await api('POST', `/api/saccos/${s2Id}/loans/${g_loanId}/disburse`, o2Tok);
  await expect(reDisburse.status === 400 && reDisburse.data.code === 'SACCOS_LOAN_NOT_DISBURSABLE', 're-disburse ACTIVE -> SACCOS_LOAN_NOT_DISBURSABLE');

  await pool.query('UPDATE users SET wallet_balance = 499 WHERE id = $1', [fReg.data.user.id]);
  const insufficient = await api('POST', `/api/saccos/${s2Id}/loans/${g_loanId}/repay`, fTok, { amount: 5000 });
  await expect(insufficient.status === 400 && insufficient.data.code === 'WALLET_INSUFFICIENT_FUNDS', 'wallet 499 -> repay 5000 -> WALLET_INSUFFICIENT_FUNDS');
  await fundWallet(fReg.data.user.id, 20000);

  const g_rejectApply = await api('POST', `/api/saccos/${s2Id}/loans/apply`, fTok, { amount: 15000, termMonths: 6 });
  await expect(g_rejectApply.status === 201 && g_rejectApply.data.result.status === 'PENDING', 'gated: second application PENDING');
  const g_rejId = g_rejectApply.data.result.id;
  const memberReject = await api('POST', `/api/saccos/${s2Id}/loans/applications/${g_rejId}/reject`, fTok);
  await expect(memberReject.status === 403 && memberReject.data.code === 'SACCOS_RBAC', 'gated: member cannot reject -> 403');
  const reject = await api('POST', `/api/saccos/${s2Id}/loans/applications/${g_rejId}/reject`, o2Tok);
  await expect(reject.status === 200 && reject.data.result.status === 'REJECTED', 'OWNER rejects application -> REJECTED');
  const rejCheck = await pool.query(`SELECT status FROM saccos_loan_applications WHERE id = $1`, [g_rejId]);
  await expect(rejCheck.rows[0].status === 'REJECTED', 'application row REJECTED (no loan)');
  const dupReject = await api('POST', `/api/saccos/${s2Id}/loans/applications/${g_rejId}/reject`, o2Tok);
  await expect(dupReject.status === 400 && dupReject.data.code === 'SACCOS_LOAN_APPLICATION_DECIDED', 're-reject -> SACCOS_LOAN_APPLICATION_DECIDED');

  // ---------- 7. Isolation + oversight ----------
  await section('Isolation + oversight');
  const cross = await api('GET', `/api/saccos/${s2Id}/loans/applications`, ownerTok);
  await expect(cross.status === 404, 'S1 owner cannot read S2 loan applications -> 404');
  const crossRepay = await api('POST', `/api/saccos/${orgId}/loans/${loanId}/repay`, fTok, { amount: 1000 });
  await expect(crossRepay.status === 404, 'S2 member cannot repay S1 loan (not a member) -> 404');

  const codes = await pool.query(
    `SELECT account_code FROM ledger_accounts WHERE account_code IN ($1,$2,$3,$4)`,
    [`SACCOS${orgId}_LOANS_RECEIVABLE`, `SACCOS${orgId}_INTEREST_INCOME`, `SACCOS${s2Id}_LOANS_RECEIVABLE`, `SACCOS${s2Id}_INTEREST_INCOME`]);
  await expect(codes.rows.length === 4, 'per-entity ASSET + REVENUE codes distinct');

  const adminTok = await makeAdmin(await register(phone(4005), 'O Mikopo'));
  const adminView = await api('GET', `/api/saccos/${s2Id}/loans/applications`, adminTok);
  await expect(adminTok && adminView.status === 200 && adminView.data.result.length === 2, 'platform ADMIN cross-reads loan applications');
  const adminSummary = await api('GET', `/api/saccos/${s2Id}/loans/summary`, adminTok);
  await expect(adminSummary.status === 200 && Number(adminSummary.data.result.principal_outstanding) === 20000, 'platform ADMIN reads loan summary');

  const mine = await api('GET', `/api/saccos/${s2Id}/loans/mine`, fTok);
  await expect(mine.status === 200 && mine.data.result.applications.length === 2 && mine.data.result.loans[0].status === 'ACTIVE',
    'member sees own applications + loans');

  const audit = await pool.query(`SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'SACCOS_LOAN%'`);
  await expect(audit.rows.length >= 4, 'audit trail has loan actions');

  console.log(`\nSACCOS CREDIT: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });