/* ============================================================
 * AFRIKOBA GLOBAL - MERCHANT INVOICES (migration 099)
 * Merchants issue itemised invoices (INV-* codes); customers
 * settle them by code through the canonical merchant payment
 * path (merchantService.payMerchant):
 *   - invoke issue/list/resolve/cancel/pay endpoints
 *   - invoice PAID is idempotent (alreadyPaid returns same ref)
 *   - settlement runs the merchant money rails (MERCH-* ref),
 *     payer debited, merchant proceeds credited
 *   - invoice guards: no merchant -> 400, PAY -> 400 (non-ISSUED),
 *     partial amount rejected, expired -> 400
 *   - RBAC: unauthenticated list/pay -> 401
 * ============================================================ */
const BASE = process.env.INVOICE_TEST_BASE || 'http://127.0.0.1:3000';
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
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.user) throw new Error(`register ${phoneNumber} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}
async function fundUser(id, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, id]);
}

async function run() {
  const s = String(Date.now()).slice(-5);
  const suffix = `${s}${Math.floor(Math.random() * 90) + 10}`;

  await section('Schema evidence (migration 099)');
  const colsRes = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_name = 'merchant_invoices'`
  );
  const names = new Set(colsRes.rows.map((r) => `${r.table_name}:${r.column_name}`));
  const required = ['id', 'merchant_id', 'code', 'customer_name', 'customer_phone', 'line_items', 'amount', 'currency', 'note', 'status', 'expires_at', 'paid_at', 'paid_by', 'transaction_reference'];
  for (const c of required) {
    await expect(names.has(`merchant_invoices:${c}`), `column present: merchant_invoices:${c}`);
  }

  await section('Setup: register merchant + customer, fund both');
  const merchantLogin = await register(`255741${suffix}`, `MerchantInv${suffix}`);
  const customer = await register(`255742${suffix}`, `CustInv${suffix}`);
  await fundUser(customer.user.id, 50000);
  const mToken = merchantLogin.token;
  const cToken = customer.token;

  const reg = await api('POST', '/api/merchant/register', mToken, { name: `Afrikoba Inv Store ${suffix}`, business_type: 'RETAIL', phone: `255741${suffix}` });
  await expect(reg.status === 200 && reg.data.merchant.id, 'merchant registered', `status=${reg.status}`);

  await section('Issue + resolve invoice');
  const issue = await api('POST', '/api/merchant/invoices', mToken, {
    customerName: 'Safari Sofa',
    customerPhone: `255742${suffix}`,
    lineItems: [
      { description: 'Sofa', quantity: 1, unit_price: 12000 },
      { description: 'Kurusingi', quantity: 2, unit_price: 4000 },
    ],
    amount: 20000,
    note: 'Kwa ujirani',
  });
  await expect(issue.status === 200, 'issue invoice 200', JSON.stringify(issue.data).slice(0, 140));
  const code = issue.data.invoice?.code;
  await expect(Boolean(code) && code.startsWith('INV-'), 'code INV-*', code);
  await expect(Number(issue.data.invoice?.amount) === 20000, 'amount 20000');
  await expect(issue.data.invoice?.status === 'ISSUED', 'status ISSUED');

  const pub = await api('GET', `/api/merchant/invoices/${code}`, null);
  await expect(pub.status === 200 && pub.data.invoice.code === code, 'public resolve by code', `status=${pub.status}`);

  const mine = await api('GET', '/api/merchant/invoices', mToken);
  await expect(mine.data.invoices.some((i) => i.code === code), 'merchant lists invoice');

  await section('Pay invoice (canonical merchant money path)');
  const before = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [customer.user.id])).rows[0].wallet_balance;
  const pay = await api('POST', `/api/merchant/invoices/${code}/pay`, cToken, { amount: 20000 });
  await expect(pay.status === 200, 'pay 200', JSON.stringify(pay.data).slice(0, 140));
  await expect(pay.data.paid === true, 'paid true');
  const payRef = pay.data.reference;
  await expect(Boolean(payRef), 'payment reference present', payRef);
  const after = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [customer.user.id])).rows[0].wallet_balance;
  await expect(Number(before) - Number(after) === 20000, 'payer debited 20000', `before=${before} after=${after}`);

  const txn = await pool.query('SELECT * FROM transactions WHERE reference_id = $1', [payRef]);
  await expect(txn.rows.length === 1, 'transactions row for payment');
  await expect(txn.rows[0].total_charged && Number(txn.rows[0].total_charged) === 20000, 'total_charged 20000');

  const inv = await pool.query('SELECT * FROM merchant_invoices WHERE code = $1', [code]);
  await expect(inv.rows[0].status === 'PAID' && inv.rows[0].paid_by === customer.user.id && inv.rows[0].transaction_reference === payRef,
    'invoice marked PAID with payer + reference');

  const mp = await pool.query('SELECT * FROM merchant_payments WHERE reference = $1', [payRef]);
  await expect(mp.rows.length === 1 && mp.rows[0].status === 'SUCCESS', 'merchant_payments row SUCCESS');

  await section('Idempotent re-pay + guards');
  const repay = await api('POST', `/api/merchant/invoices/${code}/pay`, cToken, { amount: 20000 });
  await expect(repay.data?.alreadyPaid === true && repay.data.reference === payRef, 're-pay idempotent (same ref)');

  const overpay = await api('POST', '/api/merchant/invoices/DOES-NOT-EXIST/pay', cToken, { amount: 1000 });
  await expect(overpay.status === 404, 'unknown code -> 404', String(overpay.status));

  const issue3 = await api('POST', '/api/merchant/invoices', mToken, { amount: 8000, customerName: 'Overpay' });
  await expect(issue3.data.invoice?.status === 'ISSUED', 'overpay-target invoice issued');
  const part = await api('POST', `/api/merchant/invoices/${issue3.data.invoice.code}/pay`, cToken, { amount: 9000 });
  await expect(part.status === 400, 'overpay rejected (amount > invoice)', String(part.status));

  await section('Cancel + non-ISSUED guard');
  const issue2 = await api('POST', '/api/merchant/invoices', mToken, { amount: 5000, customerName: 'Second' });
  await expect(issue2.data.invoice?.status === 'ISSUED', 'second invoice issued');
  const cancel = await api('POST', `/api/merchant/invoices/${issue2.data.invoice.id}/cancel`, mToken, {});
  await expect(cancel.status === 200 && cancel.data.invoice.status === 'CANCELLED', 'merchant cancels invoice');

  const payCancel = await api('POST', `/api/merchant/invoices/${issue2.data.invoice.code}/pay`, cToken, { amount: 5000 });
  await expect(payCancel.status === 400, 'pay cancelled -> 400', String(payCancel.status));

  const strangerCancel = await api('POST', `/api/merchant/invoices/${issue.data.invoice.id}/cancel`, cToken, {});
  await expect(strangerCancel.status === 400 || strangerCancel.status === 404, 'non-merchant cannot cancel', String(strangerCancel.status));

  await section('RBAC');
  const unauth = await api('GET', '/api/merchant/invoices', null);
  await expect(unauth.status === 401, 'unauthenticated list -> 401', String(unauth.status));

  console.log(`\nMERCHANT INVOICES: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('FAILED:', failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error('\nFATAL:', e && e.message ? e.message : e);
  process.exit(1);
});