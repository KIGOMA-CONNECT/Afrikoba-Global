/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - LOAN MANAGEMENT
 * (increment 17, suite 61)
 *
 * migration 117 adds three workstreams to the SACCOS credit module:
 *
 * GUARANTORS / CO-SIGNERS: a borrower nominates active members to
 * underwrite an application (GNT-* PENDING -> ACCEPTED -> ACTIVE on
 * disbursal). Approval requires `lending.guaranteesRequired` ACCEPTED
 * guarantees, and - when savings backing is on - each guarantor's own
 * backing limit adds to the borrower's effective capacity ('cover',
 * snapshotted as guaranteed_cover). Overdue ACTIVE guaranteed loans
 * can be recovered from the guarantor's wallet (PAID_OUT); a repaid/
 * written-off loan releases ACTIVE guarantees.
 *
 * RESTRUCTURE: OWNER/BOARD capitalise an ACTIVE balance at a new rate
 * and term (credit formula), rebuild the amortisation schedule from
 * the unpaid point onward and bump schedule_version (RST-*).
 *
 * WRITE-OFF: OWNER/BOARD extinguish an ACTIVE balance against the
 * utilised loan-loss provision first, then the un-provisioned shortfall
 * as loan-loss EXPENSE (DR reserves + DR expense / CR loans receivable,
 * WO-*). Loan + application -> WRITTEN_OFF, remaining installments
 * CANCELLED, guarantees released.
 *
 * STANDING ORDERS: monthly recurring contributions (SO-*, day 1-28)
 * into savings / an ACTIVE fund / an ACTIVE welfare scheme / an ACTIVE
 * personal loan, executed via the normal member flows. Due when
 * next_run_at is NULL or <= today; failures retry on the next trigger
 * and deactivate after 3 in a row.
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
function nowSuffix() { return String(Date.now()).slice(-6); }
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = $2 WHERE id = $1', [userId, amount]);
}
async function walletOf(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}
async function savingsBalance(saccosId, memberId) {
  const r = await pool.query('SELECT balance FROM saccos_savings_accounts WHERE saccos_id = $1 AND member_id = $2', [saccosId, memberId]);
  return r.rows.length ? Number(r.rows[0].balance) : 0;
}
async function ledgerBalance(accountCode) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE -amount END), 0)::numeric AS b
     FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id WHERE la.account_code = $1`,
    [accountCode]
  );
  return Number(r.rows[0].b);
}
async function setLendingConfig(orgId, overrides) {
  const base = {
    interestRate: 12, minAmount: 10000, maxAmount: null, maxTermMonths: 12,
    maxActiveLoans: 10, autoDisburse: true, graceDays: 0, lateFeePercent: 2,
    savingsBackingEnabled: false, savingsBackingMultiple: 3, guaranteesRequired: 0,
  };
  Object.assign(base, overrides || {});
  await pool.query(
    `UPDATE saccos SET config = COALESCE(config, '{}') || $2::jsonb WHERE id = $1`,
    [orgId, JSON.stringify({ lending: base })]
  );
}

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (117_saccos_loan_management)');
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name IN ('saccos_loan_guarantees', 'saccos_loan_restructures', 'saccos_loan_write_offs', 'saccos_standing_orders')`
  );
  await expect(new Set(tables.rows.map((r) => r.table_name)).size === 4, '4 loan-management tables exist');
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_applications' AND column_name = 'guaranteed_cover'
     UNION ALL
     SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loans' AND column_name = 'schedule_version'
     UNION ALL
     SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_loss_reserves' AND column_name = 'utilized_at'`
  );
  await expect(cols.rows.length === 3, 'guaranteed_cover + schedule_version + utilized_at columns exist');
  const chk = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conname = 'saccos_loan_installments_status_check'`
  );
  await expect(chk.rows.length === 1 && chk.rows[0].def.includes('CANCELLED'), 'installments CHECK accepts CANCELLED');
  const dayChk = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conname = 'saccos_standing_orders_day_of_month_check'`
  );
  await expect(dayChk.rows.length === 1 && dayChk.rows[0].def.includes('28'), 'standing orders day_of_month CHECK (1..28)');

  // ---------- 2. Setup ----------
  await section('Setup: SACCOS + members');
  const ownerReg = await register(phone(9301), 'Kibanda Mwenyekiti');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Jukumu Dhamana ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);
  async function member(pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    const mid = inv.data.result.id;
    await api('POST', `/api/saccos/${orgId}/members/${mid}/accept`, reg.data.token);
    return { tok: reg.data.token, userId: reg.data.user.id, memberId: mid };
  }
  const m1 = await member(9302, 'Dhamini 1');
  const m2 = await member(9303, 'Dhamini 2');
  const m3 = await member(9304, 'Dhamini 3');
  const m4 = await member(9305, 'Dhamini 4');
  await fundWallet(m1.userId, 500000);
  await fundWallet(m2.userId, 500000);
  await fundWallet(m3.userId, 10000);
  await fundWallet(m4.userId, 200000);
  await setLendingConfig(orgId, { savingsBackingEnabled: true, savingsBackingMultiple: 3, guaranteesRequired: 1, maxActiveLoans: 10 });

  // ---------- 3. Guarantors: governance, required count, cover ----------
  await section('Guarantors: governance + requirement gate + cover raise');
  const d1 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m1.tok, { amount: 50000 });
  await expect(d1.data.success === true, 'm1 deposits 50000 savings (limit 150000)');
  const bk1 = await api('GET', `/api/saccos/${orgId}/loans/backing`, m1.tok);
  await expect(bk1.data.result.backing_limit === 150000, 'm1 backing limit 150000', JSON.stringify(bk1.data.result));

  const app1 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 100000, termMonths: 6, purpose: 'Dhamana' });
  await expect(app1.status === 201 && app1.data.result.status === 'PENDING', 'm1 applies 100000 -> 201 PENDING', JSON.stringify(app1.data));
  const app1Id = app1.data.result.id;

  const add = await api('POST', `/api/saccos/${orgId}/loans/applications/${app1Id}/guarantees`, m1.tok, { guarantorMemberId: m3.memberId });
  await expect(add.status === 201 && add.data.result.reference_id.startsWith('GNT-') && add.data.result.status === 'PENDING',
    'm1 nominates m3 -> 201 PENDING GNT-*', JSON.stringify(add.data));
  const g1Id = add.data.result.id;

  const dup = await api('POST', `/api/saccos/${orgId}/loans/applications/${app1Id}/guarantees`, m1.tok, { guarantorMemberId: m3.memberId });
  await expect(dup.status === 400 && dup.data.code === 'SACCOS_LOAN_GUARANTOR_EXISTS', 'duplicate nomination -> 400 EXISTS');
  const selfG = await api('POST', `/api/saccos/${orgId}/loans/applications/${app1Id}/guarantees`, m1.tok, { guarantorMemberId: m1.memberId });
  await expect(selfG.status === 400 && selfG.data.code === 'SACCOS_LOAN_GUARANTOR_SELF', 'self guarantee -> 400 SELF');

  const reqNeeded = await api('POST', `/api/saccos/${orgId}/loans/applications/${app1Id}/approve`, ownerTok);
  await expect(reqNeeded.status === 400 && reqNeeded.data.code === 'SACCOS_LOAN_GUARANTOR_REQUIRED',
    'approve with 0 accepted guarantee -> 400 GUARANTOR_REQUIRED', JSON.stringify(reqNeeded.data));

  const acceptTok = await api('POST', `/api/saccos/${orgId}/loans/guarantees/${g1Id}/accept`, m3.tok);
  await expect(acceptTok.status === 200 && acceptTok.data.result.status === 'ACCEPTED', 'm3 accepts guarantee -> ACCEPTED');
  const wrongAccept = await api('POST', `/api/saccos/${orgId}/loans/guarantees/${g1Id}/accept`, m4.tok);
  await expect(wrongAccept.status === 403 && wrongAccept.data.code === 'SACCOS_RBAC', 'non-nominated member accepts -> 403 RBAC');
  const againAccept = await api('POST', `/api/saccos/${orgId}/loans/guarantees/${g1Id}/accept`, m3.tok);
  await expect(againAccept.status === 400 && againAccept.data.code === 'SACCOS_LOAN_GUARANTOR_STATE', 'accept again -> 400 GUARANTOR_STATE');

  const appr1 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app1Id}/approve`, ownerTok);
  await expect(appr1.status === 200 && appr1.data.success === true, 'approve succeeds with 1 accepted guarantee', JSON.stringify(appr1.data));
  const loan1Row = await pool.query(`SELECT id, status FROM saccos_loans WHERE application_id = $1`, [app1Id]);
  const loan1 = loan1Row.rows[0];
  await expect(loan1Row.rows[0].status === 'ACTIVE', 'loan 1 disburse ACTIVE');
  const g1After = await pool.query(`SELECT status, loan_id FROM saccos_loan_guarantees WHERE id = $1`, [g1Id]);
  await expect(g1After.rows[0].status === 'ACTIVE' && g1After.rows[0].loan_id === loan1.id, 'guarantee ACTIVE + loan_id set on disbursal');
  const cover1 = await pool.query(`SELECT guaranteed_cover FROM saccos_loan_applications WHERE id = $1`, [app1Id]);
  await expect(Number(cover1.rows[0].guaranteed_cover) === 0, `guaranteed_cover 0 when guarantor has no backing (${cover1.rows[0].guaranteed_cover})`);

  // --- cover raises the approval-time cap after savings drop ---
  const d2 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m2.tok, { amount: 60000 });
  await expect(d2.data.success === true, 'm2 deposits 60000 savings (own backing 180000)');
  const app2 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 100000, termMonths: 6 });
  await expect(app2.status === 201, 'm1 applies 100000 (backing 150000) -> 201');
  const app2Id = app2.data.result.id;
  const wd = await api('POST', `/api/saccos/${orgId}/savings/withdraw`, m1.tok, { amount: 40000 });
  await expect(wd.data.success === true, 'm1 withdraws 40000 (live savings 10000, backing 30000)');

  await setLendingConfig(orgId, { savingsBackingEnabled: true, savingsBackingMultiple: 3, guaranteesRequired: 0, maxActiveLoans: 10 });
  const deny2 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app2Id}/approve`, ownerTok);
  await expect(deny2.status === 400 && deny2.data.code === 'SACCOS_LOAN_BACKING_INSUFFICIENT',
    'approve with live backing 30000 < 100000 -> 400 BACKING_INSUFFICIENT', JSON.stringify(deny2.data));
  const still2 = await pool.query(`SELECT status FROM saccos_loan_applications WHERE id = $1`, [app2Id]);
  await expect(still2.rows[0].status === 'PENDING', 'application stays PENDING after voided approval');

  await setLendingConfig(orgId, { savingsBackingEnabled: true, savingsBackingMultiple: 3, guaranteesRequired: 1, maxActiveLoans: 10 });
  const add2 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app2Id}/guarantees`, m1.tok, { guarantorMemberId: m2.memberId });
  await expect(add2.status === 201, 'm1 nominates m2 -> 201');
  const g2Id = add2.data.result.id;
  const acc2 = await api('POST', `/api/saccos/${orgId}/loans/guarantees/${g2Id}/accept`, m2.tok);
  await expect(acc2.status === 200 && Number(acc2.data.result.cover_amount) === 180000,
    'm2 accepts with cover_amount 180000', JSON.stringify(acc2.data.result));
  const appr2 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app2Id}/approve`, ownerTok);
  await expect(appr2.status === 200 && appr2.data.success === true,
    'approve passes despite live backing 30000 (cover 180000 raises capacity)', JSON.stringify(appr2.data));
  const loan2Row = await pool.query(`SELECT l.id, l.status, a.backing_limit, a.guaranteed_cover
       FROM saccos_loans l JOIN saccos_loan_applications a ON a.id = l.application_id
       WHERE l.application_id = $1`, [app2Id]);
  const loan2 = loan2Row.rows[0];
  await expect(loan2Row.rows[0].status === 'ACTIVE' && Number(loan2Row.rows[0].backing_limit) === 30000
    && Number(loan2Row.rows[0].guaranteed_cover) === 180000,
    'Loan2 ACTIVE + snapshot backing 30000 + guaranteed_cover 180000', JSON.stringify(loan2Row.rows[0]));

  const g2After = await pool.query(`SELECT status FROM saccos_loan_guarantees WHERE id = $1`, [g2Id]);
  await expect(g2After.rows[0].status === 'ACTIVE', 'm2 guarantee ACTIVE on disbursal');
  const mine = await api('GET', `/api/saccos/${orgId}/loans/guarantees/mine`, m2.tok);
  await expect(mine.status === 200 && mine.data.result.length === 1 && mine.data.result[0].status === 'ACTIVE'
    && mine.data.result[0].borrower_name.includes('Dhamini 1'), 'm2 sees own ACTIVE guarantee (borrower name)', JSON.stringify(mine.data.result));
  const listG = await api('GET', `/api/saccos/${orgId}/loans/applications/${app1Id}/guarantees`, m1.tok);
  await expect(listG.status === 200 && listG.data.result.length === 1 && listG.data.result[0].full_name.includes('Dhamini 3'),
    'm1 lists Guarantee(app1) with full name');
  const crossG = await api('POST', `/api/saccos/${orgId}/loans/applications/${app1Id}/guarantees`, null, {});
  await expect(crossG.status === 401, 'unauthenticated nomination -> 401');

  // remove a PENDING guarantee then re-add for the required-count path
  const topup1 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m1.tok, { amount: 20000 });
  await expect(topup1.data.success === true, 'm1 deposits 20000 (restores backing 90000)');
  const app3 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 50000, termMonths: 6 });
  const app3Id = app3.data.result.id;
  const add3 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app3Id}/guarantees`, m1.tok, { guarantorMemberId: m4.memberId });
  const g3Id = add3.data.result.id;
  const rem = await api('POST', `/api/saccos/${orgId}/loans/guarantees/${g3Id}/remove`, m1.tok);
  await expect(rem.status === 200 && rem.data.result.status === 'RELEASED', 'borrower removes PENDING guarantee -> RELEASED');
  const req3 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app3Id}/approve`, ownerTok);
  await expect(req3.status === 400 && req3.data.code === 'SACCOS_LOAN_GUARANTOR_REQUIRED',
    'removed guarantee no longer counts -> 400 GUARANTOR_REQUIRED');

  // ---------- 4. Guarantor pays overdue installments ----------
  await section('Guarantor arrears payment + release on close');
  await fundWallet(m3.userId, 500000);
  const inst1 = await api('GET', `/api/saccos/${orgId}/loans/${loan1.id}/installments`, m1.tok);
  await expect(inst1.status === 200 && inst1.data.result.installments.length === 6, 'Loan1 schedule materialised (6 rows)');
  await pool.query(
    `UPDATE saccos_loan_installments SET due_date = CURRENT_DATE - 40
      WHERE loan_id = $1 AND installment_no IN (1, 2)`, [loan1.id]
  );
  const arrears = await api('POST', `/api/saccos/${orgId}/loans/recompute-arrears`, ownerTok);
  await expect(arrears.status === 200 && arrears.data.result.overdue === 2, '2 installments marked OVERDUE', JSON.stringify(arrears.data));
  const m3Before = await walletOf(m3.userId);
  const m1BeforePay = await walletOf(m1.userId);
  const loan1OutBefore = Number((await pool.query(`SELECT amount_outstanding FROM saccos_loans WHERE id = $1`, [loan1.id])).rows[0].amount_outstanding);
  const gPay = await api('POST', `/api/saccos/${orgId}/loans/${loan1.id}/guarantees/${g1Id}/pay`, ownerTok);
  await expect(gPay.status === 200 && gPay.data.result.installments_paid === 2
    && typeof gPay.data.result.total_paid === 'number' && gPay.data.result.total_paid > 0,
    'owner charges guarantor for 2 overdue installments', JSON.stringify(gPay.data));
  const paidTotal = gPay.data.result.total_paid;
  const paidLateFees = gPay.data.result.late_fees;
  const m3After = await walletOf(m3.userId);
  await expect(Math.round(m3After * 100) / 100 === Math.round((m3Before - paidTotal) * 100) / 100,
    `guarantor wallet debited exactly total_paid (m3=${m3After} before=${m3Before} paid=${paidTotal})`);
  await expect((await walletOf(m1.userId)) === m1BeforePay, 'borrower wallet untouched by guarantor payment');
  const loan1OutAfter = Number((await pool.query(`SELECT amount_outstanding FROM saccos_loans WHERE id = $1`, [loan1.id])).rows[0].amount_outstanding);
  await expect(Math.round(loan1OutAfter * 100) / 100 === Math.round((loan1OutBefore - paidTotal + paidLateFees) * 100) / 100,
    `loan outstanding reduced by principal+interest (outstanding ${loan1OutBefore} -> ${loan1OutAfter}, late_fees ${paidLateFees} excluded)`);
  const g1Pay = await pool.query(`SELECT status, paid_amount FROM saccos_loan_guarantees WHERE id = $1`, [g1Id]);
  await expect(g1Pay.rows[0].status === 'PAID_OUT' && Number(g1Pay.rows[0].paid_amount) === paidTotal,
    'guarantee PAID_OUT with paid_amount', JSON.stringify(g1Pay.rows[0]));
  const noArrears = await api('POST', `/api/saccos/${orgId}/loans/${loan1.id}/guarantees/${g1Id}/pay`, ownerTok);
  await expect(noArrears.status === 400 && noArrears.data.code === 'SACCOS_LOAN_GUARANTOR_STATE', 'pay again after PAID_OUT -> 400 GUARANTOR_STATE');

  // fully repay Loan2 (installments) -> guarantee released on close
  await fundWallet(m1.userId, 500000);
  const inst2 = await api('GET', `/api/saccos/${orgId}/loans/${loan2.id}/installments`, m1.tok);
  for (const i of inst2.data.result.installments) {
    const p = await api('POST', `/api/saccos/${orgId}/loans/${loan2.id}/installments/${i.id}/pay`, m1.tok);
    await expect(p.status === 200, `pay installment #${i.installment_no}`, JSON.stringify(p.data));
  }
  const loan2State = await pool.query(`SELECT status FROM saccos_loans WHERE id = $1`, [loan2.id]);
  await expect(loan2State.rows[0].status === 'CLOSED', 'Loan2 CLOSED after all installments paid');
  const g2End = await pool.query(`SELECT status FROM saccos_loan_guarantees WHERE id = $1`, [g2Id]);
  await expect(g2End.rows[0].status === 'RELEASED', 'm2 guarantee RELEASED on loan close');

  // ---------- 5. Restructure ----------
  await section('Restructure / reschedule');
  await setLendingConfig(orgId, { savingsBackingEnabled: true, savingsBackingMultiple: 3, guaranteesRequired: 0, maxActiveLoans: 10 });
  const rApp = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 25000, termMonths: 6 });
  const rAppId = rApp.data.result.id;
  const rAppr = await api('POST', `/api/saccos/${orgId}/loans/applications/${rAppId}/approve`, ownerTok);
  await expect(rAppr.status === 200, 'm1 gets Loan3 (25000/6mo)');
  const loan3 = (await pool.query(`SELECT * FROM saccos_loans WHERE application_id = $1`, [rAppId])).rows[0];
  const inst3 = await api('GET', `/api/saccos/${orgId}/loans/${loan3.id}/installments`, m1.tok);
  const first3 = inst3.data.result.installments[0];
  const pay3 = await api('POST', `/api/saccos/${orgId}/loans/${loan3.id}/installments/${first3.id}/pay`, m1.tok);
  await expect(pay3.status === 200, 'm1 pays first installment of Loan3');
  const loan3Before = (await pool.query(`SELECT amount_outstanding, schedule_version FROM saccos_loans WHERE id = $1`, [loan3.id])).rows[0];
  const outstanding3 = Math.round(Number(loan3Before.amount_outstanding) * 100) / 100;
  const expNewTotal = Math.round(outstanding3 * (1 + (15 / 100) * (12 / 12)) * 100) / 100;

  const membRestr = await api('POST', `/api/saccos/${orgId}/loans/${loan3.id}/restructure`, m2.tok, { newTermMonths: 12, newRatePercent: 15 });
  await expect(membRestr.status === 403 && membRestr.data.code === 'SACCOS_RBAC', 'member restructure -> 403 RBAC');
  const badTerm = await api('POST', `/api/saccos/${orgId}/loans/${loan3.id}/restructure`, ownerTok, { newTermMonths: 200, newRatePercent: 15 });
  await expect(badTerm.status === 400 && badTerm.data.code === 'SACCOS_LOAN_RESTRUCTURE_TERM', 'term 200 -> 400 TERM');
  const badRate = await api('POST', `/api/saccos/${orgId}/loans/${loan3.id}/restructure`, ownerTok, { newTermMonths: 12, newRatePercent: -1 });
  await expect(badRate.status === 400 && badRate.data.code === 'SACCOS_LOAN_RESTRUCTURE_RATE', 'rate -1 -> 400 RATE');

  const restr = await api('POST', `/api/saccos/${orgId}/loans/${loan3.id}/restructure`, ownerTok, { newTermMonths: 12, newRatePercent: 15, reason: 'Muda mrefu' });
  await expect(restr.status === 200 && restr.data.result.reference.startsWith('RST-')
    && Math.abs(restr.data.result.new_principal - outstanding3) < 0.01
    && Math.abs(restr.data.result.new_total - expNewTotal) < 0.01
    && restr.data.result.schedule_version === Number(loan3Before.schedule_version) + 1,
    'restructure: RST-* principal=outstanding new_total=+15% over 12mo version+1', JSON.stringify(restr.data.result));
  const loan3After = (await pool.query(`SELECT principal, interest_rate, term_months, total_repayable, amount_outstanding, schedule_version FROM saccos_loans WHERE id = $1`, [loan3.id])).rows[0];
  await expect(Math.abs(Number(loan3After.principal) - outstanding3) < 0.01
    && Number(loan3After.interest_rate) === 15 && Number(loan3After.term_months) === 12
    && Math.abs(Number(loan3After.amount_outstanding) - expNewTotal) < 0.01
    && Number(loan3After.schedule_version) === Number(loan3Before.schedule_version) + 1,
    'loan row capitalised: principal/rate/term/total/schedule_version', JSON.stringify(loan3After));
  const sched3 = await apisGet(`/api/saccos/${orgId}/loans/${loan3.id}/installments`, m1.tok);
  const live3 = sched3.data.result.installments;
  const nos3 = live3.map((x) => x.installment_no).join(',');
  await expect(live3.length === 13 && live3.filter((x) => x.status === 'PAID').length === 1
    && live3[0].installment_no === 1 && live3[1].installment_no === 2 && live3[12].installment_no === 13,
    `schedule rebuilt: 13 rows, paid#1, numbering 1..13 (${nos3})`);
  const restList = await api('GET', `/api/saccos/${orgId}/loans/${loan3.id}/restructures`, ownerTok);
  await expect(restList.status === 200 && restList.data.result.length === 1 && restList.data.result[0].new_term_months === 12, 'restructure history lists 1 row');
  const closedRestr = await api('POST', `/api/saccos/${orgId}/loans/${loan2.id}/restructure`, ownerTok, { newTermMonths: 6, newRatePercent: 12 });
  await expect(closedRestr.status === 400 && closedRestr.data.code === 'SACCOS_LOAN_RESTRUCTURE_STATE', 'restructure CLOSED loan -> 400 STATE');

  // ---------- 6. Write-off ----------
  await section('Write-off into loan-loss reserves');
  const wApp = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 25000, termMonths: 6 });
  const wAppr = await api('POST', `/api/saccos/${orgId}/loans/applications/${wApp.data.result.id}/approve`, ownerTok);
  await expect(wAppr.status === 200, 'Loan4 application approved');
  const loan4 = (await pool.query(`SELECT * FROM saccos_loans WHERE application_id = $1`, [wApp.data.result.id])).rows[0];
  await expect(loan4.status === 'ACTIVE', 'Loan4 ACTIVE (25000)');
  await api('GET', `/api/saccos/${orgId}/loans/${loan4.id}/installments`, m1.tok);
  const prov = await api('POST', `/api/saccos/${orgId}/loan-loss/provision`, ownerTok, { loanId: loan4.id, amount: 4000, ratePercent: 20 });
  await expect(prov.status === 201 && prov.data.result.reference_id.startsWith('LLR-'), 'LLR provisioned 4000 (20%)');
  const noReason = await api('POST', `/api/saccos/${orgId}/loans/${loan4.id}/write-off`, ownerTok, {});
  await expect(noReason.status === 400 && noReason.data.code === 'SACCOS_LOAN_WRITE_OFF_REASON', 'write-off without reason -> 400 REASON');
  const membWo = await api('POST', `/api/saccos/${orgId}/loans/${loan4.id}/write-off`, m2.tok, { reason: 'x' });
  await expect(membWo.status === 403 && membWo.data.code === 'SACCOS_RBAC', 'member write-off -> 403 RBAC');
  const closedWo = await api('POST', `/api/saccos/${orgId}/loans/${loan2.id}/write-off`, ownerTok, { reason: 'x' });
  await expect(closedWo.status === 400 && closedWo.data.code === 'SACCOS_LOAN_WRITE_OFF_STATE', 'write-off CLOSED loan -> 400 STATE');

  const outstanding4 = Math.round(Number(loan4.amount_outstanding) * 100) / 100;
  const principalWo = Math.round(Number(loan4.principal) * 100) / 100;
  const expExpense = Math.round((principalWo - 4000) * 100) / 100;
  const wo = await api('POST', `/api/saccos/${orgId}/loans/${loan4.id}/write-off`, ownerTok, { reason: 'Filika ya mwanachama' });
  await expect(wo.status === 200 && wo.data.result.reference.startsWith('WO-')
    && Math.abs(wo.data.result.reserves_used - 4000) < 0.01
    && Math.abs(wo.data.result.expense_used - expExpense) < 0.01
    && Math.abs(wo.data.result.interest_forgiven - (outstanding4 - principalWo)) < 0.01,
    'write-off: WO-* reserves 4000 + expense on principal, interest forgiven', JSON.stringify(wo.data.result));
  const woRef = wo.data.result.reference;
  const woRows = await pool.query(`SELECT l.status, l.amount_outstanding, a.status AS app_status
       FROM saccos_loans l JOIN saccos_loan_applications a ON a.id = l.application_id WHERE l.id = $1`, [loan4.id]);
  await expect(woRows.rows[0].status === 'WRITTEN_OFF' && Number(woRows.rows[0].amount_outstanding) === 0
    && woRows.rows[0].app_status === 'WRITTEN_OFF', 'loan + application WRITTEN_OFF, outstanding 0');
  const woInst = await pool.query(`SELECT DISTINCT status FROM saccos_loan_installments WHERE loan_id = $1`, [loan4.id]);
  await expect(woInst.rows.length === 1 && woInst.rows[0].status === 'CANCELLED', 'Loan4 installments CANCELLED');
  const llrRow = await pool.query(`SELECT status FROM saccos_loan_loss_reserves WHERE loan_id = $1`, [loan4.id]);
  await expect(llrRow.rows[0].status === 'UTILIZED', 'LLR row UTILIZED');
  const woJ = await pool.query(
    `SELECT la.account_code, j.direction, j.amount FROM journal_entries j
     JOIN ledger_accounts la ON la.id = j.account_id WHERE j.reference_id = $1 ORDER BY la.account_code`,
    [woRef]
  );
  await expect(woJ.rows.length === 3
    && woJ.rows.some((r) => r.direction === 'DR' && r.account_code === `SACCOS${orgId}_LOAN_LOSS_RESERVES` && Number(r.amount) === 4000)
    && woJ.rows.some((r) => r.direction === 'DR' && r.account_code === `SACCOS${orgId}_LOAN_LOSS_EXPENSE` && Math.abs(Number(r.amount) - expExpense) < 0.01)
    && woJ.rows.some((r) => r.direction === 'CR' && r.account_code === `SACCOS${orgId}_LOANS_RECEIVABLE` && Math.abs(Number(r.amount) - principalWo) < 0.01),
    'journal balanced: DR reserves 4000 + DR expense / CR receivable (principal)', JSON.stringify(woJ.rows));
  const rc = await pool.query(`SELECT
     (SELECT COALESCE(SUM(l.principal)::numeric,0) FROM saccos_loans l WHERE l.saccos_id = $1) AS tp,
     (SELECT COALESCE(SUM(r.principal_part)::numeric,0) FROM saccos_loan_repayments r JOIN saccos_loans l ON l.id = r.loan_id WHERE l.saccos_id = $1) AS paid,
     (SELECT COALESCE(SUM(wl.principal)::numeric,0) FROM saccos_loans wl WHERE wl.saccos_id = $1 AND wl.status = 'WRITTEN_OFF') AS wo`,
    [orgId]);
  const recvExpected = Number(rc.rows[0].tp) - Number(rc.rows[0].paid) - Number(rc.rows[0].wo);
  const recvBalance = await ledgerBalance(`SACCOS${orgId}_LOANS_RECEIVABLE`);
  await expect(Math.abs(await ledgerBalance(`SACCOS${orgId}_LOAN_LOSS_RESERVES`) - 0) < 0.01
    && Math.abs(recvBalance + recvExpected) < 0.01,
    `net reserves 0 + receivable reconciles to ${recvExpected} (remaining principal; balance=${recvBalance})`);
  const repayBlocked = await api('POST', `/api/saccos/${orgId}/loans/${loan4.id}/repay`, m1.tok, { amount: 1000 });
  await expect(repayBlocked.status === 400 && repayBlocked.data.code === 'SACCOS_LOAN_WRITTEN_OFF', 'repay WRITTEN_OFF loan -> 400 WRITTEN_OFF');
  const llrSum = await api('GET', `/api/saccos/${orgId}/loan-loss/summary`, ownerTok);
  await expect(llrSum.status === 200 && llrSum.data.result.utilized === 1, 'loan-loss summary reports 1 UTILIZED');
  const woList = await api('GET', `/api/saccos/${orgId}/loans/write-offs`, ownerTok);
  await expect(woList.status === 200 && woList.data.result.length === 1 && woList.data.result[0].loan_reference, 'write-off list has Loan4 reference');

  // ---------- 7. Standing orders ----------
  await section('Standing orders: monthly recurring contributions');
  const fund = await api('POST', `/api/saccos/${orgId}/funds`, ownerTok, { code: 'MAENDELEO', name: 'Maendeleo', targetAmount: 1000000 });
  await expect(fund.status === 201, 'owner creates fund MAENDELEO');
  const fundId = fund.data.result.id;
  const scheme = await api('POST', `/api/saccos/${orgId}/welfare/schemes`, ownerTok, { name: 'Matibabu', contribution: 20000, payout: 50000 });
  await expect(scheme.status === 201, 'owner creates welfare scheme (contribution 20000)');
  const schemeId = scheme.data.result.id;
  await fundWallet(m1.userId, 900000);
  await fundWallet(m2.userId, 900000);
  await fundWallet(m4.userId, 900000);
  await fundWallet(m3.userId, 10000);

  const badType = await api('POST', `/api/saccos/${orgId}/standing-orders`, m1.tok, { targetType: 'ROSCA', amount: 1000, dayOfMonth: 5 });
  await expect(badType.status === 400 && badType.data.code === 'SACCOS_STANDING_ORDER_TYPE', 'bad targetType -> 400 TYPE');
  const badAmt = await api('POST', `/api/saccos/${orgId}/standing-orders`, m1.tok, { targetType: 'SAVINGS_DEPOSIT', amount: 0, dayOfMonth: 5 });
  await expect(badAmt.status === 400 && badAmt.data.code === 'SACCOS_STANDING_ORDER_AMOUNT', 'amount 0 -> 400 AMOUNT');
  const badDay = await api('POST', `/api/saccos/${orgId}/standing-orders`, m1.tok, { targetType: 'SAVINGS_DEPOSIT', amount: 1000, dayOfMonth: 29 });
  await expect(badDay.status === 400 && badDay.data.code === 'SACCOS_STANDING_ORDER_DAY', 'day 29 -> 400 DAY');

  const so1 = await api('POST', `/api/saccos/${orgId}/standing-orders`, m1.tok, { targetType: 'SAVINGS_DEPOSIT', amount: 30000, dayOfMonth: 15 });
  await expect(so1.status === 201 && so1.data.result.reference_id.startsWith('SO-') && so1.data.result.status === 'ACTIVE'
    && so1.data.result.total_runs === 0 && so1.data.result.next_run_at === null,
    'm1 creates savings order (SO-*)', JSON.stringify(so1.data));
  const so1Id = so1.data.result.id;
  const savBefore = await savingsBalance(orgId, m1.memberId);
  const run1 = await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  await expect(run1.status === 200 && run1.data.result.executed === 1 && run1.data.result.succeeded === 1,
    'first run executes the due savings order', JSON.stringify(run1.data));
  await expect((await savingsBalance(orgId, m1.memberId)) === savBefore + 30000, 'savings +30000 from standing order');
  const so1Row = await pool.query(`SELECT total_runs, success_runs, fail_runs, next_run_at FROM saccos_standing_orders WHERE id = $1`, [so1Id]);
  await expect(so1Row.rows[0].total_runs === 1 && so1Row.rows[0].success_runs === 1 && so1Row.rows[0].fail_runs === 0
    && so1Row.rows[0].next_run_at !== null, 'order booked: 1 run success, next month scheduled');

  const idle = await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  await expect(idle.status === 200 && idle.data.result.executed === 0, 'second run: nothing due (next month)');

  const so2 = await api('POST', `/api/saccos/${orgId}/standing-orders`, m1.tok, { targetType: 'SAVINGS_DEPOSIT', amount: 50000, dayOfMonth: 5 });
  const savBefore2 = await savingsBalance(orgId, m1.memberId);
  const run2 = await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  await expect(run2.status === 200 && run2.data.result.succeeded === 1 && (await savingsBalance(orgId, m1.memberId)) === savBefore2 + 50000,
    'a second savings order runs too');

  const so3 = await api('POST', `/api/saccos/${orgId}/standing-orders`, m2.tok, { targetType: 'FUND_CONTRIBUTION', targetId: fundId, amount: 25000, dayOfMonth: 10 });
  await expect(so3.status === 201, 'm2 creates fund-contribution order');
  const run3 = await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  await expect(run3.status === 200 && run3.data.result.succeeded === 1, 'run executes fund order');
  await expect(await ledgerBalance(`SACCOS${orgId}_FUND_MAENDELEO`) === 25000, 'fund balance 25000 from standing order');

  const so4 = await api('POST', `/api/saccos/${orgId}/standing-orders`, m4.tok, { targetType: 'WELFARE_CONTRIBUTION', targetId: schemeId, amount: 20000, dayOfMonth: 20 });
  await expect(so4.status === 201, 'm4 creates welfare-contribution order');
  const run4 = await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  await expect(run4.status === 200 && run4.data.result.succeeded === 1, 'run executes welfare order');
  const schemes4 = await api('GET', `/api/saccos/${orgId}/welfare/schemes`, m4.tok);
  await expect(schemes4.data.result[0].joined === true, 'm4 joined the welfare scheme via standing order');

  const so5 = await api('POST', `/api/saccos/${orgId}/standing-orders`, m1.tok, { targetType: 'LOAN_REPAYMENT', targetId: loan1.id, amount: 15000, dayOfMonth: 3 });
  await expect(so5.status === 201, 'm1 creates loan-repayment order for Loan1');
  const loan1Out = Number((await pool.query(`SELECT amount_outstanding FROM saccos_loans WHERE id = $1`, [loan1.id])).rows[0].amount_outstanding);
  const run5 = await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  await expect(run5.status === 200 && run5.data.result.succeeded === 1, 'run executes loan-repayment order');
  const loan1OutAfterRepay = Number((await pool.query(`SELECT amount_outstanding FROM saccos_loans WHERE id = $1`, [loan1.id])).rows[0].amount_outstanding);
  await expect(Math.abs(loan1Out - loan1OutAfterRepay - 15000) < 0.01, 'Loan1 outstanding reduced by exactly 15000');

  const badTarget = await api('POST', `/api/saccos/${orgId}/standing-orders`, m1.tok, { targetType: 'FUND_CONTRIBUTION', targetId: fundId + 9999, amount: 1000, dayOfMonth: 5 });
  await expect(badTarget.status === 400 && badTarget.data.code === 'SACCOS_STANDING_ORDER_TARGET', 'unknown fund -> 400 TARGET');

  // failure x3 deactivates
  const so6 = await api('POST', `/api/saccos/${orgId}/standing-orders`, m3.tok, { targetType: 'SAVINGS_DEPOSIT', amount: 20000, dayOfMonth: 25 });
  const so6Id = so6.data.result.id;
  await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  const run6c = await api('POST', `/api/saccos/${orgId}/standing-orders/run`, ownerTok);
  await expect(run6c.status === 200 && run6c.data.result.failed === 1, 'third failed run observed');
  const so6Row = await pool.query(`SELECT status, fail_runs, total_runs, last_error FROM saccos_standing_orders WHERE id = $1`, [so6Id]);
  await expect(so6Row.rows[0].status === 'DEACTIVATED' && so6Row.rows[0].fail_runs === 3
    && so6Row.rows[0].total_runs === 3 && !!so6Row.rows[0].last_error,
    'order DEACTIVATED after 3 consecutive failures', JSON.stringify(so6Row.rows[0]));

  const deact = await api('POST', `/api/saccos/${orgId}/standing-orders/${so6Id}/deactivate`, m1.tok);
  await expect(deact.status === 400 && deact.data.code === 'SACCOS_STANDING_ORDER_STATE', 'deactivate already-deactivated order -> 400 STATE');
  const deact2 = await api('POST', `/api/saccos/${orgId}/standing-orders/${so2.data.result.id}/deactivate`, m1.tok);
  await expect(deact2.status === 200 && deact2.data.result.status === 'DEACTIVATED', 'm1 deactivates own active savings order #2 -> DEACTIVATED');
  const mineOrders = await api('GET', `/api/saccos/${orgId}/standing-orders/mine`, m1.tok);
  await expect(mineOrders.status === 200 && mineOrders.data.result.length >= 3 && mineOrders.data.result.every((o) => o.member_id === m1.memberId),
    'm1 lists own orders (3+ rows)');
  const allOrders = await api('GET', `/api/saccos/${orgId}/standing-orders`, ownerTok);
  await expect(allOrders.status === 200 && allOrders.data.result.length === 6 && allOrders.data.result[0].full_name, 'owner lists all 6 orders with names');
  const membRun = await api('POST', `/api/saccos/${orgId}/standing-orders/run`, m1.tok);
  await expect(membRun.status === 403 && membRun.data.code === 'SACCOS_RBAC', 'member manual run -> 403 RBAC');

  // ---------- 8. Isolation + audit ----------
  await section('Isolation + audit');
  const s2Owner = await register(phone(9306), 'Shirika la Pili');
  const s2Tok = s2Owner.data.token;
  const s2 = await api('POST', '/api/v1/saccos', s2Tok, { name: 'Pili Jukumu ' + suffix });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, s2Tok);
  const crossFund = await api('POST', `/api/saccos/${s2Id}/funds`, s2Tok, { code: 'PILII', name: 'Pili Hazina', targetAmount: 100 });
  await expect(crossFund.status === 201 && crossFund.data.result.id, 's2 owner creates own fund ' + s2Id, JSON.stringify(crossFund.data));
  const cross = await api('POST', `/api/saccos/${orgId}/standing-orders`, s2Tok, { targetType: 'FUND_CONTRIBUTION', targetId: crossFund.data.result.id, amount: 1000, dayOfMonth: 5 });
  await expect(cross.status === 404 && cross.data.code === 'SACCOS_NOT_FOUND', 'outsider order on s1 -> 404 NOT_FOUND (not a member)', `${cross.status} ${cross.data && cross.data.code}`);
  const pendingApp = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 10000, termMonths: 3, purpose: 'Jaribio la pekee' });
  await expect(pendingApp.status === 201, 'fresh PENDING application for isolation guard', `${pendingApp.status} ${pendingApp.data && pendingApp.data.code}`);
  const crossG2 = await api('POST', `/api/saccos/${orgId}/loans/applications/${pendingApp.data.result.id}/guarantees`, s2Tok, { guarantorMemberId: m2.memberId });
  await expect(crossG2.status === 404 && crossG2.data.code === 'SACCOS_NOT_FOUND', 's2 owner adds guarantee on s1 -> 404 NOT_FOUND', `${crossG2.status} ${crossG2.data && crossG2.data.code}`);
  const x = await member(9307, 'Mgeni Nje');
  const crossTarget = await api('POST', `/api/saccos/${orgId}/standing-orders`, x.tok, { targetType: 'FUND_CONTRIBUTION', targetId: crossFund.data.result.id, amount: 1000, dayOfMonth: 5 });
  await expect(crossTarget.status === 400 && crossTarget.data.code === 'SACCOS_STANDING_ORDER_TARGET',
    'order targeting another saccos fund -> 400 TARGET', `${crossTarget.status} ${crossTarget.data && crossTarget.data.code}`);
  const audit = await pool.query(
    `SELECT DISTINCT action FROM audit_logs WHERE action IN
       ('SACCOS_GUARANTOR_ACCEPTED', 'SACCOS_GUARANTOR_PAYMENT', 'SACCOS_LOAN_RESTRUCTURED',
        'SACCOS_LOAN_WRITTEN_OFF', 'SACCOS_STANDING_ORDER_RUN', 'SACCOS_STANDING_ORDER_DEACTIVATED')`
  );
  await expect(audit.rows.length === 6, 'guarantor/restructure/write-off/standing-order audit actions recorded');

  console.log(`\nSACCOS LOAN MANAGEMENT: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

function apisGet(path, token) {
  return api('GET', path, token);
}

main().catch((e) => { console.error(e); process.exit(1); });