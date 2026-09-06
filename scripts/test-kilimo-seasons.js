/* ============================================================
 * AFRIKOBA GLOBAL - KILIMO SEASONS + YIELD + ADVISORIES
 * Farm seasons, harvest close-out with yield roll-up, and
 * agronomist advisory lifecycle (issue / scope / action).
 * ============================================================ */
const BASE = process.env.KILIMO_TEST_BASE || 'http://127.0.0.1:3000';
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

function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const farmer = await register(`255721${suffix}`, 'Mkulima Kaskazini');
  const outsider = await register(`255722${suffix}`, 'Mkulima Mwingine');
  const agronomist = await register(`255723${suffix}`, 'Daktari wa mimea');
  const admin = await register(`255724${suffix}`, 'Kilimo Admin');
  await expect(farmer.data.token && outsider.data.token && agronomist.data.token && admin.data.token, 'Users registered');
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [agronomist.data.user.id, 'AGRONOMIST']);
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [admin.data.user.id, 'ADMIN']);

  // ---------- farm + season ----------
  await section('Farm profile + season');
  let r = await api('POST', '/api/kilimo/farms', farmer.data.token, { farmName: 'Shamba Kubwa', region: 'Arusha', district: 'Karatu', sizeAcres: 5, primaryCrop: 'MAIZE', expectedHarvestDate: '2026-11-30' });
  await expect(r.status === 200 && r.data.farm.id, 'Farm created', `status=${r.status}`);
  const farmId = r.data.farm.id;

  r = await api('POST', `/api/kilimo/farms/${farmId}/seasons`, farmer.data.token, { seasonName: 'Masika 2026', plantingDate: '2026-03-01', expectedHarvestDate: '2026-08-15', crop: 'MAIZE', areaAcres: 4, expectedYieldTons: 6 });
  await expect(r.status === 200 && r.data.season.status === 'ACTIVE' && Number(r.data.season.expected_yield_tons) === 6, 'Season created (ACTIVE)', `status=${r.status} msg=${r.data?.message}`);
  const seasonId = r.data.season.id;

  r = await api('POST', `/api/kilimo/farms/${farmId}/seasons`, outsider.data.token, { seasonName: 'Vuli 2026' });
  await expect(r.status === 403, 'Outsider cannot create season on another farm', `status=${r.status}`);

  r = await api('GET', `/api/kilimo/farms/${farmId}/seasons`, farmer.data.token, null);
  await expect(r.status === 200 && r.data.seasons.length === 1, 'Farm lists its season', `status=${r.status}`);

  // ---------- harvest close-out ----------
  await section('Harvest close-out + yield rollup');
  r = await api('POST', `/api/kilimo/seasons/${seasonId}/harvest`, farmer.data.token, { actualYieldTons: 4.2, saleAmount: 4200000, notes: 'Mahindi yamezalika vizuri' });
  await expect(r.status === 200 && r.data.season.status === 'COMPLETED' && Number(r.data.season.actual_yield_tons) === 4.2 && Number(r.data.season.sale_amount) === 4200000, 'Harvest recorded (COMPLETED)', `status=${r.status} msg=${r.data?.message}`);
  await expect(Number(r.data.season.farm_historical_yield_tons) === 4.2, 'Farm historical yield rolled up to 4.2t', `yield=${r.data.season?.farm_historical_yield_tons}`);

  r = await api('POST', `/api/kilimo/seasons/${seasonId}/harvest`, farmer.data.token, { actualYieldTons: 9 });
  await expect(r.status === 400, 'Re-harvest of closed season rejected', `status=${r.status}`);

  r = await api('POST', `/api/kilimo/seasons/${seasonId}/harvest`, outsider.data.token, { actualYieldTons: 9 });
  await expect(r.status === 403, 'Outsider cannot close another farm season', `status=${r.status}`);

  // ---------- advisories ----------
  await section('Agronomist advisory lifecycle');
  r = await api('POST', '/api/kilimo/advisories', farmer.data.token, { farm_id: farmId, category: 'FERTILIZER', title: 'Tumia mbolea za NPK', advice: 'Weka NPK 17:17:17 wiki 3 baada ya kupanda.' });
  await expect(r.status === 403, 'Non-agronomist blocked from posting advisory', `status=${r.status} msg=${r.data?.message}`);

  r = await api('POST', '/api/kilimo/advisories', agronomist.data.token, { farm_id: farmId, season_id: seasonId, category: 'FERTILIZER', title: 'Tumia mbolea za NPK', advice: 'Weka NPK 17:17:17 wiki 3 baada ya kupanda.', action_due_date: '2026-04-01' });
  await expect(r.status === 200 && r.data.advisory.status === 'ISSUED' && r.data.advisory.agronomist_user_id === agronomist.data.user.id, 'Agronomist issues advisory', `status=${r.status} msg=${r.data?.message}`);
  const advId = r.data.advisory.id;

  const farmOut = await api('POST', '/api/kilimo/farms', outsider.data.token, { farmName: 'Shamba Dog', region: 'Morogoro', district: 'Mvomero', sizeAcres: 1, primaryCrop: 'RICE', expectedHarvestDate: '2026-12-01' });
  const seasonOut = await api('POST', `/api/kilimo/farms/${farmOut.data.farm.id}/seasons`, outsider.data.token, { seasonName: 'Msimu A' });
  r = await api('POST', '/api/kilimo/advisories', agronomist.data.token, { farm_id: farmId, season_id: seasonOut.data.season.id, category: 'SOIL', title: 'Uchambuzi wa udongo', advice: 'Tafuta sampuli.' });
  await expect(r.status === 400, 'Advisory rejects season from a different farm', `status=${r.status}`);

  r = await api('GET', '/api/kilimo/advisories', farmer.data.token, null);
  await expect(r.status === 200 && r.data.advisories.length === 1 && r.data.advisories[0].farm_id === farmId, 'Farmer scoped to own-farm advisories', `status=${r.status} n=${r.data?.advisories?.length}`);

  r = await api('GET', '/api/kilimo/advisories', outsider.data.token, null);
  await expect(r.status === 200 && r.data.advisories.length === 0, 'Other farmer sees nothing', `status=${r.status} n=${r.data?.advisories?.length}`);

  r = await api('GET', '/api/kilimo/advisories', admin.data.token, null);
  await expect(r.status === 200 && r.data.advisories.length === 1, 'Admin sees all advisories', `status=${r.status} n=${r.data?.advisories?.length}`);

  r = await api('GET', `/api/kilimo/advisories?farmId=${farmId}`, agronomist.data.token, null);
  await expect(r.status === 200 && r.data.advisories.length === 1, 'Agronomist lists own advisories for the farm', `status=${r.status}`);

  r = await api('POST', `/api/kilimo/advisories/${advId}/action`, outsider.data.token, {});
  await expect(r.status === 403, 'Outsider cannot action another farm advisory', `status=${r.status}`);

  r = await api('POST', `/api/kilimo/advisories/${advId}/action`, farmer.data.token, {});
  await expect(r.status === 200 && r.data.advisory.status === 'ACTIONED', 'Farmer actions advisory (ACTIONED)', `status=${r.status} msg=${r.data?.message}`);

  console.log(`\n===== KILIMO SEASONS: ${passed} passed, ${failed} failed =====`);
  if (failed > 0) {
    console.log('FAILURES:', failures.join(' | '));
    process.exit(1);
  }
  await pool.end();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});