/* ============================================================
 * AFRIKOBA GLOBAL - QR CODE PAYMENTS REGRESSION
 * Full QR lifecycle: create (STATIC/DYNAMIC, amount, expiry),
 * ownership-scoped list, scan (payee details from phone_number
 * join, scan_count, self-pay guard, expiry, deactivate → 404),
 * pay through the canonical transfer engine (payer debit /
 * payee credit / balanced ledger journal / qr_payments row /
 * QR meta transaction), insufficient-funds, amount guards,
 * owner-only deactivation, RBAC 401s. Covers /api/eco/qr/*
 * (v1 + legacy aliases) + the merchant-pay path /api/merchant/qr*.
 * ============================================================ */
const BASE = process.env.QR_TEST_BASE || 'http://127.0.0.1:3000';
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
    return ref;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function balance(userId) {
  const r = await pool.query('SELECT wallet_balance, locked_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}
function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const payee = await register(`255760${suffix}`, 'Qr Payee');
  const payer = await register(`255761${suffix}`, 'Qr Payer');
  const broke = await register(`255762${suffix}`, 'Qr Broke');
  const other = await register(`255763${suffix}`, 'Qr Other');
  await expect(payee.data.token && payer.data.token && broke.data.token && other.data.token, 'Users registered');
  const payeeTok = payee.data.token;
  const payerTok = payer.data.token;
  const brokeTok = broke.data.token;
  const otherTok = other.data.token;

  await section('Schema + seed evidence');
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'qr_codes' AND column_name IN ('code','amount','type','is_active','scan_count','expires_at')`);
  await expect(cols.rows.length === 6, 'qr_codes schema (code/amount/type/is_active/scan_count/expires_at)');
  const pcols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'qr_payments' AND column_name IN ('qr_code_id','payer_id','payee_id','amount','status')`);
  await expect(pcols.rows.length === 5, 'qr_payments schema (qr_code_id/payer_id/payee_id/amount/status)');

  await section('Create + ownership-scoped list');
  const anonCreate = await api('POST', '/api/eco/qr', null, {});
  await expect(anonCreate.status === 401, 'Create QR anonymous → 401', `status=${anonCreate.status}`);
  const st = await api('POST', '/api/eco/qr', payeeTok, { description: 'Duka la Mamangu' });
  await expect(st.status === 200 && st.data.code.code.startsWith('QR-') && st.data.code.type === 'STATIC' && st.data.code.amount === null, 'Create STATIC QR (no fixed amount)', JSON.stringify(st.data.code));
  const dyn = await api('POST', '/api/eco/qr', payeeTok, { amount: 250000, description: 'Bidhaa', type: 'DYNAMIC', expires_in_minutes: 60 });
  await expect(dyn.status === 200 && Number(dyn.data.code.amount) === 250000 && dyn.data.code.type === 'DYNAMIC' && !!dyn.data.code.expires_at, 'Create DYNAMIC QR (amount + expiry)');
  const listP = await api('GET', '/api/eco/qr', payeeTok);
  await expect(listP.status === 200 && listP.data.codes.length === 2, 'Owner list shows 2 codes');
  const listO = await api('GET', '/api/eco/qr', otherTok);
  await expect(listO.status === 200 && listO.data.codes.length === 0, 'Other user list empty (ownership scope)');
  const anonList = await api('GET', '/api/eco/qr');
  await expect(anonList.status === 401, 'List QR anonymous → 401', `status=${anonList.status}`);

  await section('Scan — payee details + guards');
  const scanSt = await api('POST', '/api/eco/qr/scan', payerTok, { code: st.data.code.code });
  await expect(scanSt.status === 200 && scanSt.data.details.payee.phone === payee.data.user.phone_number && scanSt.data.details.isDynamic === false && scanSt.data.details.amount === null, 'Scan STATIC → payee phone (phone_number join), no amount', JSON.stringify(scanSt.data.details));
  const scanDyn = await api('POST', '/api/eco/qr/scan', payerTok, { code: dyn.data.code.code });
  await expect(scanDyn.status === 200 && Number(scanDyn.data.details.amount) === 250000 && scanDyn.data.details.isDynamic === true, 'Scan DYNAMIC → fixed amount surfaced');
  const scanSelf = await api('POST', '/api/eco/qr/scan', payeeTok, { code: dyn.data.code.code });
  await expect(scanSelf.status === 400 && scanSelf.data.code === 'QR_SELF_PAY_INVALID', 'Scan own QR → 400 QR_SELF_PAY_INVALID');
  const scanMiss = await api('POST', '/api/eco/qr/scan', payerTok, { code: 'QR-NOTEXIST' });
  await expect(scanMiss.status === 404 && scanMiss.data.code === 'QR_CODE_NOT_FOUND', 'Scan unknown code → 404 QR_CODE_NOT_FOUND');
  const cnt = await pool.query('SELECT scan_count FROM qr_codes WHERE id = $1', [st.data.code.id]);
  await expect(Number(cnt.rows[0].scan_count) === 1, 'scan_count incremented', `count=${cnt.rows[0].scan_count}`);
  await pool.query(`INSERT INTO qr_codes (user_id, code, amount, type, expires_at) VALUES ($1, $2, $3, 'DYNAMIC', NOW() - INTERVAL '1 minute') RETURNING id`, [payee.data.user.id, 'QR-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-EXP', 100]);
  const expCode = (await pool.query(`SELECT code FROM qr_codes WHERE user_id = $1 AND code LIKE '%-EXP' ORDER BY id DESC LIMIT 1`, [payee.data.user.id])).rows[0].code;
  const scanExp = await api('POST', '/api/eco/qr/scan', payerTok, { code: expCode });
  await expect(scanExp.status === 400 && scanExp.data.code === 'QR_CODE_EXPIRED', 'Scan expired code → 400 QR_CODE_EXPIRED');

  await section('Pay — canonical transfer + ledger evidence');
  const merchantPath = await api('POST', '/api/merchant/qr', payeeTok, { amount: 50000, description: 'Merchant QR', type: 'DYNAMIC' });
  await expect(merchantPath.status === 200 && merchantPath.data.code.code.startsWith('QR-'), 'Create via /api/merchant/qr path (dashboard)');
  await expect(api('GET', '/api/merchant/qr', payeeTok).then((r) => r.status === 200 && r.data.codes.length === 3), '/api/merchant/qr list (dashboard)');
  const payerBefore = await balance(payer.data.user.id);
  const payeeBefore = await balance(payee.data.user.id);
  await fundWallet(payer.data.user.id, 500000);
  const payDyn = await api('POST', '/api/merchant/qr/pay', payerTok, { qr_code_id: dyn.data.code.id, amount: 250000 });
  await expect(payDyn.status === 200 && payDyn.data.success === true && payDyn.data.reference.startsWith('QR-') && Number(payDyn.data.amount) === 250000 && payDyn.data.payee === payee.data.user.id, 'Pay DYNAMIC QR 250k (merchant path)', JSON.stringify(payDyn.data));
  const payeeAfter = await balance(payee.data.user.id);
  await expect(payeeAfter === payeeBefore + 250000, 'Payee wallet +250000', `payee ${payeeBefore}→${payeeAfter}`);
  await expect(await balance(payer.data.user.id) === payerBefore + 500000 - 250000, 'Payer wallet net −250000');
  const qp = await pool.query('SELECT status, payer_id, payee_id, amount FROM qr_payments ORDER BY id DESC LIMIT 1');
  await expect(qp.rows.length === 1 && qp.rows[0].status === 'SUCCESS' && qp.rows[0].payer_id === payer.data.user.id && qp.rows[0].payee_id === payee.data.user.id && Number(qp.rows[0].amount) === 250000, 'qr_payments row (SUCCESS/payer/payee/amount)', JSON.stringify(qp.rows[0]));
  const qtx = await pool.query(`SELECT type, total_charged, reference_id, meta FROM transactions WHERE meta::text LIKE '%QR_PAYMENT%' ORDER BY id DESC LIMIT 1`);
  await expect(qtx.rows.length === 1 && qtx.rows[0].type === 'TRANSFER' && qtx.rows[0].reference_id.startsWith('QR-'), 'QR payment transaction recorded (TRANSFER + meta.type QR_PAYMENT)');
  const jb = await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DR'), 0) AS dr, COALESCE(SUM(amount) FILTER (WHERE direction = 'CR'), 0) AS cr FROM journal_entries WHERE reference_id = $1`, [payDyn.data.reference]);
  await expect(Number(jb.rows[0].dr) === Number(jb.rows[0].cr) && Number(jb.rows[0].dr) > 0, 'Ledger journal balanced for QR payment', JSON.stringify(jb.rows[0]));

  await section('Pay — guards');
  const brokePay = await api('POST', '/api/eco/qr/pay', brokeTok, { qr_code_id: dyn.data.code.id, amount: 250000 });
  await expect(brokePay.status === 400 && brokePay.data.code === 'WALLET_INSUFFICIENT_FUNDS', 'Insufficient funds → 400 WALLET_INSUFFICIENT_FUNDS', `status=${brokePay.status}`);
  const noAmt = await api('POST', '/api/eco/qr/pay', payerTok, { qr_code_id: st.data.code.id });
  await expect(noAmt.status === 400 && noAmt.data.code === 'QR_AMOUNT_REQUIRED', 'STATIC QR without amount → 400 QR_AMOUNT_REQUIRED', `status=${noAmt.status}}`);
  const payStatic = await api('POST', '/api/eco/qr/pay', payerTok, { qr_code_id: st.data.code.id, amount: 5000 });
  await expect(payStatic.status === 200 && Number(payStatic.data.amount) === 5000, 'Pay STATIC QR 5k with explicit amount');
  const missQr = await api('POST', '/api/eco/qr/pay', payerTok, { qr_code_id: 99999999, amount: 100 });
  await expect(missQr.status === 404 && missQr.data.code === 'QR_CODE_NOT_FOUND', 'Pay unknown QR → 404 QR_CODE_NOT_FOUND', `status=${missQr.status}`);
  const anonPay = await api('POST', '/api/eco/qr/pay', null, { qr_code_id: dyn.data.code.id, amount: 100 });
  await expect(anonPay.status === 401, 'Pay QR anonymous → 401', `status=${anonPay.status}`);

  await section('Owner-only deactivation');
  const anonDel = await api('DELETE', `/api/merchant/qr/${st.data.code.id}`);
  await expect(anonDel.status === 403 && anonDel.data.code === 'CSRF_TOKEN_MISSING', 'Deactivate anonymous → 403 CSRF_TOKEN_MISSING', `status=${anonDel.status}`);
  const otherDel = await api('DELETE', `/api/merchant/qr/${st.data.code.id}`, otherTok);
  await expect(otherDel.status === 200 && otherDel.data.deleted === false, 'Deactivate other user QR → deleted:false (no enumeration)');
  const listBeforeOwn = await api('GET', '/api/eco/qr', payeeTok);
  const ownDel = await api('DELETE', `/api/eco/qr/${st.data.code.id}`, payeeTok);
  await expect(ownDel.status === 200 && ownDel.data.deleted === true, 'Deactivate own QR → deleted:true');
  const listAfter = await api('GET', '/api/eco/qr', payeeTok);
  await expect(listAfter.data.codes.length === listBeforeOwn.data.codes.length - 1 && !listAfter.data.codes.some((x) => x.code === st.data.code.code), 'Deactivated QR no longer listed');
  const scanDel = await api('POST', '/api/eco/qr/scan', payerTok, { code: st.data.code.code });
  await expect(scanDel.status === 404 && scanDel.data.code === 'QR_CODE_NOT_FOUND', 'Scan deactivated QR → 404 QR_CODE_NOT_FOUND');

  if (failed) {
    console.log(`\nFAILED ${failed}/${passed + failed}:`);
    failures.forEach((f) => console.log('  ✗ ' + f));
  } else {
    console.log(`\nPASSED ${passed}/${passed} checks`);
  }
  process.exit(failed === 0 ? 0 : 1);
})();