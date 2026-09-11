/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - FUND MANAGEMENT +
 * LOAN-LOSS RESERVES (increment 9, suite 53)
 *
 * Funds: OWNER/BOARD create per-SACCOS LIABILITY buckets
 * (account_code SACCOS<id>_FUND_<CODE>, FND-*); ACTIVE members
 * contribute (debitWallet DR CUSTOMER_WALLET / CR fund account,
 * txn SACCOS_FUND_CONTRIBUTION, FNC-*); OWNER/BOARD transfer
 * between funds (balanced journal DR from / CR to, FTF-*);
 * archives only when residual balance is zero. Loan-loss: boards
 * provision a disbursed loan once (DR EXPENSE / CR RESERVES,
 * LLR-*, UNIQUE per loan) and release to reverse; P&L reflects
 * the provision immediately (ledger-computed). RBAC 403,
 * cross-entity 404, ADMIN oversight, audit trail.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

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

  async function addMemberTok(ownerTok, orgId, pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return reg.data.token;
  }

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (109_saccos_funds)');
  const fundCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_funds'`);
  await expect(['code', 'account_code', 'target_amount', 'minimum_balance', 'status'].every((c) => fundCols.rows.some((r) => r.column_name === c)),
    'saccos_funds columns present');
  const conCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_fund_contributions'`);
  await expect(['fund_id', 'reference_id', 'amount'].every((c) => conCols.rows.some((r) => r.column_name === c)),
    'saccos_fund_contributions columns present');
  const tfCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_fund_transfers'`);
  await expect(['from_fund_id', 'to_fund_id', 'authorized_by'].every((c) => tfCols.rows.some((r) => r.column_name === c)),
    'saccos_fund_transfers columns present');
  const llrCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_loss_reserves'`);
  await expect(['loan_id', 'provision_amount', 'provision_rate_percent', 'status', 'released_at'].every((c) => llrCols.rows.some((r) => r.column_name === c)),
    'saccos_loan_loss_reserves columns present');

  // ---------- 2. Setup ----------
  await section('Setup');
  const ownerReg = await register(phone(8800), 'Hazina Mkuu');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Hazina Yetu ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);
  const m1Tok = await addMemberTok(ownerTok, orgId, 8801, 'Changiaji 1');
  const m2Tok = await addMemberTok(ownerTok, orgId, 8802, 'Changiaji 2');
  const m1 = await pool.query(`SELECT u.id, w.id AS mid FROM users u JOIN saccos_members w ON w.user_id = u.id WHERE u.phone_number = $1`, [phone(8801)]);
  const m2 = await pool.query(`SELECT u.id, w.id AS mid FROM users u JOIN saccos_members w ON w.user_id = u.id WHERE u.phone_number = $1`, [phone(8802)]);

  // ---------- 3. Fund creation + RBAC ----------
  await section('Fund creation + RBAC');
  const memberCreate = await api('POST', `/api/saccos/${orgId}/funds`, m1Tok, { code: 'X', name: 'X', targetAmount: 1000 });
  await expect(memberCreate.status === 403 && memberCreate.data.code === 'SACCOS_RBAC', 'member cannot create fund -> 403');

  const fA = await api('POST', `/api/saccos/${orgId}/funds`, ownerTok, { code: 'EXPANSION', name: 'Upanuzi', purpose: 'Majengo', targetAmount: 500000, minimumBalance: 50000 });
  await expect(fA.status === 201 && String(fA.data.result.reference_id).startsWith('FND-') && fA.data.result.status === 'ACTIVE'
    && fA.data.result.account_code === `SACCOS${orgId}_FUND_EXPANSION` && fA.data.result.balance === 0,
    'create EXPANSION fund -> FND-* ACTIVE, zero balance', JSON.stringify(fA.data.result));

  const badCode = await api('POST', `/api/saccos/${orgId}/funds`, ownerTok, { code: 'EXP!', name: 'Bubu' });
  await expect(badCode.status === 400 && badCode.data.code === 'SACCOS_FUND_CODE', 'bad code -> SACCOS_FUND_CODE');
  const dupCode = await api('POST', `/api/saccos/${orgId}/funds`, ownerTok, { code: 'EXPANSION', name: 'Dup' });
  await expect(dupCode.status === 400 && dupCode.data.code === 'SACCOS_FUND_EXISTS', 'duplicate code -> SACCOS_FUND_EXISTS');

  const fB = await api('POST', `/api/saccos/${orgId}/funds`, ownerTok, { code: 'EDUCATION', name: 'Elimu', targetAmount: 300000 });
  const fC = await api('POST', `/api/saccos/${orgId}/funds`, ownerTok, { code: 'RESERVE', name: 'Akiba Mkuu' });
  await expect(fB.status === 201 && fC.status === 201, 'EDUCATION + RESERVE funds created');

  const fAId = fA.data.result.id;
  const fBId = fB.data.result.id;
  const fCId = fC.data.result.id;

  const ledgerRow = await pool.query(`SELECT id FROM ledger_accounts WHERE account_code = $1`, [`SACCOS${orgId}_FUND_EXPANSION`]);
  await expect(ledgerRow.rows.length === 1 || fA.data.result.balance === 0, 'EXPANSION ledger account auto-created');

  // ---------- 4. Contributions ----------
  await section('Contributions (member wallet -> fund)');
  await fundWallet(m1.rows[0].id, 100000);
  await fundWallet(m2.rows[0].id, 100000);
  const c1 = await api('POST', `/api/saccos/${orgId}/funds/${fAId}/contribute`, m1Tok, { amount: 30000 });
  await expect(c1.status === 201 && String(c1.data.result.reference_id).startsWith('FNC-') && c1.data.result.amount === 30000,
    'm1 contributes 30000 -> FNC-*');
  const c2 = await api('POST', `/api/saccos/${orgId}/funds/${fAId}/contribute`, m2Tok, { amount: 10000 });
  await expect(c2.status === 201 && c2.data.result.amount === 10000, 'm2 contributes 10000');

  const w1 = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.rows[0].id]);
  await expect(Number(w1.rows[0].wallet_balance) === 70000, 'm1 wallet debited 30000 (70000 left)');

  const txn = await pool.query(`SELECT type, meta FROM transactions WHERE reference_id = $1`, [c1.data.result.reference_id]);
  await expect(txn.rows.length === 1 && txn.rows[0].type === 'SACCOS_FUND_CONTRIBUTION' && txn.rows[0].meta.fundCode === 'EXPANSION',
    'SACCOS_FUND_CONTRIBUTION txn with fund meta');

  const noFunds = await api('POST', `/api/saccos/${orgId}/funds/${fAId}/contribute`, m1Tok, { amount: 999999 });
  await expect(noFunds.status === 400 && noFunds.data.code === 'WALLET_INSUFFICIENT_FUNDS', 'overdraft contribution -> WALLET_INSUFFICIENT_FUNDS');
  const zeroAmount = await api('POST', `/api/saccos/${orgId}/funds/${fAId}/contribute`, m1Tok, { amount: 0 });
  await expect(zeroAmount.status === 400 && zeroAmount.data.code === 'SACCOS_FUND_AMOUNT', 'zero contribution -> SACCOS_FUND_AMOUNT');

  const mine = await api('GET', `/api/saccos/${orgId}/funds/contributions/mine`, m1Tok);
  await expect(mine.status === 200 && mine.data.result.length === 1 && mine.data.result[0].amount === 30000 && mine.data.result[0].code === 'EXPANSION',
    'm1 sees own contribution only');

  // ---------- 5. Transfers ----------
  await section('Transfers between funds');
  const memberTransfer = await api('POST', `/api/saccos/${orgId}/funds/transfers`, m1Tok, { fromFundId: fAId, toFundId: fBId, amount: 5000 });
  await expect(memberTransfer.status === 403 && memberTransfer.data.code === 'SACCOS_RBAC', 'member cannot transfer -> 403');
  const same = await api('POST', `/api/saccos/${orgId}/funds/transfers`, ownerTok, { fromFundId: fAId, toFundId: fAId, amount: 1000 });
  await expect(same.status === 400 && same.data.code === 'SACCOS_FUND_SAME', 'self-transfer -> SACCOS_FUND_SAME');
  const over = await api('POST', `/api/saccos/${orgId}/funds/transfers`, ownerTok, { fromFundId: fAId, toFundId: fBId, amount: 999999 });
  await expect(over.status === 400 && over.data.code === 'SACCOS_FUND_INSUFFICIENT', 'over-transfer -> SACCOS_FUND_INSUFFICIENT');

  const tf = await api('POST', `/api/saccos/${orgId}/funds/transfers`, ownerTok, { fromFundId: fAId, toFundId: fBId, amount: 12000, reason: 'Soma' });
  await expect(tf.status === 200 && String(tf.data.result.reference).startsWith('FTF-') && tf.data.result.amount === 12000,
    'transfer 12000 EXPANSION -> EDUCATION');

  const funds = await api('GET', `/api/saccos/${orgId}/funds`, ownerTok);
  const bal = (fc) => funds.data.result.find((f) => f.code === fc).balance;
  await expect(funds.status === 200 && bal('EXPANSION') === 28000 && bal('EDUCATION') === 12000,
    'post-transfer balances 28000/12000 (30000+10000-12000 / 12000)', JSON.stringify(funds.data.result.map((f) => ({ c: f.code, b: f.balance }))));

  const transfers = await api('GET', `/api/saccos/${orgId}/funds/transfers`, ownerTok);
  await expect(transfers.status === 200 && transfers.data.result.length === 1 && transfers.data.result[0].from_code === 'EXPANSION' && transfers.data.result[0].to_code === 'EDUCATION',
    'transfers list shows EXPANSION -> EDUCATION');

  const sumF = await api('GET', `/api/saccos/${orgId}/funds/summary`, ownerTok);
  await expect(sumF.status === 200 && sumF.data.result.fund_count === 3 && sumF.data.result.total_balance === 40000,
    'funds summary: 3 funds, total balance 40000', JSON.stringify(sumF.data.result));

  // ---------- 6. Archive semantics ----------
  await section('Archive semantics');
  const archiveBalanced = await api('POST', `/api/saccos/${orgId}/funds/${fCId}/archive`, ownerTok);
  await expect(archiveBalanced.status === 200 && archiveBalanced.data.result.status === 'ARCHIVED', 'empty RESERVE fund archived');
  const archiveWithBalance = await api('POST', `/api/saccos/${orgId}/funds/${fAId}/archive`, ownerTok);
  await expect(archiveWithBalance.status === 400 && archiveWithBalance.data.code === 'SACCOS_FUND_HAS_BALANCE', 'fund with balance cannot archive');
  const contributeArchived = await api('POST', `/api/saccos/${orgId}/funds/${fCId}/contribute`, m1Tok, { amount: 100 });
  await expect(contributeArchived.status === 400 && contributeArchived.data.code === 'SACCOS_FUND_STATE', 'contribute to archived fund -> SACCOS_FUND_STATE');
  const transferFromArchived = await api('POST', `/api/saccos/${orgId}/funds/transfers`, ownerTok, { fromFundId: fCId, toFundId: fBId, amount: 1000 });
  await expect(transferFromArchived.status === 400 && transferFromArchived.data.code === 'SACCOS_FUND_STATE', 'transfer from archived fund -> SACCOS_FUND_STATE');

  // ---------- 7. Loan-loss reserves ----------
  await section('Loan-loss reserves');
  const apply1 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1Tok, { amount: 100000, termMonths: 12, purpose: 'Chomeka' });
  await api('POST', `/api/saccos/${orgId}/loans/applications/${apply1.data.result.id}/approve`, ownerTok);
  let loan1 = await pool.query(`SELECT id, status FROM saccos_loans WHERE application_id = $1`, [apply1.data.result.id]);
  if (loan1.rows[0].status === 'PENDING') await api('POST', `/api/saccos/${orgId}/loans/${loan1.rows[0].id}/disburse`, ownerTok);
  const loan1Id = loan1.rows[0].id;

  const apply2 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m2Tok, { amount: 50000, termMonths: 6, purpose: 'Biashara' });
  await api('POST', `/api/saccos/${orgId}/loans/applications/${apply2.data.result.id}/approve`, ownerTok);
  let loan2 = await pool.query(`SELECT id, status FROM saccos_loans WHERE application_id = $1`, [apply2.data.result.id]);
  if (loan2.rows[0].status === 'PENDING') await api('POST', `/api/saccos/${orgId}/loans/${loan2.rows[0].id}/disburse`, ownerTok);
  const loan2Id = loan2.rows[0].id;

  const memberProv = await api('POST', `/api/saccos/${orgId}/loan-loss/provision`, m1Tok, { loanId: loan1Id, amount: 20000 });
  await expect(memberProv.status === 403 && memberProv.data.code === 'SACCOS_RBAC', 'member cannot provision -> 403');

  const missingLoan = await api('POST', `/api/saccos/${orgId}/loan-loss/provision`, ownerTok, { loanId: 999999, amount: 1000 });
  await expect(missingLoan.status === 404 && missingLoan.data.code === 'SACCOS_LOAN_NOT_FOUND', 'provision unknown loan -> 404');

  const prov1 = await api('POST', `/api/saccos/${orgId}/loan-loss/provision`, ownerTok, { loanId: loan1Id, amount: 20000, ratePercent: 20 });
  await expect(prov1.status === 201 && String(prov1.data.result.reference_id).startsWith('LLR-') && prov1.data.result.status === 'PROVISIONED'
    && prov1.data.result.provision_amount === 20000 && prov1.data.result.provision_rate_percent === 20,
    'provision loan1 20000 @20% -> LLR-* PROVISIONED');

  const dupProv = await api('POST', `/api/saccos/${orgId}/loan-loss/provision`, ownerTok, { loanId: loan1Id, amount: 5000 });
  await expect(dupProv.status === 400 && dupProv.data.code === 'SACCOS_LLR_EXISTS', 'second provision on same loan -> SACCOS_LLR_EXISTS');

  const prov2 = await api('POST', `/api/saccos/${orgId}/loan-loss/provision`, ownerTok, { loanId: loan2Id, amount: 10000, ratePercent: 20 });
  await expect(prov2.status === 201 && prov2.data.result.status === 'PROVISIONED', 'provision loan2 10000');
  const llr2Id = prov2.data.result.id;

  const pnl = await api('GET', `/api/saccos/${orgId}/accounting/income-statement`, ownerTok);
  await expect(pnl.status === 200 && Number(pnl.data.result.total_expense) === 30000,
    'P&L carries 30000 loan-loss expense (20000 + 10000)', JSON.stringify({ total_expense: pnl.data.result.total_expense, items: pnl.data.result.expense_items.map((e) => ({ code: e.account_code, bal: e.balance })) }));

  const release2 = await api('POST', `/api/saccos/${orgId}/loan-loss/${llr2Id}/release`, ownerTok);
  await expect(release2.status === 200 && release2.data.result.status === 'RELEASED', 'release loan2 provision -> RELEASED');
  const reRelease = await api('POST', `/api/saccos/${orgId}/loan-loss/${llr2Id}/release`, ownerTok);
  await expect(reRelease.status === 400 && reRelease.data.code === 'SACCOS_LLR_STATE', 're-release -> SACCOS_LLR_STATE');

  const llrList = await api('GET', `/api/saccos/${orgId}/loan-loss`, ownerTok);
  const llrSummary = await api('GET', `/api/saccos/${orgId}/loan-loss/summary`, ownerTok);
  await expect(llrList.status === 200 && llrList.data.result.length === 2, 'loan-loss list has 2 rows');
  await expect(llrSummary.status === 200 && llrSummary.data.result.total === 2 && llrSummary.data.result.provisioned === 1
    && llrSummary.data.result.released === 1 && llrSummary.data.result.provisioned_total === 20000,
    'summary: 1 provisioned (20000) + 1 released', JSON.stringify(llrSummary.data.result));

  const pnl2 = await api('GET', `/api/saccos/${orgId}/accounting/income-statement`, ownerTok);
  await expect(pnl2.status === 200 && Number(pnl2.data.result.total_expense) === 20000, 'P&L expense settles to 20000 after release');

  // ---------- 8. Isolation + ADMIN oversight + audit ----------
  await section('Isolation + ADMIN oversight + audit');
  const o2 = await register(phone(8805), 'Hazina Pili');
  const o2Tok = o2.data.token;
  const s2 = await api('POST', '/api/v1/saccos', o2Tok, { name: 'Hazina Pili ' + suffix });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);

  const crossList = await api('GET', `/api/saccos/${s2Id}/funds`, m1Tok);
  await expect(crossList.status === 404, 'S1 member reading S2 funds -> 404');
  const crossCreate = await api('POST', `/api/saccos/${s2Id}/funds`, ownerTok, { code: 'Z', name: 'Z' });
  await expect(crossCreate.status === 403 && crossCreate.data.code === 'SACCOS_NOT_MEMBER', 'S1 owner creating on S2 -> 403');
  const crossProv = await api('POST', `/api/saccos/${s2Id}/loan-loss/provision`, ownerTok, { loanId: loan1Id, amount: 100 });
  await expect(crossProv.status === 403 && crossProv.data.code === 'SACCOS_NOT_MEMBER', 'S1 owner provisioning on S2 -> 403');

  const adminTok = await makeAdmin(await register(phone(8806), 'Ododo Hazina'));
  const adminFunds = await api('GET', `/api/saccos/${orgId}/funds`, adminTok);
  const adminSummary = await api('GET', `/api/saccos/${orgId}/funds/summary`, adminTok);
  const adminLlrs = await api('GET', `/api/saccos/${orgId}/loan-loss/summary`, adminTok);
  await expect(adminTok && adminFunds.status === 200 && adminFunds.data.result.length === 3, 'platform ADMIN lists all funds');
  await expect(adminSummary.status === 200 && adminSummary.data.result.total_balance === 40000, 'platform ADMIN funds summary');
  await expect(adminLlrs.status === 200 && adminLlrs.data.result.total === 2, 'platform ADMIN loan-loss summary');

  const audit = await pool.query(`SELECT action FROM audit_logs WHERE action LIKE 'SACCOS_FUND%' OR action LIKE 'SACCOS_LLR%'`);
  await expect(audit.rows.length >= 6, 'audit trail has fund + loan-loss actions');

  console.log(`\nSACCOS FUNDS: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });