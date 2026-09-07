/* ============================================================
 * AFRIKOBA GLOBAL - CHART OF ACCOUNTS FORMAL NUMBERING
 * Migration 093: mirrors the 1000/2000/3000/4000/5000 hierarchy
 * onto ledger_accounts.chart_number. This suite proves:
 *  - every live account has an account type in the formal 5-type set
 *  - every chart_number falls inside its account_type's range
 *  - the known core accounts map to their expected chart numbers
 *  - the admin Ops endpoint returns a grouped chart + totals
 *  - RBAC: non-admins are refused on /api/ops/chart-of-accounts
 * ============================================================ */
const BASE = process.env.CHART_TEST_BASE || 'http://127.0.0.1:3000';
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

const RANGES = {
  ASSET: [1000, 2000],
  LIABILITY: [2000, 3000],
  EQUITY: [3000, 4000],
  REVENUE: [4000, 5000],
  EXPENSE: [5000, 6000],
};

async function run() {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90) + 10}`;

  await section('Ledger: numbering mirror present + in range');
  const rows = (await pool.query('SELECT account_code, account_type, chart_number FROM ledger_accounts ORDER BY account_code')).rows;
  await expect(rows.length > 5, `ledger has ${rows.length} seeded accounts`);

  const validTypes = Object.keys(RANGES);
  let badType = 0, badRange = 0, numCount = 0;
  for (const r of rows) {
    if (!validTypes.includes(r.account_type)) badType++;
    if (r.chart_number != null) {
      numCount++;
      const [lo, hi] = RANGES[r.account_type] || [0, 0];
      if (!(Number(r.chart_number) >= lo && Number(r.chart_number) < hi)) badRange++;
    }
  }
  await expect(badType === 0, `all ${rows.length} accounts have a formal account_type`);
  await expect(numCount > 0, `${numCount}/${rows.length} accounts carry a chart_number`);
  await expect(badRange === 0, `every numbered account sits in its type range (violations=${badRange})`);

  await section('Known core accounts map to expected chart numbers');
  const expected = {
    CUSTOMER_WALLET: 2010, MNO_CLEARING: 1010, PLATFORM_FEES: 4010,
    COMMISSION: 4020, SUSPENSE: 2610, REFERRAL_REWARD: 5110,
    PARTNER_BALANCE: 2240, GOVERNMENT_WHT: 2710, TREASURY: 1310,
  };
  for (const [code, num] of Object.entries(expected)) {
    const row = rows.find((r) => r.account_code === code);
    await expect(row && Number(row.chart_number) === num, `${code} -> ${num} (got ${row ? row.chart_number : 'MISSING'})`);
  }

  await section('Admin Ops endpoint returns grouped chart + totals');
  const adm = await register(`255801${suffix}`, 'COA Admin');
  await expect(!!adm, 'admin registered');
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [adm.user.id]);
  const adminToken = adm.token;

  const res = await api('GET', '/api/ops/chart-of-accounts', adminToken);
  await expect(res.status === 200 && res.data.success === true, `chart endpoint 200 (got ${res.status})`);
  const chart = res.data.chart || {};
  const types = (chart.groups || []).map((g) => g.account_type);
  await expect(types.includes('ASSET') && types.includes('LIABILITY') && types.includes('REVENUE')
    && types.includes('EXPENSE'), `chart grouped into asset/liability/revenue/expense`);
  const allAccounts = (chart.groups || []).reduce((s, g) => s.concat(g.accounts), []);
  await expect(allAccounts.length === rows.length, `endpoint lists all ${rows.length} accounts (got ${allAccounts.length})`);
  const everyNumberedInRange = allAccounts.every((a) => {
    if (a.chart_number == null) return true;
    const [lo, hi] = RANGES[a.account_type] || [0, 0];
    return Number(a.chart_number) >= lo && Number(a.chart_number) < hi;
  });
  await expect(everyNumberedInRange, `endpoint numbering in range`);

  const dashboard = await api('GET', '/api/ops/dashboard', adminToken);
  await expect(dashboard.status === 200 && dashboard.data.chartOfAccounts
    && dashboard.data.chartOfAccounts.totalAccounts === rows.length
    && dashboard.data.chartOfAccounts.unnumberedAccounts === rows.length - numCount,
    `ops dashboard surfaces chart coverage`);

  await section('RBAC');
  const outsider = await register(`255802${suffix}`, 'COA Outsider');
  const denied = await api('GET', '/api/ops/chart-of-accounts', outsider.token);
  await expect(denied.status === 403, `non-admin refused on chart endpoint (got ${denied.status})`);
  const anon = await api('GET', '/api/ops/chart-of-accounts', null);
  await expect(anon.status === 401, `unauthenticated -> 401 (got ${anon.status})`);
}

run()
  .then(() => {
    console.log(`\nCHART OF ACCOUNTS: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
