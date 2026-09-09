/* ============================================================
 * AFRIKOBA GLOBAL - MULTI-CURRENCY / FX REGRESSION
 * Rate resolution (identity / direct / inverse / triangulated via
 * TZS), public convert math, admin rate management (RBAC, invalid
 * inputs), personal display currency, personal multi-currency
 * holdings + ledgered TZS<->foreign and foreign->foreign convert
 * (CURRENCY_CONVERT txn carrying fx_rate + fx_base_currency),
 * insufficient-funds / same-currency / invalid-currency guards.
 * ============================================================ */
const BASE = process.env.CURRENCY_TEST_BASE || 'http://127.0.0.1:3000';
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
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 4; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
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
function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const member = await register(`255750${suffix}`, 'Fx Member');
  const stranger = await register(`255751${suffix}`, 'Fx Stranger');
  const adm = await register(`255752${suffix}`, 'Fx Admin');
  await expect(member.data.token && stranger.data.token && adm.data.token, 'Users registered');
  const memTok = member.data.token;
  const strTok = stranger.data.token;
  const admin = await makeAdmin(adm);
  await expect(!!admin, 'Admin promoted');

  await section('Schema + seed evidence');
  const currencies = await api('GET', '/api/currency/currencies');
  await expect(currencies.status === 200 && Array.isArray(currencies.data.currencies), 'GET /currency/currencies public (no auth)');
  await expect(currencies.data.currencies.some((c) => c.code === 'TZS') && currencies.data.currencies.some((c) => c.code === 'USD'), 'TZS + USD active currencies present');
  const er = await pool.query('SELECT from_currency, to_currency, rate FROM exchange_rates LIMIT 1');
  await expect(er.rows.length > 0, 'exchange_rates seeded (schema + rows)');
  const ub = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = \'user_balances\' AND column_name IN (\'user_id\', \'currency_code\', \'balance\')');
  await expect(ub.rows.length === 3, 'user_balances schema (user_id/currency_code/balance)');

  await section('Rate resolution — identity / inverse / triangulated');
  const ident = await api('GET', '/api/currency/rates/TZS/TZS');
  await expect(ident.status === 200 && ident.data.rate === 1 && ident.data.source === 'IDENTITY', 'Identity TZS→TZS = 1');
  const usdTzs = await api('GET', '/api/currency/rates/USD/TZS');
  await expect(usdTzs.status === 200 && usdTzs.data.source === 'DIRECT' && usdTzs.data.rate > 1000, `USD→TZS direct (rate=${usdTzs.data?.rate})`);
  try { await pool.query("DELETE FROM exchange_rates WHERE from_currency='TZS' AND to_currency='USD'"); } catch (e) {}
  const tzsUsd = await api('GET', '/api/currency/rates/TZS/USD');
  await expect(tzsUsd.status === 200 && tzsUsd.data.source === 'INVERSE' && Math.abs(tzsUsd.data.rate - 1 / usdTzs.data.rate) < 1e-6, `TZS→USD inverse (1/${usdTzs.data?.rate})`, JSON.stringify(tzsUsd.data));
  try { await pool.query("DELETE FROM exchange_rates WHERE from_currency='EUR' AND to_currency='GBP'"); } catch (e) {}
  const tri = await api('GET', '/api/currency/rates/EUR/GBP');
  await expect(tri.status === 200 && tri.data.source === 'TRIANGULATED' && tri.data.rate > 0.8 && tri.data.rate < 0.95, `EUR→GBP triangulated via TZS (rate=${tri.data?.rate})`);
  const missing = await api('GET', '/api/currency/rates/ZWL/ALL');
  await expect(missing.status === 404 && missing.data.code === 'FX_RATE_NOT_FOUND', 'Unsupported pair → 404 FX_RATE_NOT_FOUND');

  await section('Public convert math');
  const qMissing = await api('GET', '/api/currency/convert');
  await expect(qMissing.status === 400 && qMissing.data.code === 'VALIDATION_ERROR', 'Public convert missing params → 400');
  const convUsd = await api('GET', `/api/currency/convert?amount=100&from=USD&to=TZS`);
  await expect(convUsd.status === 200 && Math.abs(convUsd.data.convertedAmount - 100 * usdTzs.data.rate) < 0.5, `Public convert 100 USD→TZS math (got ${convUsd.data?.convertedAmount})`);
  const convNone = await api('GET', `/api/currency/convert?amount=1&from=ZWL&to=ALL`);
  await expect(convNone.status === 404 && convNone.data.code === 'FX_RATE_NOT_FOUND', 'Public convert unsupported pair → 404');

  await section('Admin rate management (RBAC + guards)');
  const nonAdminPut = await api('PUT', '/api/currency/rates', memTok, { from: 'EUR', to: 'GBP', rate: 0.85 });
  await expect(nonAdminPut.status === 403, 'Non-admin PUT /currency/rates → 403', `status=${nonAdminPut.status}`);
  const putRate = await api('PUT', '/api/currency/rates', admin, { from: 'EUR', to: 'GBP', rate: 0.85 });
  await expect(putRate.status === 200 && putRate.data.success === true, 'Admin PUT EUR→GBP = 0.85');
  const dirFx = await api('GET', '/api/currency/rates/EUR/GBP');
  await expect(dirFx.status === 200 && dirFx.data.source === 'DIRECT' && Math.abs(dirFx.data.rate - 0.85) < 0.001, 'After admin PUT → direct pair');
  const putBadRate = await api('PUT', '/api/currency/rates', admin, { from: 'EUR', to: 'GBP', rate: -1 });
  await expect(putBadRate.status === 400 && putBadRate.data.code === 'WALLET_INVALID_AMOUNT', 'Invalid rate (-1) → 400 WALLET_INVALID_AMOUNT');
  const putBadCur = await api('PUT', '/api/currency/rates', admin, { from: 'EUR', to: 'XXX', rate: 1 });
  await expect(putBadCur.status === 400 && putBadCur.data.code === 'CURRENCY_NOT_SUPPORTED', 'Unsupported currency → 400 CURRENCY_NOT_SUPPORTED');

  await section('Personal display currency');
  const anonMy = await api('GET', '/api/currency/my-currency');
  await expect(anonMy.status === 401, 'my-currency anonymous → 401', `status=${anonMy.status}`);
  const defCur = await api('GET', '/api/currency/my-currency', strTok);
  await expect(defCur.status === 200 && defCur.data.currency === 'TZS', 'Default display currency TZS');
  const setEur = await api('PUT', '/api/currency/my-currency', strTok, { currency: 'EUR' });
  await expect(setEur.status === 200 && setEur.data.success === true, 'Set display currency EUR');
  const getEur = await api('GET', '/api/currency/my-currency', strTok);
  await expect(getEur.data.currency === 'EUR', 'my-currency returns EUR');
  const setBad = await api('PUT', '/api/currency/my-currency', strTok, { currency: 'YYY' });
  await expect(setBad.status === 400 && setBad.data.code === 'CURRENCY_NOT_SUPPORTED', 'Unsupported display currency → 400');

  await section('Personal holdings + ledgered convert');
  const anonHold = await api('GET', '/api/currency/my-holdings');
  await expect(anonHold.status === 401, 'my-holdings anonymous → 401', `status=${anonHold.status}`);
  const hold0 = await api('GET', '/api/currency/my-holdings', memTok);
  await expect(hold0.status === 200 && Array.isArray(hold0.data.currencies) && hold0.data.currencies.length === 0, 'Initial holdings empty (TZS only)', JSON.stringify(hold0.data));
  const funded = 1000000;
  await fundWallet(member.data.user.id, funded);
  const convBody = { from: 'TZS', to: 'EUR', amount: 400000 };
  const conv = await api('POST', '/api/currency/convert', memTok, convBody);
  await expect(conv.status === 200 && conv.data.success === true && conv.data.converted > 0 && conv.data.rate > 0, `Convert TZS→EUR 400k (got ${conv.data?.converted})`, JSON.stringify(conv.data));
  const hold1 = await api('GET', '/api/currency/my-holdings', memTok);
  const eurRow = hold1.data.currencies.find((c) => c.currency === 'EUR');
  await expect(!!eurRow && Number(eurRow.balance) > 0, 'my-holdings shows EUR after convert');
  await expect(eurRow && Math.abs(Number(eurRow.balance) - conv.data.converted) < 0.01, 'EUR balance matches converted amount', JSON.stringify(eurRow));
  await expect(eurRow && eurRow.rateToTzs > 0 && eurRow.tzsValue > 0, 'EUR annotated with rateToTzs + tzsValue');
  await expect(hold1.data.tzsTotal >= funded - 400000 && hold1.data.tzsTotal <= funded, 'Portfolio tzsTotal sane after convert', `total=${hold1.data.tzsTotal}`);
  const txn = await pool.query(
    `SELECT type, currency_code, fx_rate, fx_base_currency, total_charged FROM transactions WHERE type = 'CURRENCY_CONVERT' ORDER BY id DESC LIMIT 1`
  );
  await expect(txn.rows.length === 1, 'CURRENCY_CONVERT transaction recorded');
  await expect(txn.rows.length === 1 && txn.rows[0].currency_code === 'TZS' && txn.rows[0].fx_base_currency === 'TZS' && Math.abs(parseFloat(txn.rows[0].fx_rate) - conv.data.rate) < 0.000001 && Number(txn.rows[0].total_charged) === 400000, 'txn carries fx_rate + fx_base_currency (TZS) + amount', JSON.stringify(txn.rows[0]));

  await section('Convert guards + round trip');
  const noAuth = await api('POST', '/api/currency/convert', null, convBody);
  await expect(noAuth.status === 401, 'Convert anonymous → 401', `status=${noAuth.status}`);
  const sameCur = await api('POST', '/api/currency/convert', memTok, { from: 'TZS', to: 'TZS', amount: 100 });
  await expect(sameCur.status === 400 && sameCur.data.code === 'WALLET_INVALID_AMOUNT', 'Same-currency convert → 400');
  const badAmt = await api('POST', '/api/currency/convert', memTok, { from: 'TZS', to: 'EUR', amount: -100 });
  await expect(badAmt.status === 400 && badAmt.data.code === 'WALLET_INVALID_AMOUNT', 'Negative amount → 400 WALLET_INVALID_AMOUNT');
  const badCur = await api('POST', '/api/currency/convert', memTok, { from: 'TZS', to: 'ZZZ', amount: 1000 });
  await expect(badCur.status === 400 && badCur.data.code === 'CURRENCY_NOT_SUPPORTED', 'Unsupported target currency → 400');
  const overdraw = await api('POST', '/api/currency/convert', memTok, { from: 'EUR', to: 'TZS', amount: 999999 });
  await expect(overdraw.status === 400 && overdraw.data.code === 'CURRENCY_BALANCE_MISSING', 'Insufficient EUR balance → 400 CURRENCY_BALANCE_MISSING');
  const back = await api('POST', '/api/currency/convert', memTok, { from: 'EUR', to: 'TZS', amount: Number(eurRow.balance) });
  await expect(back.status === 200 && back.data.success === true, 'EUR→TZS round trip');
  const hold2 = await api('GET', '/api/currency/my-holdings', memTok);
  await expect(!hold2.data.currencies.some((c) => c.currency === 'EUR'), 'EUR holding removed after full convert-back');
  const lowFunds = await api('POST', '/api/currency/convert', memTok, { from: 'TZS', to: 'EUR', amount: 99999999 });
  await expect(lowFunds.status === 400 && lowFunds.data.code === 'WALLET_INSUFFICIENT_FUNDS', 'TZS insufficient funds → 400 WALLET_INSUFFICIENT_FUNDS');

  if (failed) {
    console.log(`\nFAILED ${failed}/${passed + failed}:`);
    failures.forEach((f) => console.log('  ✗ ' + f));
  } else {
    console.log(`\nPASSED ${passed}/${passed} checks`);
  }
  process.exit(failed === 0 ? 0 : 1);
})();