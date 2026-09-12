/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - ACCOUNTING
 * Increment 6 regression: entity-scoped bookkeeping + financial
 * statements on the shared ledger. OWNER/BOARD open an accounting
 * period (PER-*), book internal journals (ACC-*) through it via
 * claim + postJournal against `SACCOS<id>_*` ledger accounts, and
 * close it into an immutable CLOSED state with a statements
 * snapshot (reopen CLOSED->OPEN is the only escape). Statements
 * (chart, trial balance, income statement, balance sheet) are
 * computed from ledger_accounts + journal_entries scoped to the
 * entity; members read, OWNER/BOARD write, cross-entity 404,
 * platform ADMIN oversight, audit trail.
 * Config saccos.config.accounting {requirePeriodForBooking,
 * defaultPeriodDays}. Suite 50.
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
  for (let i = 0; i < 3; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
  }
  // Fresh OTP re-login fallback so a transient refresh hiccup can't orphan the
  // suite into silent 401s later.
  const fresh = await register(reg.data.user.phone_number, reg.data.user.full_name);
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [fresh.data.user.id, 'ADMIN']);
  for (let i = 0; i < 3; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: fresh.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
  }
  throw new Error('makeAdmin: could not mint an ADMIN token for phone ' + reg.data.user.phone_number);
}
function nowSuffix() { return String(Date.now()).slice(-6); }

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  async function addMember(ownerTok, orgId, pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return reg;
  }

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (106_saccos_accounting)');
  const perCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_accounting_periods'`);
  await expect(['reference_id', 'label', 'start_date', 'end_date', 'status', 'snapshot'].every((c) => perCols.rows.some((r) => r.column_name === c)),
    'saccos_accounting_periods columns present');
  const entCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_accounting_entries'`);
  await expect(['reference_id', 'kind', 'amount', 'debit_account_code', 'credit_account_code', 'journal_group'].every((c) => entCols.rows.some((r) => r.column_name === c)),
    'saccos_accounting_entries columns present');

  // ---------- 2. Setup + guards ----------
  await section('Setup + guards');
  const ownerReg = await register(phone(6001), 'Uhasibu Mkuu');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Hesabu Shahada ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  const m1 = await addMember(ownerTok, orgId, 6002, 'Mwenyewe Hesabu');
  const m2 = await addMember(ownerTok, orgId, 6003, 'Mwanahisabu');

  const memberOpen = await api('POST', `/api/saccos/${orgId}/accounting/periods`, m1.data.token, { label: 'Si mimi' });
  await expect(memberOpen.status === 403 && memberOpen.data.code === 'SACCOS_RBAC', 'member cannot open period -> 403');

  const memberBook = await api('POST', `/api/saccos/${orgId}/accounting/entries`, m1.data.token, { kind: 'EXPENSE', amount: 1000, description: 'X' });
  await expect(memberBook.status === 403 && memberBook.data.code === 'SACCOS_RBAC', 'member cannot book entry -> 403');

  const noPeriod = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'EXPENSE', amount: 1000 });
  await expect(noPeriod.status === 400 && noPeriod.data.code === 'SACCOS_ACC_PERIOD_OPEN', 'booking with no OPEN period -> SACCOS_ACC_PERIOD_OPEN');

  const unknownSaccos = await api('GET', `/api/saccos/999999/accounting/trial-balance`, ownerTok);
  await expect(unknownSaccos.status === 404, 'unknown SACCOS statement -> 404');

  // ---------- 3. Period lifecycle ----------
  await section('Period lifecycle');
  const open = await api('POST', `/api/saccos/${orgId}/accounting/periods`, ownerTok, { label: 'Robo Ya 1' });
  await expect(open.status === 201 && String(open.data.result.reference_id).startsWith('PER-') && open.data.result.status === 'OPEN',
    'owner opens period -> PER-* OPEN', `${open.status}/${open.data.code || ''}`);
  const periodId = open.data.result.id;

  const dblOpen = await api('POST', `/api/saccos/${orgId}/accounting/periods`, ownerTok, { label: 'Dakika' });
  await expect(dblOpen.status === 400 && dblOpen.data.code === 'SACCOS_ACC_PERIOD_ALREADY_OPEN', 'second OPEN period -> SACCOS_ACC_PERIOD_ALREADY_OPEN');

  const badRange = await api('POST', `/api/saccos/${orgId}/accounting/periods`, ownerTok, { startDate: '2026-02-01', endDate: '2026-01-01' });
  await expect(badRange.status === 400 && badRange.data.code === 'SACCOS_ACC_PERIOD_RANGE', 'end before start -> SACCOS_ACC_PERIOD_RANGE');

  // ---------- 4. Bookkeeping ----------
  await section('Bookkeeping journals');
  const badKind = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'BONUS', amount: 5000 });
  await expect(badKind.status === 400 && badKind.data.code === 'SACCOS_ACC_ENTRY_KIND', 'bad kind -> SACCOS_ACC_ENTRY_KIND');

  const zeroAmt = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'EXPENSE', amount: 0 });
  await expect(zeroAmt.status === 400 && zeroAmt.data.code === 'SACCOS_ACC_AMOUNT', 'zero amount -> SACCOS_ACC_AMOUNT');

  const unknownAcc = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'EXPENSE', amount: 5000, accountCode: 'NOPE' });
  await expect(unknownAcc.status === 400 && unknownAcc.data.code === 'SACCOS_ACC_ACCOUNT_UNKNOWN', 'unknown explicit account -> SACCOS_ACC_ACCOUNT_UNKNOWN');

  const exp = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'EXPENSE', amount: 10000, description: 'Kod za ofisi' });
  await expect(exp.status === 201 && String(exp.data.result.reference_id).startsWith('ACC-') && exp.data.result.kind === 'EXPENSE'
    && exp.data.result.amount === 10000 && exp.data.result.debit_account_code === `SACCOS${orgId}_GENERAL_EXPENSE`
    && exp.data.result.credit_account_code === `SACCOS${orgId}_OPERATING_CASH`,
    'EXPENSE 10000 booked -> ACC-* (DR GENERAL_EXPENSE / CR OPERATING_CASH)');

  const dup = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'EXPENSE', amount: 10000, referenceId: exp.data.result.reference_id });
  await expect(dup.status === 201 && dup.data.result.dedup === true, 'same reference retried -> dedup (no double posting)');

  const inc = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'INCOME', amount: 25000, description: 'Ada za usindikaji' });
  await expect(inc.status === 201 && inc.data.result.kind === 'INCOME' && inc.data.result.debit_account_code === `SACCOS${orgId}_OPERATING_CASH`
    && inc.data.result.credit_account_code === `SACCOS${orgId}_OTHER_INCOME`,
    'INCOME 25000 booked (DR OPERATING_CASH / CR OTHER_INCOME)');

  const entriesList = await api('GET', `/api/saccos/${orgId}/accounting/entries`, m1.data.token);
  await expect(entriesList.status === 200 && entriesList.data.result.length === 2, 'member lists 2 entries');

  const periodFiltered = await api('GET', `/api/saccos/${orgId}/accounting/entries?periodId=${periodId}`, m1.data.token);
  await expect(periodFiltered.status === 200 && periodFiltered.data.result.length === 2, 'period-filtered entries');

  // ---------- 5. Statements ----------
  await section('Statements');
  const trial = await api('GET', `/api/saccos/${orgId}/accounting/trial-balance`, m1.data.token);
  const tb = trial.data.result;
  await expect(trial.status === 200 && tb.balanced === true && tb.total_debit === tb.total_credit && tb.total_debit === 35000,
    'trial balance balanced (35000 / 35000)', JSON.stringify({ d: tb.total_debit, c: tb.total_credit }));

  const expAcc = tb.balances.find((b) => b.account_code === `SACCOS${orgId}_GENERAL_EXPENSE`);
  const cashAcc = tb.balances.find((b) => b.account_code === `SACCOS${orgId}_OPERATING_CASH`);
  await expect(expAcc && expAcc.balance === 10000 && cashAcc && cashAcc.balance === 15000,
    'balances: GENERAL_EXPENSE 10000, OPERATING_CASH 15000', JSON.stringify({ e: expAcc && expAcc.balance, c: cashAcc && cashAcc.balance }));

  const pnl = (await api('GET', `/api/saccos/${orgId}/accounting/income-statement`, m1.data.token)).data.result;
  await expect(pnl.total_revenue === 25000 && pnl.total_expense === 10000 && pnl.net_income === 15000,
    'P&L: revenue 25000, expense 10000, net 15000');

  const bs = (await api('GET', `/api/saccos/${orgId}/accounting/balance-sheet`, m1.data.token)).data.result;
  await expect(bs.total_assets === 15000 && bs.total_equity === 15000 && bs.balanced === true,
    'balance sheet: assets = equity (15000)');

  const chart = (await api('GET', `/api/saccos/${orgId}/accounting/chart`, m2.data.token)).data.result;
  const types = Object.keys(chart.grouped);
  await expect(chart.grouped.ASSET.some((a) => a.account_code === `SACCOS${orgId}_OPERATING_CASH`)
    && chart.grouped.EXPENSE.some((a) => a.account_code === `SACCOS${orgId}_GENERAL_EXPENSE`)
    && chart.grouped.REVENUE.some((a) => a.account_code === `SACCOS${orgId}_OTHER_INCOME`)
    && types.includes('ASSET') && types.includes('EXPENSE') && types.includes('REVENUE'),
    'chart grouped: ASSET/EXPENSE/REVENUE entity accounts');

  // ---------- 6. Close / reopen ----------
  await section('Close + reopen');
  const memberClose = await api('POST', `/api/saccos/${orgId}/accounting/periods/${periodId}/close`, m1.data.token);
  await expect(memberClose.status === 403 && memberClose.data.code === 'SACCOS_RBAC', 'member cannot close -> 403');

  const close = await api('POST', `/api/saccos/${orgId}/accounting/periods/${periodId}/close`, ownerTok);
  await expect(close.status === 200 && close.data.result.status === 'CLOSED' && close.data.result.snapshot
    && close.data.result.snapshot.income_statement.net_income === 15000,
    'close -> CLOSED + snapshot net 15000', JSON.stringify(close.data.result.snapshot && close.data.result.snapshot.income_statement));

  const bookClosed = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'EXPENSE', amount: 5000 });
  await expect(bookClosed.status === 400 && bookClosed.data.code === 'SACCOS_ACC_PERIOD_OPEN', 'booking with no OPEN period after close -> SACCOS_ACC_PERIOD_OPEN');

  const reClose = await api('POST', `/api/saccos/${orgId}/accounting/periods/${periodId}/close`, ownerTok);
  await expect(reClose.status === 400 && reClose.data.code === 'SACCOS_ACC_PERIOD_STATE', 'close CLOSED again -> SACCOS_ACC_PERIOD_STATE');

  const reopen = await api('POST', `/api/saccos/${orgId}/accounting/periods/${periodId}/reopen`, ownerTok);
  await expect(reopen.status === 200 && reopen.data.result.status === 'OPEN' && reopen.data.result.snapshot === null, 'reopen CLOSED -> OPEN (snapshot cleared)');

  await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'EXPENSE', amount: 5000, description: 'Gharama za ziada' });
  const close2 = await api('POST', `/api/saccos/${orgId}/accounting/periods/${periodId}/close`, ownerTok);
  await expect(close2.status === 200 && close2.data.result.snapshot.income_statement.net_income === 10000,
    'reclose -> snapshot net 10000 (expense 15000 / revenue 25000)');

  // ---------- 7. Isolation + oversight ----------
  await section('Isolation + oversight');
  const o2 = await register(phone(6004), 'Uhasibu Pili');
  const o2Tok = o2.data.token;
  const s2 = await api('POST', '/api/v1/saccos', o2Tok, { name: 'Hesabu Pili ' + suffix });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);
  await api('POST', `/api/saccos/${s2Id}/accounting/periods`, o2Tok, { label: 'Robo Pili' });
  await api('POST', `/api/saccos/${s2Id}/accounting/entries`, o2Tok, { kind: 'EXPENSE', amount: 777, description: 'Gharama ya S2' });

  const crossTrial = await api('GET', `/api/saccos/${s2Id}/accounting/trial-balance`, m1.data.token);
  await expect(crossTrial.status === 404, 'S1 member cannot read S2 statements -> 404');
  const crossPeriod = await api('GET', `/api/saccos/${s2Id}/accounting/periods`, ownerTok);
  await expect(crossPeriod.status === 404, 'S1 owner cannot read S2 periods -> 404');

  const s1trialAgain = (await api('GET', `/api/saccos/${orgId}/accounting/trial-balance`, ownerTok)).data.result;
  await expect(s1trialAgain.total_debit === 40000 && s1trialAgain.total_credit === 40000 && s1trialAgain.balanced === true,
    'S1 books isolated from S2 (still balanced at 40000/40000)', JSON.stringify({ d: s1trialAgain.total_debit, c: s1trialAgain.total_credit }));

  const adminTok = await makeAdmin(await register(phone(6005), 'Odoa Hesabu'));
  const adminTrial = await api('GET', `/api/saccos/${orgId}/accounting/trial-balance`, adminTok);
  const adminSummary = await api('GET', `/api/saccos/${orgId}/accounting/summary`, adminTok);
  await expect(adminTok && adminTrial.status === 200 && adminTrial.data.result.balanced === true, 'platform ADMIN reads S1 trial balance');
  await expect(adminSummary.status === 200 && adminSummary.data.result.total_entries === 3 && adminSummary.data.result.closed_periods === 1,
    'platform ADMIN reads accounting summary');

  const ownerSum = (await api('GET', `/api/saccos/${orgId}/accounting/summary`, ownerTok)).data.result;
  await expect(ownerSum.open_periods === 0 && ownerSum.closed_periods === 1 && ownerSum.total_entries === 3, 'owner accounting summary totals');

  const audit = await pool.query(`SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'SACCOS_ACC%'`);
  await expect(audit.rows.length >= 4, 'audit trail has accounting actions');

  console.log(`\nSACCOS ACCOUNTING: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });