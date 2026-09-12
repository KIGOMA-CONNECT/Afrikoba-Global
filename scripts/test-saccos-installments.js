/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - LOAN INSTALLMENTS &
 * INTEREST ACCRUAL (increment 12, suite 56)
 *
 * Per-loan repayment schedule (term_months rows splitting principal
 * and interest exactly) generated lazily/idempotently or explicitly
 * by OWNER/BOARD; ordered installment payment journaled on the shared
 * ledger (DR wallet / CR loans receivable + CR interest income),
 * outstanding decremented, loan CLOSED + application REPAID at zero.
 * Idempotent REPI-* claims, RBAC (own loan / governing / platform
 * ADMIN), cross-entity 404, schema evidence, ledger + audit trails.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0, failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) { failed++; failures.push(label); console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`); }
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra); }
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET';
  const res = await fetch(BASE + path, { method, headers, body: !isGet && body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}
async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  let token = null;
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) { token = refresh.data.token; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  let probe = token ? await api('GET', '/api/saccos', token) : null;
  for (let attempt = 0; probe && probe.status === 401 && attempt < 3; attempt++) {
    const otp = await sendOtp(reg.data.user.phone_number);
    const login = await api('POST', '/api/auth/login', null, { phoneNumber: reg.data.user.phone_number, otp });
    token = login.data.token;
    probe = token ? await api('GET', '/api/saccos', token) : null;
  }
  return token;
}
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = $2 WHERE id = $1', [userId, amount]);
}
function nowSuffix() { return String(Date.now()).slice(-6); }

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (112_saccos_loan_installments)');
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_installments'`);
  await expect(['loan_id', 'member_id', 'installment_no', 'due_date', 'principal_part', 'interest_part', 'total', 'status', 'paid_at', 'reference_id'].every((c) => cols.rows.some((r) => r.column_name === c)),
    'saccos_loan_installments columns present');

  // ---------- 2. Setup ----------
  await section('Setup: SACCOS + members + funded wallets');
  const ownerReg = await register(phone(7701), 'Awamu Mkuu');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Awamu Yetu ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  async function member(pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return { tok: reg.data.token, userId: reg.data.user.id };
  }
  const m1 = await member(7702, 'Awamu 1');
  const m2 = await member(7703, 'Awamu 2');
  await fundWallet(m1.userId, 200000);
  await fundWallet(m2.userId, 300000);

  // ---------- 3. Loan + lazy schedule ----------
  await section('Loan + automatic (lazy) installment schedule');
  const loan = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 30000, termMonths: 3, purpose: 'Biashara' });
  await expect(loan.status === 201, 'm1 applies for loan 30000');
  const approved = await api('POST', `/api/saccos/${orgId}/loans/applications/${loan.data.result.id}/approve`, ownerTok);
  await expect(approved.status === 200 && approved.data.result.decision === 'APPROVE', 'owner approves (auto-disburses) loan');
  const mine = await api('GET', `/api/saccos/${orgId}/loans/mine`, m1.tok);
  const loanRow = mine.data.result.loans[0];
  await expect(loanRow && loanRow.status === 'ACTIVE' && Number(loanRow.amount_outstanding) === 30900, 'loan ACTIVE, outstanding 30900');

  const list = await api('GET', `/api/saccos/${orgId}/loans/${loanRow.id}/installments`, m1.tok);
  await expect(list.status === 200 && list.data.result.installments.length === 3, 'lazy schedule materialised: 3 installments');
  const [i1, i2, i3] = list.data.result.installments;
  await expect(Number(i1.principal_part) === 10000 && Number(i1.interest_part) === 300 && Number(i1.total) === 10300,
    'installment 1 = 10000 principal + 300 interest (10300)');
  await expect(Number(i2.interest_part) === 300 && Number(i3.principal_part) === 10000 && Number(i3.interest_part) === 300,
    'parts sum to principal 30000 + interest 900');
  await expect(i1.status === 'PENDING' && i1.due_date && list.data.result.total === 30900, 'installments PENDING with due dates');

  const repeated = await api('GET', `/api/saccos/${orgId}/loans/${loanRow.id}/installments`, m1.tok);
  await expect(repeated.status === 200 && repeated.data.result.installments.length === 3, 'schedule idempotent (no duplicates)');

  // ---------- 4. Ordered payments ----------
  await section('Ordered installment payments (ledgered)');
  const outOfOrder = await api('POST', `/api/saccos/${orgId}/loans/${loanRow.id}/installments/${i3.id}/pay`, m1.tok);
  await expect(outOfOrder.status === 400 && outOfOrder.data.code === 'SACCOS_LOAN_INSTALLMENT_ORDER', 'paying installment 3 first -> 400 ORDER');

  const pay1 = await api('POST', `/api/saccos/${orgId}/loans/${loanRow.id}/installments/${i1.id}/pay`, m1.tok);
  await expect(pay1.status === 200 && pay1.data.result.amount === 10300 && pay1.data.result.outstanding === 20600,
    'pay installment 1 -> outstanding 20600');
  const dup = await api('POST', `/api/saccos/${orgId}/loans/${loanRow.id}/installments/${i1.id}/pay`, m1.tok);
  await expect(dup.status === 400 && dup.data.code === 'SACCOS_LOAN_INSTALLMENT_ALREADY_PAID', 'duplicate pay -> 400 ALREADY_PAID');

  const pay2 = await api('POST', `/api/saccos/${orgId}/loans/${loanRow.id}/installments/${i2.id}/pay`, m1.tok);
  await expect(pay2.status === 200 && pay2.data.result.outstanding === 10300, 'pay installment 2 -> outstanding 10300');

  const pay3 = await api('POST', `/api/saccos/${orgId}/loans/${loanRow.id}/installments/${i3.id}/pay`, m1.tok);
  await expect(pay3.status === 200 && pay3.data.result.closed === true && pay3.data.result.outstanding === 0,
    'pay installment 3 -> loan CLOSED at zero');

  const w1 = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.userId]);
  await expect(Number(w1.rows[0].wallet_balance) === 200000 + 30000 - 30900, 'wallet = funding + disbursed 30000 - payments 30900');

  const loanAfter = await pool.query(`SELECT status, amount_outstanding, repaid_at FROM saccos_loans WHERE id = $1`, [loanRow.id]);
  await expect(loanAfter.rows[0].status === 'CLOSED' && Number(loanAfter.rows[0].amount_outstanding) === 0 && loanAfter.rows[0].repaid_at,
    'loan row CLOSED, repaid_at set');
  const appAfter = await pool.query(`SELECT status FROM saccos_loan_applications WHERE id = $1`, [loan.data.result.id]);
  await expect(appAfter.rows[0].status === 'REPAID', 'application REPAID');

  const inst = await pool.query(`SELECT status FROM saccos_loan_installments WHERE loan_id = $1 ORDER BY installment_no`, [loanRow.id]);
  await expect(inst.rows.every((r) => r.status === 'PAID'), 'all installments PAID');
  const refs = await pool.query(`SELECT reference_id FROM saccos_loan_installments WHERE loan_id = $1 AND reference_id IS NOT NULL`, [loanRow.id]);
  await expect(refs.rows.length === 3 && refs.rows.every((r) => /^REPI-/.test(r.reference_id)), 'REPI-* references recorded');

  // ---------- 5. Ledger + audit ----------
  await section('Ledger + audit evidence');
  const interest = await pool.query(
    `SELECT (COALESCE(SUM(CASE WHEN j.direction = 'CR' THEN j.amount ELSE 0 END),0) - COALESCE(SUM(CASE WHEN j.direction = 'DR' THEN j.amount ELSE 0 END),0))::numeric AS bal
     FROM journal_entries j JOIN ledger_accounts la ON la.id = j.account_id WHERE la.account_code = $1`, [`SACCOS${orgId}_INTEREST_INCOME`]
  );
  await expect(Number(interest.rows[0].bal) === 900, 'INTEREST_INCOME ledger 900 (CR-DR)');
  const receivable = await pool.query(
    `SELECT (COALESCE(SUM(CASE WHEN j.direction = 'DR' THEN j.amount ELSE 0 END),0) - COALESCE(SUM(CASE WHEN j.direction = 'CR' THEN j.amount ELSE 0 END),0))::numeric AS bal
     FROM journal_entries j JOIN ledger_accounts la ON la.id = j.account_id WHERE la.account_code = $1`, [`SACCOS${orgId}_LOANS_RECEIVABLE`]
  );
  await expect(Number(receivable.rows[0].bal) === 0, 'LOANS_RECEIVABLE ledger back to 0');
  const txns = await pool.query(`SELECT COUNT(*)::int AS c FROM transactions WHERE type = 'SACCOS_LOAN_INSTALLMENT_PAYMENT' AND user_id = $1`, [m1.userId]);
  await expect(txns.rows[0].c === 3, '3 SACCOS_LOAN_INSTALLMENT_PAYMENT transactions');
  const audit = await pool.query(`SELECT action FROM audit_logs WHERE action = 'SACCOS_LOAN_INSTALLMENT_PAYMENT'`);
  await expect(audit.rows.length >= 3, 'audit trail records installment payments');

  // ---------- 6. Explicit generate + summary ----------
  await section('Explicit generation (OWNER/BOARD) + summary');
  const loan2 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m2.tok, { amount: 12000, termMonths: 2, purpose: 'Ajira' });
  await api('POST', `/api/saccos/${orgId}/loans/applications/${loan2.data.result.id}/approve`, ownerTok);
  const mine2 = await api('GET', `/api/saccos/${orgId}/loans/mine`, m2.tok);
  const loan2Row = mine2.data.result.loans[0];
  const gen = await api('POST', `/api/saccos/${orgId}/loans/${loan2Row.id}/installments/generate`, ownerTok);
  await expect(gen.status === 200 && gen.data.result.count === 2 && Number(gen.data.result.installments[0].total) === 6120,
    'owner explicit generate: 2 installments of 6120');
  const genDup = await api('POST', `/api/saccos/${orgId}/loans/${loan2Row.id}/installments/generate`, ownerTok);
  await expect(genDup.status === 400 && genDup.data.code === 'SACCOS_LOAN_INSTALLMENTS_EXIST', 'regenerate -> 400 INSTALLMENTS_EXIST');
  const genByBoard = await register(phone(7704), 'Bodi Awamu');
  const invb = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(7704) });
  await api('POST', `/api/saccos/${orgId}/members/${invb.data.result.id}/accept`, genByBoard.data.token);
  await pool.query(`UPDATE saccos_members SET role = 'BOARD' WHERE saccos_id = $1 AND user_id = $2`, [orgId, genByBoard.data.user.id]);
  const gen2 = await api('POST', `/api/saccos/${orgId}/loans/${loan2Row.id}/installments/generate`, genByBoard.data.token);
  await expect(gen2.status === 400, 'BOARD regenerate rejected (already exists)');

  const summary = await api('GET', `/api/saccos/${orgId}/loans/installments/summary`, ownerTok);
  await expect(summary.status === 200 && summary.data.result.total === 5 && summary.data.result.paid === 3
    && Number(summary.data.result.paid_total) === 30900 && Number(summary.data.result.due_total) === 12240,
    'summary: 5 total, 3 paid, paid 30900, due 12240', JSON.stringify(summary.data.result));
  const summaryMember = await api('GET', `/api/saccos/${orgId}/loans/installments/summary`, m1.tok);
  await expect(summaryMember.status === 403, 'member reading summary -> 403');

  // ---------- 7. RBAC + isolation ----------
  await section('RBAC + cross-entity isolation');
  const rbac = await api('GET', `/api/saccos/${orgId}/loans/${loanRow.id}/installments`, m2.tok);
  await expect(rbac.status === 403, 'sibling member reading m1 installments -> 403');
  const s2Owner = await register(phone(7705), 'Awamu Pili');
  const s2Tok = s2Owner.data.token;
  const org2 = await api('POST', '/api/v1/saccos', s2Tok, { name: 'Awamu Pili ' + suffix });
  const s2Id = org2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, s2Tok);
  const cross = await api('GET', `/api/saccos/${orgId}/loans/${loanRow.id}/installments`, s2Tok);
  await expect(cross.status === 404, 'S2 owner listing S1 loan installments -> 404');
  const adminTok = await makeAdmin(await register(phone(7706), 'Ododo Awamu'));
  const adminPay = await api('POST', `/api/saccos/${orgId}/loans/${loan2Row.id}/installments/${gen.data.result.installments[0].id}/pay`, adminTok);
  await expect(adminTok && adminPay.status === 403 && adminPay.data.code === 'SACCOS_NOT_MEMBER', 'platform ADMIN without membership cannot pay (403)');

  console.log(`\nSACCOS INSTALLMENTS: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });