/* ============================================================
 * AFRIKOBA GLOBAL - MERCHANT PAYROLL COMPLETION (increment 21d)
 * Merchant-funded payroll: schedules from MERCHANT_BALANCE, progressive
 * TZS PAYE brackets, per-payslip gross/tax/deductions/net, worker
 * snapshots, RBAC + isolation, step-up signed payment, and legacy
 * treasury-funded payroll regression.
 * ============================================================ */
const crypto = require('crypto');
const BASE = process.env.MERCHANT_PAYROLL_TEST_BASE || process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0;
let failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) { failed++; failures.push(label); console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`); }
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra); }
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
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
  await pool.query('UPDATE users SET role = $2 WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
  return refresh.data.token;
}
async function fundWallet(userId, amount, prefix) {
  await pool.query(
    `INSERT INTO transactions (user_id, type, total_charged, wallet_amount, commission, status, reference_id, meta)
     VALUES ($1, 'DEPOSIT', $2, $2, 0, 'SUCCESS', $3, $4::jsonb)
     ON CONFLICT (reference_id) DO NOTHING`,
    [userId, amount, `${prefix}-${String(Date.now()).slice(-6)}`, JSON.stringify({ feature: 'test_fund' })]
  );
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
}
async function walletOf(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}
async function ledgerTotal(code, direction, ref) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(j.amount),0) AS total FROM journal_entries j
     JOIN ledger_accounts a ON a.id = j.account_id
     WHERE a.account_code = $1 AND j.direction = $2 AND ($3::text IS NULL OR j.reference_id = $3)`,
    [code, direction, ref || null]
  );
  return Number(r.rows[0].total);
}
async function issueStepup(userId, purpose = 'PAYROLL_PAY') {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO stepup_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1,$2,$3, NOW() + interval '10 minutes')`,
    [userId, purpose, hash]
  );
  return raw;
}

const PAYE = [
  { min: 0,      max: 270000, rate: 8 },
  { min: 270000, max: 520000, rate: 20 },
  { min: 520000, max: 760000, rate: 25 },
  { min: 760000, max: null,    rate: 30 },
];
function taxOf(gross) {
  let tax = 0;
  for (const b of PAYE) {
    const lo = Number(b.min);
    const hi = b.max == null ? gross : Math.min(gross, Number(b.max));
    if (hi <= lo) continue;
    tax += (hi - lo) * (Number(b.rate) / 100);
  }
  return Math.round(tax * 100) / 100;
}
// Expected payroll numbers for the test run
const W = {
  a: { base: 1000000, adj: [],              taxable: true  },
  b: { base: 500000,  adj: [],              taxable: true  },
  c: { base: 400000,  adj: [],              taxable: false },
  d: { base: 200000,  adj: [{ type: 'bonus', amount: 50000 }, { type: 'deduction', amount: -20000 }], taxable: true },
};
function compute({ base, adj, taxable }) {
  const bonus = (adj || []).reduce((s, a) => s + Math.max(0, Number(a.amount) || 0), 0);
  const ded = (adj || []).reduce((s, a) => s + Math.abs(Math.min(0, Number(a.amount) || 0)), 0);
  const gross = base + bonus;
  const tax = taxable ? taxOf(gross) : 0;
  const net = Math.round((gross - tax - ded) * 100) / 100;
  return { gross, tax, ded, net, adjTotal: bonus - ded };
}
const C = { a: compute(W.a), b: compute(W.b), c: compute(W.c), d: compute(W.d) };
const NET_TOTAL_N = (C.a.net + C.b.net + C.c.net + C.d.net);
const TAX_TOTAL = C.a.tax + C.b.tax + C.c.tax + C.d.tax;
const GROSS_TOTAL = C.a.gross + C.b.gross + C.c.gross + C.d.gross;

(async () => {
  const s = String(Date.now()).slice(-6);
  const owner = await register(`255810${s}`, 'Mwenye Payroll');
  const ownerB = await register(`255811${s}`, 'Mwenye Wengine');
  const payer = await register(`255812${s}`, 'Mnunuzi Kodi');
  const wA = await register(`255813${s}`, 'Mfanyakazi Alpha');
  const wB = await register(`255814${s}`, 'Mfanyakazi Beta');
  const wC = await register(`255815${s}`, 'Mfanyakazi Gamma');
  const wD = await register(`255816${s}`, 'Mfanyakazi Delta');
  const admin = await register(`255817${s}`, 'Meri Payroll');
  await expect(owner.data.token && ownerB.data.token && payer.data.token && wA.data.token && wB.data.token && wC.data.token && wD.data.token, 'Users registered');
  const oToken = owner.data.token;
  const oBToken = ownerB.data.token;
  const pToken = payer.data.token;
  const aToken = await makeAdmin(admin);
  await expect(!!aToken, 'Reviewer promoted to ADMIN');

  const ownerId = owner.data.user.id;
  const wAId = wA.data.user.id;
  const wBId = wB.data.user.id;
  const wCId = wC.data.user.id;
  const wDId = wD.data.user.id;

  // ============ merchant setup + funds ============
  await section('Merchant setup + proceeds accumulation');
  const reg = await api('POST', '/api/merchant/register', oToken, { name: `Payroll Store ${s}`, business_type: 'RETAIL', phone: `255810${s}` });
  await expect(reg.status === 200 && reg.data.merchant.id, 'Merchant A registered', `status=${reg.status}`);
  const merchantId = reg.data.merchant.id;

  const regB = await api('POST', '/api/merchant/register', oBToken, { name: `Other Store ${s}`, business_type: 'RETAIL', phone: `255811${s}` });
  await expect(regB.status === 200 && regB.data.merchant.id, 'Merchant B registered', `status=${regB.status}`);
  const merchantBId = regB.data.merchant.id;

  const conn = await api('POST', '/api/merchant/connected', oToken, { payout_type: 'MNO_PHONE', payout_reference: `255818${s}` });
  await expect(conn.status === 200 && conn.data.account.id, 'Merchant A connected account', `status=${conn.status}`);
  const connB = await api('POST', '/api/merchant/connected', oBToken, { payout_type: 'MNO_PHONE', payout_reference: `255819${s}` });
  await expect(connB.status === 200 && connB.data.account.id, 'Merchant B connected account', `status=${connB.status}`);

  const act = await api('PATCH', `/api/merchant/admin/connected/${conn.data.account.id}`, aToken, { status: 'ACTIVE' });
  await expect(act.status === 200 && act.data.account.status === 'ACTIVE', 'Merchant A account activated', `status=${act.status}`);

  await fundWallet(payer.data.user.id, 2500000, 'MPP');
  const pay = await api('POST', '/api/merchant/pay', pToken, { merchant_id: merchantId, amount: 2500000, description: 'Mapato ya payroll' });
  await expect(pay.status === 200 && !!pay.data.reference, 'Merchant receives 2,500,000 proceeds', `status=${pay.status}`);
  const balBefore = (await pool.query('SELECT balance FROM connected_merchant_accounts WHERE merchant_id=$1', [merchantId])).rows[0].balance;
  await expect(Number(balBefore) >= NET_TOTAL_N, 'Proceeds cover the payroll net total', `balance=${balBefore} need=${NET_TOTAL_N}`);

  // ============ auth gating ============
  await section('Auth gating + RBAC');
  const unauth = await api('GET', '/api/merchant/payroll/schedules');
  await expect(unauth.status === 401, 'Unauthenticated blocked from merchant payroll', `status=${unauth.status}`);
  const notMerchant = await api('GET', '/api/merchant/payroll/schedules', pToken);
  await expect(notMerchant.status === 404, 'Non-merchant user blocked (404)', `status=${notMerchant.status}`);

  // ============ schedule + tax config ============
  await section('Merchant payroll schedule (default PAYE)');
  const create = await api('POST', '/api/merchant/payroll/schedules', oToken, { name: 'Malipo ya Wafanyakazi', frequency: 'MONTHLY', dayOfCycle: 1, currency: 'TZS' });
  await expect(create.status === 200 && create.data.schedule.id, 'Merchant schedule created', `status=${create.status}`);
  const schedA = create.data.schedule;
  await expect(Number(schedA.merchant_id) === merchantId, 'Schedule anchored to merchant', `merchant_id=${schedA.merchant_id}`);
  await expect(schedA.currency === 'TZS', 'Schedule currency TZS');
  await expect(Array.isArray(schedA.tax_brackets) && Number(schedA.tax_brackets[0].rate) === 8 && Number(schedA.tax_brackets[1].rate) === 20 && Number(schedA.tax_brackets[2].rate) === 25 && Number(schedA.tax_brackets[3].rate) === 30, 'Default PAYE brackets stored', `brackets=${JSON.stringify(schedA.tax_brackets)}`);
  await expect(schedA.treasury_wallet_id == null, 'No treasury wallet on merchant schedule');

  const createB = await api('POST', '/api/merchant/payroll/schedules', oBToken, { name: 'Wengine Payroll', frequency: 'MONTHLY', dayOfCycle: 1 });
  await expect(createB.status === 200 && Number(createB.data.schedule.merchant_id) === merchantBId, 'Merchant B own schedule created', `status=${createB.status}`);
  const schedB = createB.data.schedule;

  const mine = await api('GET', '/api/merchant/payroll/schedules', oBToken);
  await expect(mine.status === 200 && mine.data.schedules.length === 1 && Number(mine.data.schedules[0].id) === schedB.id, 'Merchant B sees only own schedules', `count=${mine.data.schedules.length}`);

  // ============ entries ============
  await section('Schedule entries (bonus + deduction + non-taxable)');
  let st = 200;
  for (const [key, e] of [['a', W.a], ['b', W.b], ['c', W.c], ['d', W.d]]) {
    const idMap = { a: wAId, b: wBId, c: wCId, d: wDId }[key];
    const r = await api('POST', `/api/merchant/payroll/schedules/${schedA.id}/entries`, oToken, { userId: idMap, baseAmount: e.base, role: key.toUpperCase(), adjustments: e.adj, taxable: e.taxable });
    if (r.status !== 200) st = r.status;
  }
  await expect(st === 200, 'Four entries added to schedule A', `status=${st}`);

  const foreignEntry = await api('POST', `/api/merchant/payroll/schedules/${schedA.id}/entries`, oBToken, { userId: wDId, baseAmount: 100000 });
  await expect(foreignEntry.status === 403, 'Foreign merchant blocked from adding entries (403)', `status=${foreignEntry.status}`);

  const listS = await api('GET', '/api/merchant/payroll/schedules', oToken);
  const headA = listS.data.schedules.find(x => Number(x.id) === schedA.id);
  await expect(headA && headA.headcount === 4, 'Headcount 4 on schedule A', `headcount=${headA && headA.headcount}`);

  // ============ run ============
  await section('Run generation (progressive tax)');
  const run = await api('POST', '/api/merchant/payroll/runs', oToken, { scheduleId: schedA.id, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  await expect(run.status === 200 && run.data.run && run.data.run.id, 'Run generated', `status=${run.status}`);
  const runA = run.data.run;
  await expect(runA.funding_source === 'MERCHANT', 'Funding source MERCHANT');
  await expect(Number(runA.merchant_id) === merchantId, 'Run anchored to merchant');
  await expect(runA.treasury_wallet_id == null, 'Run has no treasury wallet');
  await expect(Number(runA.net_total) === NET_TOTAL_N, `Run net_total = ${NET_TOTAL_N}`, `net_total=${runA.net_total}`);
  await expect(Number(runA.tax_total) === TAX_TOTAL, `Run tax_total = ${TAX_TOTAL}`, `tax_total=${runA.tax_total}`);
  await expect(Number(runA.total_amount) === GROSS_TOTAL, `Run total_amount (gross) = ${GROSS_TOTAL}`, `total=${runA.total_amount}`);
  await expect(String(runA.status) === 'PENDING_APPROVAL', 'Run waits PENDING_APPROVAL', `status=${runA.status}`);

  const foreignRun = await api('POST', '/api/merchant/payroll/runs', oBToken, { scheduleId: schedA.id, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  await expect(foreignRun.status === 403, 'Foreign merchant blocked from running foreign schedule', `status=${foreignRun.status}`);

  // ============ payslip breakdown ============
  await section('Payslip gross/tax/deductions/net + worker snapshot');
  const slips = await api('GET', `/api/merchant/payroll/runs/${runA.id}/payslips`, oToken);
  await expect(slips.status === 200 && slips.data.payslips.length === 4, 'Four payslips on the run', `status=${slips.status}`);
  const byUser = {};
  for (const ps of slips.data.payslips) byUser[ps.user_id] = ps;
  const psA = byUser[wAId], psB = byUser[wBId], psC = byUser[wCId], psD = byUser[wDId];
  await expect(psA && Number(psA.gross_amount) === C.a.gross && Number(psA.tax_amount) === C.a.tax && Number(psA.net_amount) === C.a.net, 'Worker A gross/tax/net', `gross=${psA && psA.gross_amount} tax=${psA && psA.tax_amount} net=${psA && psA.net_amount}`);
  await expect(psB && Number(psB.tax_amount) === C.b.tax && Number(psB.net_amount) === C.b.net, 'Worker B tax/net', `tax=${psB && psB.tax_amount} net=${psB && psB.net_amount}`);
  await expect(psC && Number(psC.tax_amount) === 0 && Number(psC.net_amount) === C.c.net, 'Non-taxable worker C pays no tax', `tax=${psC && psC.tax_amount}`);
  await expect(psD && Number(psD.gross_amount) === C.d.gross && Number(psD.tax_amount) === C.d.tax && Number(psD.deductions_total) === C.d.ded && Number(psD.net_amount) === C.d.net && Number(psD.adjustments_total) === C.d.adjTotal, 'Worker D bonus/deduction/tax/net', `gross=${psD && psD.gross_amount} tax=${psD && psD.tax_amount} ded=${psD && psD.deductions_total} net=${psD && psD.net_amount}`);
  await expect(!!(psA && psA.employee_name) && !!psA.employee_phone, 'Worker A snapshot (name + phone)', `name=${psA && psA.employee_name}`);
  await expect(!!(psC && psC.employee_name) && !!psC.employee_phone, 'Worker C snapshot (name + phone)');

  // ============ step-up + payment ============
  await section('Step-up signed payment (MERCHANT_BALANCE journal)');
  const noStep = await api('POST', `/api/merchant/payroll/runs/${runA.id}/approve`, oToken);
  await expect(noStep.status === 403 && noStep.data.code === 'STEPUP_REQUIRED', 'Approve without step-up rejected', `status=${noStep.status}`);
  const stepA = await issueStepup(ownerId);
  const approve = await api('POST', `/api/merchant/payroll/runs/${runA.id}/approve`, oToken, { stepupToken: stepA });
  await expect(approve.status === 200 && approve.data.status === 'PAID', 'Run approved + fully paid', `status=${approve.status} result=${approve.data.status}`);

  await expect(await walletOf(wAId) === C.a.net, `Worker A wallet = ${C.a.net}`, `got=${await walletOf(wAId)}`);
  await expect(await walletOf(wBId) === C.b.net, `Worker B wallet = ${C.b.net}`, `got=${await walletOf(wBId)}`);
  await expect(await walletOf(wCId) === C.c.net, `Worker C wallet = ${C.c.net}`, `got=${await walletOf(wCId)}`);
  await expect(await walletOf(wDId) === C.d.net, `Worker D wallet = ${C.d.net}`, `got=${await walletOf(wDId)}`);

  const balAfter = (await pool.query('SELECT balance FROM connected_merchant_accounts WHERE merchant_id=$1', [merchantId])).rows[0].balance;
  await expect(Number(balAfter) === Number(balBefore) - NET_TOTAL_N, 'Merchant balance debited by net total', `balance=${balAfter}`);

  const payRefs = (await pool.query('SELECT ledger_ref FROM payroll_payslips WHERE run_id=$1 AND status=$2', [runA.id, 'PAID'])).rows.map(r => r.ledger_ref);
  await expect(payRefs.length === 4 && payRefs.every(r => (r || '').startsWith('PAY-')), 'All payslips PAID with PAY-* ledger refs', `refs=${JSON.stringify(payRefs)}`);
  let mbDr = 0;
  for (const ref of payRefs) mbDr += await ledgerTotal('MERCHANT_BALANCE', 'DR', ref);
  await expect(mbDr === NET_TOTAL_N, 'MERCHANT_BALANCE DR = net total across payslips', `dr=${mbDr}`);
  let cwCr = 0;
  for (const ref of payRefs) cwCr += await ledgerTotal('CUSTOMER_WALLET', 'CR', ref);
  await expect(cwCr === NET_TOTAL_N, 'CUSTOMER_WALLET CR = net total across payslips', `cr=${cwCr}`);

  const slipStatus = (await pool.query('SELECT status FROM payroll_payslips WHERE run_id=$1', [runA.id])).rows;
  await expect(slipStatus.length === 4 && slipStatus.every(r => r.status === 'PAID'), 'All payslips terminal PAID');

  const runRow = (await pool.query('SELECT status, approved_by FROM payroll_runs WHERE id=$1', [runA.id])).rows[0];
  await expect(runRow.status === 'PAID' && runRow.approved_by === ownerId, 'Run PAID with approved_by = owner', `status=${runRow.status}`);

  // ============ insufficient funds + pause ============
  await section('Insufficient balance + pause guards');
  const rerun = await api('POST', '/api/merchant/payroll/runs', oToken, { scheduleId: schedA.id, periodStart: '2026-10-01', periodEnd: '2026-10-31' });
  await expect(rerun.status === 400, 'Second run rejected: merchant balance insufficient', `status=${rerun.status} msg=${rerun.data.error}`);

  const foreignApprove = await api('POST', `/api/merchant/payroll/runs/${runA.id}/approve`, oBToken, { stepupToken: await issueStepup(ownerB.data.user.id) });
  await expect(foreignApprove.status === 403, 'Foreign merchant blocked from approving foreign run', `status=${foreignApprove.status}`);

  const pause = await api('PATCH', `/api/merchant/payroll/schedules/${schedA.id}/status`, oToken, { active: false });
  await expect(pause.status === 200 && pause.data.schedule.status === 'PAUSED', 'Schedule paused', `status=${pause.data.schedule.status}`);
  const pausedRun = await api('POST', '/api/merchant/payroll/runs', oToken, { scheduleId: schedA.id, periodStart: '2026-11-01', periodEnd: '2026-11-30' });
  await expect(pausedRun.status === 400, 'Run on paused schedule rejected', `status=${pausedRun.status}`);

  // ============ run list isolation ============
  await section('Run list isolation');
  const runsA = await api('GET', '/api/merchant/payroll/runs?schedule_id=' + schedA.id, oToken);
  await expect(runsA.status === 200 && runsA.data.runs.length === 1 && Number(runsA.data.runs[0].id) === runA.id, 'Merchant A sees own run (treasury run excluded)', `status=${runsA.status}`);
  const runsB = await api('GET', '/api/merchant/payroll/runs', oBToken);
  await expect(runsB.status === 200 && runsB.data.runs.length === 0, 'Merchant B sees no A runs', `count=${runsB.data.runs.length}`);

  // ============ legacy treasury regression ============
  await section('Legacy treasury-funded payroll regression');
  const tw = (await pool.query(
    `INSERT INTO treasury_wallets (name, balance, required_signatures, total_signers)
     VALUES ('Hazina ya 21d', 1000000, 2, 3) RETURNING id`
  )).rows[0];
  await pool.query('UPDATE treasury_wallets SET balance = 1000000 WHERE id = $1', [tw.id]);

  const tCreate = await api('POST', '/api/payroll/schedules', aToken, { name: 'Hazina Ratiba', treasuryWalletId: tw.id, frequency: 'MONTHLY' });
  await expect(tCreate.status === 200 && tCreate.data.schedule.id, 'Admin treasury schedule created', `status=${tCreate.status}`);
  const tSched = tCreate.data.schedule;
  await expect(tSched.merchant_id == null && tSched.tax_brackets == null, 'Treasury schedule: no merchant, no tax');

  const tEntry = await api('POST', `/api/payroll/schedules/${tSched.id}/entries`, aToken, { userId: wAId, baseAmount: 600000 });
  await expect(tEntry.status === 200, 'Treasury entry added', `status=${tEntry.status}`);

  const tRun = await api('POST', '/api/payroll/runs', aToken, { scheduleId: tSched.id, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  await expect(tRun.status === 200 && tRun.data.run.id, 'Treasury run generated', `status=${tRun.status}`);
  const tr = tRun.data.run;
  await expect(tr.funding_source === 'TREASURY' && Number(tr.tax_total) === 0 && Number(tr.net_total) === 600000, 'Treasury run: funding + zero tax + net 600000', `funding=${tr.funding_source} net=${tr.net_total}`);

  const runsAfter = await api('GET', '/api/merchant/payroll/runs', oToken);
  await expect(runsAfter.status === 200 && runsAfter.data.runs.length === 1 && Number(runsAfter.data.runs[0].id) === runA.id, 'Treasury run excluded from merchant A list', `count=${runsAfter.data.runs.length}`);

  const tStep = await issueStepup((await pool.query('SELECT id FROM users WHERE role=$1 ORDER BY id DESC LIMIT 1', ['ADMIN'])).rows[0].id);
  const tApprove = await api('POST', `/api/payroll/runs/${tr.id}/approve`, aToken, { stepupToken: tStep });
  await expect(tApprove.status === 200 && tApprove.data.status === 'PAID', 'Treasury run approved + paid', `status=${tApprove.status}`);
  await expect(await walletOf(wAId) === C.a.net + 600000, 'Worker A treasury credit applied', `got=${await walletOf(wAId)}`);
  const twBal = (await pool.query('SELECT balance FROM treasury_wallets WHERE id=$1', [tw.id])).rows[0].balance;
  await expect(Number(twBal) === 400000, 'Treasury wallet debited 600000', `balance=${twBal}`);

  // ============ finale ============
  console.log('\n========================================');
  console.log(`MERCHANT PAYROLL: ${passed} passed, ${failed} failed`);
  if (failed) console.log('FAILURES: ' + failures.join(' | '));
  process.exit(failed ? 1 : 0);
})();