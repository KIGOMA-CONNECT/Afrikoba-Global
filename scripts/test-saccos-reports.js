/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - MEMBER STATEMENTS &
 * REGULATORY REPORTS (increment 11, suite 55)
 *
 * Consolidated per-member statement (savings/shares/loans/
 * investments/dividends/exits/wallet), self + OWNER/BOARD/ADMIN;
 * regulatory snapshot computed from the shared double-entry ledger
 * (per-entity SACCOS<id>_* codes, totaled by account type) +
 * saccos tables and UPSERTed into saccos_regulatory_reports keyed
 * by (saccos_id, as_of); monthly management flows. RBAC 403 on
 * sibling reads, cross-entity 404, audits, schema evidence.
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
  await section('Schema evidence (111_saccos_reports)');
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_regulatory_reports'`);
  await expect(['net_income', 'total_revenue', 'total_expense', 'savings_liability', 'fund_balances', 'loan_principal_outstanding', 'total_exit_settlements', 'as_of'].every((c) => cols.rows.some((r) => r.column_name === c)),
    'saccos_regulatory_reports columns present');

  // ---------- 2. Setup ----------
  await section('Setup: shares + savings + investment + fund + loan + dividend + exit');
  const ownerReg = await register(phone(8801), 'Ripoti Mkuu');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Ripoti Yetu ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  async function member(pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return { tok: reg.data.token, userId: reg.data.user.id };
  }
  const m1 = await member(8802, 'Taarifa 1');
  const m2 = await member(8803, 'Taarifa 2');
  await fundWallet(m1.userId, 200000);
  await fundWallet(m2.userId, 300000);

  const b1 = await api('POST', `/api/saccos/${orgId}/shares/purchase`, m1.tok, { shares: 2 });
  const b2 = await api('POST', `/api/saccos/${orgId}/shares/purchase`, m2.tok, { shares: 1 });
  await expect(b1.status === 201 && b2.status === 201, 'm1:2 + m2:1 shares');
  const dep = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m1.tok, { amount: 50000 });
  await expect(dep.status === 201, 'm1 savings deposit 50000');

  const prod = await api('POST', `/api/saccos/${orgId}/investments/products`, ownerTok, { name: 'Amana', minAmount: 10000, maxAmount: 500000, annualRatePercent: 10, termMonths: 12 });
  await expect(prod.status === 201, 'owner creates investment product');
  const inv = await api('POST', `/api/saccos/${orgId}/investments/apply`, m1.tok, { productId: prod.data.result.id, amount: 20000 });
  await expect(inv.status === 201, 'm1 subscribes 20000');

  const fund = await api('POST', `/api/saccos/${orgId}/funds`, ownerTok, { code: 'EMERGENCY', name: 'Dharura', targetAmount: 100000, minimumBalance: 0 });
  await expect(fund.status === 201, 'owner creates fund EMERGENCY');
  const contrib = await api('POST', `/api/saccos/${orgId}/funds/${fund.data.result.id}/contribute`, m1.tok, { amount: 10000 });
  await expect(contrib.status === 201, 'm1 contributes 10000');

  const loan = await api('POST', `/api/saccos/${orgId}/loans/apply`, m2.tok, { amount: 30000, termMonths: 3, purpose: 'Biashara' });
  await expect(loan.status === 201, 'm2 applies for loan 30000');
  const appId = loan.data.result.id;
  const approved = await api('POST', `/api/saccos/${orgId}/loans/applications/${appId}/approve`, ownerTok);
  await expect(approved.status === 200 && approved.data.result.decision === 'APPROVE', 'owner approves (auto-disburses) loan');

  const period = await api('POST', `/api/saccos/${orgId}/accounting/periods`, ownerTok, { label: 'Mwaka Ripoti' });
  const periodId = period.data.result.id;
  await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'INCOME', amount: 400000, description: 'Faida' });
  await api('POST', `/api/saccos/${orgId}/accounting/periods/${periodId}/close`, ownerTok);
  const decl = await api('POST', `/api/saccos/${orgId}/dividends`, ownerTok, { periodId, totalAmount: 30000 });
  await expect(decl.status === 201, 'declare dividend 30000');
  const dist = await api('POST', `/api/saccos/${orgId}/dividends/runs/${decl.data.result.id}/distribute`, ownerTok);
  await expect(dist.status === 200 && dist.data.result.summary.paid === 30000, 'distribute pays 30000');

  const exit = await api('POST', `/api/saccos/${orgId}/exits/settle`, m2.tok);
  await expect(exit.status === 201 && exit.data.result.total_settlement === 10000, 'm2 exits with share redemption 10000');

  // ---------- 3. Statements ----------
  await section('Per-member statements (self + OWNER/BOARD + RBAC + isolation)');
  const stM1 = await api('GET', `/api/saccos/${orgId}/statements/mine`, m1.tok);
  await expect(stM1.status === 200 && stM1.data.result.member.status === 'ACTIVE'
    && stM1.data.result.savings.balance === 50000
    && stM1.data.result.shares.share_count === 2 && stM1.data.result.shares.total_value === 20000
    && stM1.data.result.investments.length === 1 && stM1.data.result.investments[0].amount === 20000
    && stM1.data.result.dividends.length === 1 && stM1.data.result.dividends[0].amount === 20000
    && stM1.data.result.exit === null,
    'm1 consolidated statement (savings/shares/investment/divided, no exit)');

  const w1 = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.userId]);
  await expect(Number(w1.rows[0].wallet_balance) === 120000 && stM1.data.result.member.wallet_balance === 120000,
    'm1 wallet 120000 matches statement');

  const stM2 = await api('GET', `/api/saccos/${orgId}/statements/mine`, m2.tok);
  await expect(stM2.status === 200 && stM2.data.result.member.status === 'EXITED'
    && stM2.data.result.shares.share_count === 0
    && stM2.data.result.loans.length === 1 && stM2.data.result.loans[0].amount_outstanding > 0
    && stM2.data.result.exit.total_settlement === 10000,
    'exited m2 still reads own statement (loans + exit record)');

  const outsiderReg = await register(phone(8899), 'Nje Ripoti');
  const outsiderTok = outsiderReg.data.token;
  const outsiderMine = await api('GET', `/api/saccos/${orgId}/statements/mine`, outsiderTok);
  await expect(outsiderMine.status === 404, 'non-member statement/mine -> 404');

  // deterministic member ids
  const memRows = await pool.query(`SELECT m.id, m.member_number, m.status FROM saccos_members m WHERE m.saccos_id = $1 ORDER BY m.id`, [orgId]);
  const m2Row = memRows.rows.find((r) => r.member_number === stM2.data.result.member.member_number);
  const rbac = await api('GET', `/api/saccos/${orgId}/members/${m2Row.id}/statement`, m1.tok);
  await expect(rbac.status === 403, 'member reading sibling statement -> 403');
  const ownerView2 = await api('GET', `/api/saccos/${orgId}/members/${m2Row.id}/statement`, ownerTok);
  await expect(ownerView2.status === 200 && ownerView2.data.result.member.status === 'EXITED' && ownerView2.data.result.exit.total_settlement === 10000,
    'owner reads exited member statement');

  const o2 = await register(phone(8805), 'Ripoti Pili');
  const o2Tok = o2.data.token;
  const org2 = await api('POST', '/api/v1/saccos', o2Tok, { name: 'Ripoti Pili ' + suffix });
  const s2Id = org2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);
  const cross = await api('GET', `/api/saccos/${orgId}/statements/mine`, o2Tok);
  await expect(cross.status === 404, 'S2 owner statement on S1 -> 404');

  // ---------- 4. Regulatory report ----------
  await section('Regulatory snapshot (ledger-computed + persisted)');
  const reg = await api('GET', `/api/saccos/${orgId}/reports/regulatory`, ownerTok);
  await expect(reg.status === 200
    && reg.data.result.members.active === 2 && reg.data.result.members.exited === 1
    && reg.data.result.shares.share_count_total === 2 && reg.data.result.shares.share_value_total === 20000
    && reg.data.result.liabilities.savings === 50000
    && reg.data.result.liabilities.investments === 20000
    && reg.data.result.liabilities.fund_balances === 10000
    && reg.data.result.dividends.distributed === 30000
    && reg.data.result.income.revenue === 400000 && reg.data.result.income.expense === 30000 && reg.data.result.income.net_income === 370000
    && reg.data.result.exit_settlements === 10000,
    'regulatory aggregates correct (members/shares/liabilities/income/exits)', JSON.stringify(reg.data.result));

  const loanOuts = await pool.query(`SELECT COALESCE(SUM(amount_outstanding),0)::numeric AS o FROM saccos_loans WHERE saccos_id = $1 AND status = 'ACTIVE'`, [orgId]);
  const llrOuts = await pool.query(`SELECT COALESCE(SUM(provision_amount),0)::numeric AS p FROM saccos_loan_loss_reserves WHERE saccos_id = $1`, [orgId]);
  await expect(reg.data.result.loans.principal_outstanding === Number(loanOuts.rows[0].o)
    && reg.data.result.liabilities.loan_loss_reserves === Number(llrOuts.rows[0].p),
    'loan outstanding + LLR match live tables');

  const reg2 = await api('GET', `/api/saccos/${orgId}/reports/regulatory`, ownerTok);
  await expect(reg2.status === 200 && reg2.data.result.income.net_income === 370000, 'regulatory rerun stable');
  const snap = await pool.query(`SELECT COUNT(*)::int AS c FROM saccos_regulatory_reports WHERE saccos_id = $1`, [orgId]);
  await expect(snap.rows[0].c === 1, 'one persisted snapshot per (saccos, as_of)');

  // ---------- 5. Management report ----------
  await section('Management monthly flows');
  const mgmt = await api('GET', `/api/saccos/${orgId}/reports/management?months=6`, ownerTok);
  await expect(mgmt.status === 200 && mgmt.data.result.period_months === 6 && mgmt.data.result.months.length === 6, 'management report 6 months');
  const cur = mgmt.data.result.months[5];
  await expect(cur.savings_deposits === 50000 && cur.loan_disbursements === 30000
    && cur.dividends_paid === 30000 && cur.fund_contributions === 10000
    && cur.exit_settlements === 10000 && cur.savings_withdrawals === 0,
    'current month flows exact', JSON.stringify(cur));

  // ---------- 6. ADMIN + audit ----------
  await section('Platform ADMIN oversight + audit');
  const adminTok = await makeAdmin(await register(phone(8806), 'Ododo Ripoti'));
  const adminReg = await api('GET', `/api/saccos/${orgId}/reports/regulatory`, adminTok);
  const adminMgmt = await api('GET', `/api/saccos/${orgId}/reports/management`, adminTok);
  await expect(adminTok && adminReg.status === 200 && adminMgmt.status === 200, 'platform ADMIN regulatory + management');
  const audit = await pool.query(`SELECT action FROM audit_logs WHERE action IN ('SACCOS_REGULATORY_REPORT','SACCOS_MANAGEMENT_REPORT')`);
  await expect(audit.rows.length >= 2, 'audit trail has report actions');

  console.log(`\nSACCOS REPORTS: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });