/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - OVERDUE ARREARS &
 * LATE-FEE ACCRUAL (increment 13, suite 57)
 *
 * Completes the OVERDUE lifecycle of installments (migration 113):
 * PENDING installments past the grace window are flipped OVERDUE
 * with days_late + late_fee = total * lateFeePercent% * ceil(days/30)
 * accrued deterministically on read / board-recompute. Paying an
 * OVERDUE installment charges total + late_fee with an extra ledger
 * leg CR SACCOS<id>_LATE_FEE_INCOME; the fee is income and never
 * reduces amount_outstanding. Grace (saccos.config.lending.graceDays)
 * keeps recent misses PENDING. Arrears are OWNER/BOARD-scoped.
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
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = $2 WHERE id = $1', [userId, amount]);
}
function nowSuffix() { return String(Date.now()).slice(-6); }

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (113_saccos_installment_arrears)');
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_installments'`
  );
  await expect(['days_late', 'late_fee'].every((c) => cols.rows.some((r) => r.column_name === c)),
    'saccos_loan_installments.days_late + late_fee columns present');

  // ---------- 2. Setup ----------
  await section('Setup: SACCOS + members + funded wallets');
  const ownerReg = await register(phone(8801), 'Deni Mwenyezi');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Deni Yetu ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  async function member(pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return { tok: reg.data.token, userId: reg.data.user.id };
  }
  const m1 = await member(8802, 'Deni 1');
  const m2 = await member(8803, 'Deni 2');
  await fundWallet(m1.userId, 200000);
  await fundWallet(m2.userId, 300000);

  // ---------- 3. Loan + backdated installment (overdue) ----------
  await section('Loan + overdue detection on read');
  const loan = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 12000, termMonths: 2, purpose: 'Deni' });
  await expect(loan.status === 201, 'm1 applies for loan 12000');
  await api('POST', `/api/saccos/${orgId}/loans/applications/${loan.data.result.id}/approve`, ownerTok);
  const mine = await api('GET', `/api/saccos/${orgId}/loans/mine`, m1.tok);
  const loanRow = mine.data.result.loans[0];
  await expect(loanRow && loanRow.status === 'ACTIVE' && Number(loanRow.amount_outstanding) === 12240, 'loan ACTIVE, outstanding 12240');
  const seed1 = await api('GET', `/api/saccos/${orgId}/loans/${loanRow.id}/installments`, m1.tok);
  await expect(seed1.status === 200 && seed1.data.result.installments.length === 2, 'schedule materialised (seeded)');
  await pool.query(`UPDATE saccos_loan_installments SET due_date = CURRENT_DATE - 40 WHERE loan_id = $1 AND installment_no = 1`, [loanRow.id]);
  await pool.query(`UPDATE saccos_loan_installments SET due_date = CURRENT_DATE + 10 WHERE loan_id = $1 AND installment_no = 2`, [loanRow.id]);

  const list = await api('GET', `/api/saccos/${orgId}/loans/${loanRow.id}/installments`, m1.tok);
  if (!list.data.result) {
    await expect(false, 'installment list succeeded', JSON.stringify(list.data));
  }
  const [i1, i2] = list.data.result.installments;
  await expect(list.status === 200 && list.data.result.installments.length === 2, '2 installments listed');
  await expect(i1.status === 'OVERDUE' && i1.days_late === 40 && Number(i1.late_fee) === 244.8,
    'installment 1 auto-marked OVERDUE (40 days, late fee 244.8)', JSON.stringify({ status: i1.status, d: i1.days_late, f: i1.late_fee }));
  await expect(i2.status === 'PENDING' && Number(i2.late_fee) === 0, 'installment 2 (future) stays PENDING, no fee');
  await expect(list.data.result.summary.overdue === 1 && Number(list.data.result.summary.lateFees) === 244.8,
    'list summary: 1 overdue, late fees 244.8');

  // ---------- 4. Paying the overdue installment ----------
  await section('Paying an overdue installment charges the late fee + income');
  const pay1 = await api('POST', `/api/saccos/${orgId}/loans/${loanRow.id}/installments/${i1.id}/pay`, m1.tok);
  await expect(pay1.status === 200 && Number(pay1.data.result.amount) === 6364.8 && Number(pay1.data.result.lateFee) === 244.8
    && pay1.data.result.outstanding === 6120,
    'pay overdue installment: 6120 + 244.8 late fee, outstanding 6120', JSON.stringify(pay1.data.result || pay1.data));
  const dup = await api('POST', `/api/saccos/${orgId}/loans/${loanRow.id}/installments/${i1.id}/pay`, m1.tok);
  await expect(dup.status === 400 && dup.data.code === 'SACCOS_LOAN_INSTALLMENT_ALREADY_PAID', 'duplicate pay -> 400 ALREADY_PAID');

  const fee = await pool.query(
    `SELECT (COALESCE(SUM(CASE WHEN j.direction = 'CR' THEN j.amount ELSE 0 END),0) - COALESCE(SUM(CASE WHEN j.direction = 'DR' THEN j.amount ELSE 0 END),0))::numeric AS bal
     FROM journal_entries j JOIN ledger_accounts la ON la.id = j.account_id WHERE la.account_code = $1`, [`SACCOS${orgId}_LATE_FEE_INCOME`]
  );
  await expect(Number(fee.rows[0].bal) === 244.8, 'LATE_FEE_INCOME ledger 244.8 (CR-DR)');

  const pay2 = await api('POST', `/api/saccos/${orgId}/loans/${loanRow.id}/installments/${i2.id}/pay`, m1.tok);
  await expect(pay2.status === 200 && pay2.data.result.closed === true && Number(pay2.data.result.lateFee) === 0,
    'pay installment 2 (6120, no fee) -> loan CLOSED');

  const interest = await pool.query(
    `SELECT (COALESCE(SUM(CASE WHEN j.direction = 'CR' THEN j.amount ELSE 0 END),0) - COALESCE(SUM(CASE WHEN j.direction = 'DR' THEN j.amount ELSE 0 END),0))::numeric AS bal
     FROM journal_entries j JOIN ledger_accounts la ON la.id = j.account_id WHERE la.account_code = $1`, [`SACCOS${orgId}_INTEREST_INCOME`]
  );
  await expect(Number(interest.rows[0].bal) === 240, 'INTEREST_INCOME ledger 240 (two 120 parts)');
  const w1 = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.userId]);
  await expect(Number(w1.rows[0].wallet_balance) === 200000 + 12000 - 6364.8 - 6120,
    'wallet = funding + disbursed 12000 - (6364.8 + 6120)');

  // ---------- 5. Grace window keeps recent misses PENDING ----------
  await section('Grace window (graceDays)');
  await pool.query(
    `UPDATE saccos SET config = COALESCE(config, '{}') || '{"lending": {"graceDays": 10}}'::jsonb WHERE id = $1`, [orgId]
  );
  const loan2 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m2.tok, { amount: 12000, termMonths: 2, purpose: 'Deni Pili' });
  await api('POST', `/api/saccos/${orgId}/loans/applications/${loan2.data.result.id}/approve`, ownerTok);
  const mine2 = await api('GET', `/api/saccos/${orgId}/loans/mine`, m2.tok);
  const loan2Row = mine2.data.result.loans[0];
  const seed2 = await api('GET', `/api/saccos/${orgId}/loans/${loan2Row.id}/installments`, m2.tok);
  await expect(seed2.status === 200 && seed2.data.result.installments.length === 2, 'loan2 schedule materialised (seeded)');
  await pool.query(`UPDATE saccos_loan_installments SET due_date = CURRENT_DATE - 5 WHERE loan_id = $1 AND installment_no = 1`, [loan2Row.id]);
  const graceList = await api('GET', `/api/saccos/${orgId}/loans/${loan2Row.id}/installments`, m2.tok);
  const g1 = graceList.data.result.installments[0];
  await expect(graceList.status === 200 && g1.status === 'PENDING' && g1.days_late === 0 && Number(g1.late_fee) === 0,
    'installment due 5 days ago with grace 10 stays PENDING (no fee)');

  // ---------- 6. RBAC on arrears ----------
  await section('Arrears RBAC');
  const rbac = await api('GET', `/api/saccos/${orgId}/loans/arrears`, m1.tok);
  await expect(rbac.status === 403 && rbac.data.code === 'SACCOS_RBAC', 'member reading arrears -> 403 RBAC');
  const rbacRec = await api('POST', `/api/saccos/${orgId}/loans/recompute-arrears`, m1.tok);
  await expect(rbacRec.status === 403 && rbacRec.data.code === 'SACCOS_RBAC', 'member recomputing arrears -> 403 RBAC');

  // ---------- 7. Board recompute + summary ----------
  await section('Board recompute + arrears summary');
  await pool.query(`UPDATE saccos_loan_installments SET due_date = CURRENT_DATE - 35 WHERE loan_id = $1 AND installment_no = 1`, [loan2Row.id]);
  const rec = await api('POST', `/api/saccos/${orgId}/loans/recompute-arrears`, ownerTok);
  await expect(rec.status === 200 && rec.data.result.changed === 1 && rec.data.result.overdue === 1
    && Number(rec.data.result.arrears_total) === 6120 && Number(rec.data.result.late_fees_total) === 244.8,
    'recompute: 1 changed, 1 overdue, arrears 6120, fees 244.8', JSON.stringify(rec.data.result));
  const audit = await pool.query(`SELECT action FROM audit_logs WHERE action = 'SACCOS_ARREARS_RECOMPUTE'`);
  await expect(audit.rows.length >= 1, 'SACCOS_ARREARS_RECOMPUTE audit recorded');

  const summ = await api('GET', `/api/saccos/${orgId}/loans/arrears`, ownerTok);
  await expect(summ.status === 200 && summ.data.result.overdue === 1 && Number(summ.data.result.arrears_total) === 6120
    && Number(summ.data.result.late_fees_total) === 244.8 && summ.data.result.total_installments === 4,
    'arrears summary: 1 overdue / 6120 / 244.8 / 4 installments', JSON.stringify(summ.data.result));

  // ---------- 8. Owner pays another member's overdue installment ----------
  await section('Owner pays any member; arrears clear');
  const ownerPay = await api('POST', `/api/saccos/${orgId}/loans/${loan2Row.id}/installments/${g1.id}/pay`, ownerTok);
  await expect(ownerPay.status === 200 && Number(ownerPay.data.result.lateFee) === 244.8 && ownerPay.data.result.outstanding === 6120,
    'owner pays m2 overdue installment (6120 + 244.8)');
  const after = await api('GET', `/api/saccos/${orgId}/loans/arrears`, ownerTok);
  await expect(after.status === 200 && after.data.result.overdue === 0 && Number(after.data.result.arrears_total) === 0
    && Number(after.data.result.late_fees_total) === 0, 'arrears cleared after payment');

  // ---------- 9. Isolation + platform admin ----------
  await section('Cross-entity isolation + platform ADMIN');
  const s2Owner = await register(phone(8804), 'Deni Pili Org');
  const s2Tok = s2Owner.data.token;
  const org2 = await api('POST', '/api/v1/saccos', s2Tok, { name: 'Deni Pili Org ' + suffix });
  const s2Id = org2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, s2Tok);
  const cross = await api('GET', `/api/saccos/${orgId}/loans/arrears`, s2Tok);
  await expect(cross.status === 403 && cross.data.code === 'SACCOS_NOT_MEMBER', 'S2 owner reading S1 arrears -> 403 NOT_MEMBER');
  const crossRec = await api('POST', `/api/saccos/${orgId}/loans/recompute-arrears`, s2Tok);
  await expect(crossRec.status === 403 && crossRec.data.code === 'SACCOS_NOT_MEMBER', 'S2 owner recomputing S1 -> 403 NOT_MEMBER');
  const adminTok = await makeAdmin(await register(phone(8805), 'Ododo Deni'));
  const adminRec = await api('POST', `/api/saccos/${orgId}/loans/recompute-arrears`, adminTok);
  await expect(adminTok && adminRec.status === 403 && adminRec.data.code === 'SACCOS_NOT_MEMBER', 'platform ADMIN without membership recompute -> 403');

  console.log(`\nSACCOS ARREARS: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });