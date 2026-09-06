/* ============================================================
 * AFRIKOBA GLOBAL - MERCHANT CONNECTED ACCOUNTS + PAYOUTS REGRESSION
 * Stripe-Connect-style: register merchant -> connect payout account ->
 * admin KYC-activate -> accept payments (MERCHANT_BALANCE accumulation) ->
 * request settlement -> admin execute against the ledger (fee + net).
 * ============================================================ */
const BASE = process.env.MERCHANT_TEST_BASE || 'http://127.0.0.1:3001';
const pool = require('../src/config/db');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
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
async function ledgerTotal(code, direction, ref) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(j.amount),0) AS total FROM journal_entries j
     JOIN ledger_accounts a ON a.id = j.account_id
     WHERE a.account_code = $1 AND j.direction = $2 AND ($3::text IS NULL OR j.reference_id = $3)`,
    [code, direction, ref || null]
  );
  return Number(r.rows[0].total);
}

(async () => {
  const s = String(Date.now()).slice(-6);
  const merchantUser = await register(`255740${s}`, 'Mjasiri Alpha');
  const payer = await register(`255741${s}`, 'Mnunuzi Beta');
  const admin = await register(`255742${s}`, 'Meri Admin');
  await expect(merchantUser.data.token && payer.data.token && admin.data.token, 'Users registered');
  const mToken = merchantUser.data.token;
  const pToken = payer.data.token;
  const aToken = await makeAdmin(admin);
  await expect(!!aToken, 'Reviewer promoted to ADMIN');

  await fundWallet(merchantUser.data.user.id, 50000, 'MWA');
  await fundWallet(payer.data.user.id, 120000, 'MPA');

  // ---------- merchant + connected account ----------
  await section('Merchant register + connect payout account');
  const reg = await api('POST', '/api/merchant/register', mToken, { name: `Afrikoba Store ${s}`, business_type: 'RETAIL', phone: `255740${s}` });
  await expect(reg.status === 200 && reg.data.merchant.id, 'Merchant registered', `status=${reg.status}`);
  const merchantId = reg.data.merchant.id;

  const badConn = await api('POST', '/api/merchant/connected', mToken, { payout_type: 'MNO_PHONE' });
  await expect(badConn.status === 400, 'Connect without reference rejected', `status=${badConn.status}`);

  const conn = await api('POST', '/api/merchant/connected', mToken, { payout_type: 'MNO_PHONE', payout_reference: `255745${s}` });
  await expect(conn.status === 200 && conn.data.account.status === 'PENDING' && conn.data.account.payout_reference === `255745${s}`, 'Connected account created (PENDING)', `status=${conn.status}`);
  const accountId = conn.data.account.id;

  const mine = await api('GET', '/api/merchant/connected', mToken);
  await expect(mine.status === 200 && mine.data.account.id === accountId && Number(mine.data.account.balance) === 0, 'My connected account visible with balance 0', `status=${mine.status}`);

  // Non-owner blocked
  const notOwner = await api('GET', '/api/merchant/payouts', pToken);
  await expect(notOwner.status === 404, 'Non-merchant blocked from payouts', `status=${notOwner.status}`);

  // ---------- legacy accept (not yet activated) ----------
  await section('Accept payment before activation (legacy rails)');
  const w0 = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [payer.data.user.id])).rows[0].wallet_balance;
  const pay0 = await api('POST', '/api/merchant/pay', pToken, { merchant_id: merchantId, amount: 2000, description: 'Kabla ya activation' });
  await expect(pay0.status === 200 && !!pay0.data.reference, 'Legacy payment accepted', `status=${pay0.status}`);
  const w1 = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [payer.data.user.id])).rows[0].wallet_balance;
  await expect(Number(w0) - Number(w1) === 2000, 'Payer debited 2000 (legacy path)', `w0=${w0} w1=${w1}`);

  // non-admin cannot activate
  const activate403 = await api('PATCH', `/api/merchant/admin/connected/${accountId}`, pToken, { status: 'ACTIVE' });
  await expect(activate403.status === 403, 'Non-admin blocked from activating account', `status=${activate403.status}`);

  // ---------- admin activates -> proceeds accumulate ----------
  await section('Admin activation + MERCHANT_BALANCE accumulation');
  const act = await api('PATCH', `/api/merchant/admin/connected/${accountId}`, aToken, { status: 'ACTIVE' });
  await expect(act.status === 200 && act.data.account.status === 'ACTIVE' && !!act.data.account.kyc_verified_at, 'Admin KYC-activates connected account', `status=${act.status}`);

  const pay1 = await api('POST', '/api/merchant/pay', pToken, { merchant_id: merchantId, amount: 4000, description: 'Baada ya activation' });
  await expect(pay1.status === 200, 'Payment accepted after activation', `status=${pay1.status}`);
  const bal1 = (await pool.query('SELECT balance FROM connected_merchant_accounts WHERE id = $1', [accountId])).rows[0];
  await expect(Number(bal1.balance) === 4000, 'Connected balance accumulated 4000', `balance=${bal1.balance}`);
  const mbTotal = await ledgerTotal('MERCHANT_BALANCE', 'CR', pay1.data.reference);
  await expect(mbTotal === 4000, 'MERCHANT_BALANCE ledger CR = 4000', `total=${mbTotal}`);

  const listAdmin = await api('GET', '/api/merchant/admin/connected', aToken);
  await expect(listAdmin.status === 200 && listAdmin.data.accounts.some((x) => x.id === accountId && x.merchant_name.includes(s)), 'Admin lists connected accounts', `status=${listAdmin.status}`);

  // ---------- payout request ----------
  await section('Payout request (reserve) + admin execution');
  const over = await api('POST', '/api/merchant/payouts', mToken, { amount: 99999 });
  await expect(over.status === 400, 'Payout over balance rejected', `status=${over.status}`);

  const req = await api('POST', '/api/merchant/payouts', mToken, { amount: 3000 });
  await expect(req.status === 200 && req.data.payout.status === 'PENDING' && Number(req.data.payout.gross_amount) === 3000, 'Payout requested (PENDING 3000)', `status=${req.status}`);
  const payoutId = req.data.payout.id;
  await expect(Number(req.data.payout.fee_amount) === 30 && Number(req.data.payout.net_amount) === 2970, '1% fee (30) + net (2970)', `g=${req.data.payout.gross_amount} f=${req.data.payout.fee_amount} n=${req.data.payout.net_amount}`);
  const bal2 = (await pool.query('SELECT balance FROM connected_merchant_accounts WHERE id = $1', [accountId])).rows[0];
  await expect(Number(bal2.balance) === 1000, 'Balance reserved to 1000 after request', `balance=${bal2.balance}`);

  const exec403 = await api('POST', `/api/merchant/admin/payouts/${payoutId}/execute`, pToken);
  await expect(exec403.status === 403, 'Non-admin cannot execute payout', `status=${exec403.status}`);

  const hist = await api('GET', '/api/merchant/payouts', mToken);
  await expect(hist.status === 200 && hist.data.payouts.length === 1 && hist.data.payouts[0].id === payoutId, 'Merchant sees payout in history', `status=${hist.status}`);

  const exec = await api('POST', `/api/merchant/admin/payouts/${payoutId}/execute`, aToken);
  await expect(exec.status === 200 && exec.data.payout.status === 'EXECUTED' && !!exec.data.payout.executed_at, 'Admin executes payout', `status=${exec.status}`);

  const mbd = await ledgerTotal('MERCHANT_BALANCE', 'DR', req.data.payout.payout_reference);
  await expect(mbd === 3000, 'MERCHANT_BALANCE ledger DR = 3000 on settlement', `total=${mbd}`);
  const feeTotal = await ledgerTotal('PLATFORM_FEES', 'CR', req.data.payout.payout_reference);
  await expect(feeTotal === 30, 'PLATFORM_FEES CR = 30 (1% fee)', `total=${feeTotal}`);
  const mnoTotal = await ledgerTotal('MNO_CLEARING', 'CR', req.data.payout.payout_reference);
  await expect(mnoTotal === 2970, 'MNO_CLEARING CR = 2970 (net)', `total=${mnoTotal}`);

  const txs = await pool.query(`SELECT * FROM transactions WHERE type = 'MERCHANT_PAYOUT' AND reference_id = $1`, [req.data.payout.payout_reference]);
  await expect(txs.rows.length === 1 && Number(txs.rows[0].total_charged) === 3000 && Number(txs.rows[0].commission) === 30, 'Transactions row MERCHANT_PAYOUT recorded', `n=${txs.rows.length}`);

  const bal3 = (await pool.query('SELECT balance FROM connected_merchant_accounts WHERE id = $1', [accountId])).rows[0];
  await expect(Number(bal3.balance) === 1000, 'Balance unchanged on execute (already reserved)', `balance=${bal3.balance}`);

  const dup = await api('POST', `/api/merchant/admin/payouts/${payoutId}/execute`, aToken);
  await expect([404, 409].includes(dup.status), 'Re-execute blocked', `status=${dup.status}`);

  const audits = await pool.query(`SELECT * FROM audit_logs WHERE action = 'MERCHANT_PAYOUT_EXECUTED'`);
  await expect(audits.rows.length >= 1, 'Payout execution audited');

  const adminList = await api('GET', '/api/merchant/admin/payouts', aToken);
  await expect(adminList.status === 200 && adminList.data.payouts.some((x) => x.id === payoutId && x.status === 'EXECUTED'), 'Admin payout queue reflects EXECUTED', `status=${adminList.status}`);

  console.log(`\n===== MERCHANT PAYOUTS: ${passed} passed, ${failed} failed =====`);
  if (failed > 0) {
    console.log('FAILURES:', failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });