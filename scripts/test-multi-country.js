/* ============================================================
 * AFRIKOBA GLOBAL - MULTI-COUNTRY DEPLOYMENT & REGULATORY
 * Migration 089: supported_countries gains calling codes, per-
 * country daily transfer limits, withholding tax rates, KYC doc
 * types, and license status; user_daily_transfer_totals enforces
 * regulator daily caps; GOVERNMENT_WHT ledger account receives
 * withheld tax. This suite proves:
 *  - GET /api/countries lists active countries with calling codes
 *    and license snapshot (auth)
 *  - GET /api/countries/me resolves the user's country from
 *    country_code / MSISDN prefix and returns the regulatory config
 *  - cross-border executeTransfer applies source-country withholding
 *    tax to GOVERNMENT_WHT and records the daily total
 *  - exceeding the daily cap returns 402 REGULATORY_DAILY_LIMIT
 *  - admin can tune limits via PUT /api/admin/countries/:id
 *  - /api/countries/me reports todayUsage + remaining
 * ============================================================ */
const BASE = process.env.MULTI_COUNTRY_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function makeAdmin(regData) {
  if (!regData || !regData.user || !regData.user.id) return null;
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [regData.user.id]);
  return regData.user.id;
}

async function getUser(id) {
  const r = await pool.query('SELECT id, wallet_balance FROM users WHERE id = $1', [id]);
  return r.rows[0];
}
async function useDailyTotal(userId, countryCode) {
  const r = await pool.query(
    'SELECT total_amount FROM user_daily_transfer_totals WHERE user_id = $1 AND country_code = $2',
    [userId, countryCode]
  );
  return Number(r.rows[0]?.total_amount || 0);
}

async function run() {
  const runSalt = String(Date.now()).slice(-5);
  const suffix = `${runSalt}${Math.floor(Math.random() * 90) + 10}`;

  await section('Setup: register TZ (admin) + KE users, fund wallet');
  const adm = await register(`255801${suffix}`, 'Multi Country Admin');
  const ke = await register(`254792${suffix}`, 'Multi Country Kenya');
  const admId = await makeAdmin(adm);
  await expect(!!admId, 'TZ user promoted to admin');
  await expect(ke.user.country_code === 'KE', `carrier-derived country KE (got ${ke.user.country_code})`);

  const fundingRef = `XC-CR-${suffix}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({ client, userId: admId, amount: 1000000, reference: fundingRef, fromAccount: 'SUSPENSE', description: 'Multi-country test seed' });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const adminToken = adm.token;
  const keToken = ke.token;
  await expect(!!adminToken, 'admin token present');
  await expect(!!keToken, 'KE token present');

  await section('GET /api/countries (auth) - calling code + license snapshot');
  const list = await api('GET', '/api/countries', keToken);
  await expect(list.status === 200, `countries lists 200 (got ${list.status})`);
  const keRow = (list.data.countries || []).find((c) => c.code === 'KE');
  const tzRow = (list.data.countries || []).find((c) => c.code === 'TZ');
  await expect(!!keRow && keRow.callingCode === '254' && !!keRow.license, 'KE has callingCode 254 + license');
  await expect(!!tzRow && tzRow.callingCode === '255' && tzRow.license.status === 'LICENSED', 'TZ has callingCode 255 + license LICENSED');

  await section('GET /api/countries/me - regulatory config per country');
  const meKe = await api('GET', '/api/countries/me', keToken);
  await expect(meKe.status === 200 && meKe.data.code === 'KE', `KE me resolves code KE (got ${meKe.data.code})`);
  await expect(meKe.data.maxDailyTransferLimit === 10000000, `KE daily limit 10M (got ${meKe.data.maxDailyTransferLimit})`);
  await expect(meKe.data.withholdingTaxRate === 0.15, `KE withholding 15% (got ${meKe.data.withholdingTaxRate})`);
  await expect(meKe.data.kycDocTypeRequired === 'NATIONAL_ID', `KE KYC doc NATIONAL_ID (got ${meKe.data.kycDocTypeRequired})`);
  await expect(!!meKe.data.support && !!meKe.data.support.email, 'KE support contacts present');

  const meTz = await api('GET', '/api/countries/me', adminToken);
  await expect(meTz.data.code === 'TZ' && meTz.data.license.status === 'LICENSED', `TZ me: code TZ + LICENSED (got ${meTz.data.code}/${meTz.data.license?.status})`);
  await expect(meTz.data.todayUsage === 0 && meTz.data.remaining === 20000000, 'TZ me: fresh daily usage 0, remaining 20M');

  await section('Cross-border transfer TZ->KE: fee + withholding to GOVERNMENT_WHT');
  const beforeTx = await getUser(admId);
  await expect(Number(beforeTx.wallet_balance) === 1000000, `wallet seeded 1M (got ${beforeTx.wallet_balance})`);

  const xb = await api('POST', '/api/admin/countries/transfer', adminToken, {
    to_country: 'KE', amount: 200000, recipient: 'Test Beneficiary KE'
  });
  await expect(xb.status === 200 && xb.data.success === true, `transfer succeeds (got ${xb.status})`);
  await expect(xb.data.withholdingTax === 20000, `withholding 10% of 200k = 20k (got ${xb.data.withholdingTax})`);
  await expect(xb.data.sourceCountry === 'TZ', `source country TZ (got ${xb.data.sourceCountry})`);

  const afterTx = await getUser(admId);
  await expect(Number(afterTx.wallet_balance) === 780000,
    `wallet debited 220k = 198k principal + 2k fee + 20k tax (got ${afterTx.wallet_balance})`);

  const jrows = await pool.query(
    `SELECT j.direction, j.amount, l.account_code
     FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE j.reference_id = $1 AND l.account_code = 'GOVERNMENT_WHT'`,
    [`${xb.data.referenceId}:WHT`]
  );
  await expect(jrows.rows.length === 1 && jrows.rows[0].direction === 'CR' && Number(jrows.rows[0].amount) === 20000,
    `GOVERNMENT_WHT credit of 20k posted (got ${JSON.stringify(jrows.rows[0])})`);

  let tzTotal = await useDailyTotal(admId, 'TZ');
  await expect(tzTotal === 200000, `daily total recorded 200k (got ${tzTotal})`);

  await section('Daily cap enforcement: lower TZ limit, expect 402');
  const adminCountries = await api('GET', '/api/admin/countries', adminToken);
  const tzId = (adminCountries.data.countries || []).find((c) => c.code === 'TZ')?.id;
  await expect(!!tzId, `resolved TZ country id (got ${tzId})`);
  const lowered = await api('PUT', `/api/admin/countries/${tzId}`, adminToken, { max_daily_transfer_limit: 250000 });
  await expect(lowered.status === 200, 'admin lowers TZ limit via PUT');
  const meLow = await api('GET', '/api/countries/me', adminToken);
  await expect(meLow.data.todayUsage === 200000 && meLow.data.remaining === 50000,
    `usage 200k / remaining 50k (got ${meLow.data.todayUsage}/${meLow.data.remaining})`);

  const over = await api('POST', '/api/admin/countries/transfer', adminToken, {
    to_country: 'KE', amount: 100000, recipient: 'Too Much'
  });
  await expect(over.status === 402 && over.data.code === 'REGULATORY_DAILY_LIMIT',
    `over-cap transfer blocked 402 (got ${over.status} ${over.data.code})`);

  await section('Restore limit, transfer again; usage adds up');
  const restored = await api('PUT', `/api/admin/countries/${tzId}`, adminToken, { max_daily_transfer_limit: 20000000 });
  await expect(restored.status === 200, 'TZ limit restored to 20M');

  const xb2 = await api('POST', '/api/admin/countries/transfer', adminToken, {
    to_country: 'KE', amount: 50000, recipient: 'Second Beneficiary'
  });
  await expect(xb2.status === 200 && xb2.data.success === true, `second transfer succeeds (got ${xb2.status})`);
  tzTotal = await useDailyTotal(admId, 'TZ');
  await expect(tzTotal === 250000, `daily total accumulates to 250k (got ${tzTotal})`);

  const meFinal = await api('GET', '/api/countries/me', adminToken);
  await expect(meFinal.data.todayUsage === 250000, `me reflects cumulative 250k usage (got ${meFinal.data.todayUsage})`);

  await section('RBAC guard');
  const anon = await api('GET', '/api/countries/me', null);
  await expect(anon.status === 401, `unauthenticated /countries/me -> 401 (got ${anon.status})`);
  const anonList = await api('GET', '/api/countries', null);
  await expect(anonList.status === 401, `unauthenticated /countries -> 401 (got ${anonList.status})`);

  await pool.query('DELETE FROM user_daily_transfer_totals WHERE user_id = $1', [admId]);
}

run()
  .then(() => {
    console.log(`\nMULTI-COUNTRY COMPLIANCE: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });