/* ============================================================
 * AFRIKOBA GLOBAL - HIGH-VALUE LENDING KYC GATES
 * Loans at/above threshold (default 1,000,000 TZS) require KYC
 * Level 3 across kilimo, micro, business, lending-circle and
 * VICOBA (applicant-level) application flows.
 * ============================================================ */
const BASE = process.env.LENDING_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

const HIGH = 1200000;
const LOW = 50000;

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
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
  return refresh.data.token;
}
async function kycUpgrade(user, adminToken, docTypes) {
  for (const document_type of docTypes) {
    const up = await api('POST', '/api/advanced/kyc/documents', user.data.token, {
      document_type,
      document_url: `https://cdn.example/${document_type.toLowerCase()}-${Date.now()}.jpg`,
      document_number: `DOC${Date.now()}${Math.floor(Math.random() * 999)}`,
      issued_country: 'TZ',
    });
    await api('PUT', `/api/advanced/admin/kyc/${up.data.document.id}/verify`, adminToken, { status: 'APPROVED' });
  }
  const lvl = await pool.query('SELECT kyc_level FROM users WHERE id = $1', [user.data.user.id]);
  return Number(lvl.rows[0].kyc_level);
}

function nowSuffix() { return String(Date.now()).slice(-6); }
async function subscribe(reg, serviceKey) {
  return api('POST', '/api/services/subscribe', reg.data.token, { serviceKey });
}

(async () => {
  const suffix = nowSuffix();
  const admin = await register(`255711${suffix}`, 'Gate Admin');
  const adminToken = await makeAdmin(admin);
  await expect(!!adminToken, 'Admin promoted');

  const l1 = await register(`255712${suffix}`, 'Level 1 Fresh');
  await expect(!!l1.data.token, 'Level-1 user registered');

  const leg2 = await register(`255713${suffix}`, 'Legacy Level 2 (no docs)');
  await pool.query('UPDATE users SET kyc_level = 2, updated_at = NOW() WHERE id = $1', [leg2.data.user.id]);
  await expect(!!leg2.data.token, 'Doc-less legacy level-2 user registered');

  const l2 = await register(`255714${suffix}`, 'Verified Level 2');
  const l2Level = await kycUpgrade(l2, adminToken, ['PASSPORT']);
  await expect(l2Level === 2, `Doc-backed level-2 user (level=${l2Level})`);

  const l3 = await register(`255715${suffix}`, 'Verified Level 3');
  const l3Level = await kycUpgrade(l3, adminToken, ['NATIONAL_ID', 'SELFIE']);
  await expect(l3Level === 3, `Doc-backed level-3 user (level=${l3Level})`);

  // ---------- kilimo agri loans ----------
  await section('Kilimo agri-loan gate');
  const farmLeg = await api('POST', '/api/kilimo/farms', leg2.data.token, { farmName: 'Shamba la Legacy', region: 'Mbeya', district: 'Mbozi', sizeAcres: 2, primaryCrop: 'MAIZE', expectedHarvestDate: '2026-11-30' });
  const farmL3 = await api('POST', '/api/kilimo/farms', l3.data.token, { farmName: 'Shamba la L3', region: 'Mbeya', district: 'Mbozi', sizeAcres: 3, primaryCrop: 'MAIZE', expectedHarvestDate: '2026-11-30' });
  await expect(farmLeg.status === 200 && farmL3.status === 200, 'Farm profiles created', `status=${farmLeg.status}/${farmL3.status}`);
  const farmLegId = farmLeg.data.farm.id;
  const farmL3Id = farmL3.data.farm.id;
  r = await api('POST', '/api/v1/kilimo/loans', l1.data.token, { farm_id: farmLegId, amount: HIGH, loan_type: 'HARVEST_CYCLE' });
  await expect(r.status === 403 && r.data.kycLevel === 1, 'Level-1 blocked from high-value agri loan (403)', `status=${r.status} kyc=${JSON.stringify(r.data)}`);
  r = await api('POST', '/api/v1/kilimo/loans', leg2.data.token, { farm_id: farmLegId, amount: HIGH, loan_type: 'HARVEST_CYCLE' });
  await expect(r.status === 403 && r.data.kycLevel === 2, 'Legacy level-2 blocked from high-value agri loan (403)', `status=${r.status} msg=${r.data?.message}`);
  r = await api('POST', '/api/v1/kilimo/loans', leg2.data.token, { farm_id: farmLegId, amount: LOW, loan_type: 'HARVEST_CYCLE' });
  await expect(r.status === 200 && r.data.loan.status === 'PENDING', 'Legacy level-2 low-value agri loan passes', `status=${r.status} msg=${r.data?.message}`);
  r = await api('POST', '/api/v1/kilimo/loans', l3.data.token, { farm_id: farmL3Id, amount: HIGH, loan_type: 'HARVEST_CYCLE' });
  await expect(r.status === 200 && r.data.loan.status === 'PENDING', 'Level-3 high-value agri loan allowed', `status=${r.status} msg=${r.data?.message}`);

  // ---------- micro loans ----------
  await section('Micro loan gate');
  r = await api('POST', '/api/credit/loans', leg2.data.token, { amount: HIGH, term_months: 3, interest_rate: 5 });
  await expect(r.status === 403 && r.data.kycLevel === 2, 'Level-2 blocked from high-value micro loan (403)', `status=${r.status}`);
  r = await api('POST', '/api/credit/loans', l3.data.token, { amount: HIGH, term_months: 3, interest_rate: 5 });
  await expect(r.status !== 403, 'Level-3 not blocked by KYC gate on high-value micro loan', `status=${r.status}`);
  r = await api('POST', '/api/credit/loans', leg2.data.token, { amount: LOW, term_months: 3, interest_rate: 5 });
  await expect(r.status === 200, 'Low-value micro loan passes for level-2', `status=${r.status} msg=${r.data?.message}`);

  // ---------- business loans ----------
  await section('Business loan gate');
  const bizLeg = await api('POST', '/api/business/accounts', leg2.data.token, { business_name: 'Gate Biz Legacy', business_type: 'TRADE', tin_number: `TIN-L${suffix}` });
  const bizL3 = await api('POST', '/api/business/accounts', l3.data.token, { business_name: 'Gate Biz L3', business_type: 'TRADE', tin_number: `TIN-3${suffix}` });
  await expect(bizLeg.status === 200 && bizL3.status === 200, 'Business accounts created for both users', `status=${bizLeg.status}/${bizL3.status}`);
  r = await api('POST', `/api/business/accounts/${bizLeg.data.business.id}/loans`, leg2.data.token, { amount: HIGH, interest_rate: 10, term_months: 12 });
  await expect(r.status === 403 && r.data.kycLevel === 2, 'Level-2 blocked from high-value business loan (403)', `status=${r.status}`);
  r = await api('POST', `/api/business/accounts/${bizLeg.data.business.id}/loans`, leg2.data.token, { amount: LOW, interest_rate: 10, term_months: 12 });
  await expect(r.status === 200 && r.data.loan.status === 'PENDING', 'Low-value business loan passes for level-2', `status=${r.status}`);
  r = await api('POST', `/api/business/accounts/${bizL3.data.business.id}/loans`, l3.data.token, { amount: HIGH, interest_rate: 10, term_months: 12 });
  await expect(r.status === 200 && r.data.loan.status === 'PENDING', 'Level-3 high-value business loan allowed', `status=${r.status} msg=${r.data?.message}`);

  // ---------- lending circles ----------
  await section('Lending-circle campaign gate');
  r = await api('POST', '/api/circles/campaigns', leg2.data.token, { circle_id: null, title: `High circle ${suffix}`, story: 'gate test', targetAmount: HIGH, term_months: 12 });
  await expect(r.status === 403 && r.data.kycLevel === 2, 'Level-2 blocked from high-value campaign (403)', `status=${r.status}`);
  r = await api('POST', '/api/circles/campaigns', l3.data.token, { circle_id: null, title: `High circle L3 ${suffix}`, story: 'gate test', targetAmount: HIGH, term_months: 12 });
  await expect(r.status === 200 && Number(r.data.campaign.target_amount) === HIGH, 'Level-3 high-value campaign allowed', `status=${r.status} msg=${r.data?.message}`);

  // ---------- VICOBA (applicant-level) ----------
  await section('VICOBA applicant-level gate');
  const sub = await subscribe(leg2, 'VICOBA');
  await expect(sub.status === 200, 'Chairman subscribed to VICOBA', `status=${sub.status} msg=${sub.data?.message}`);
  r = await api('POST', '/api/vicoba/groups/99999999/loans', leg2.data.token, { applicantUserId: l1.data.user.id, requestedAmount: HIGH, interestRate: 10, repaymentMonths: 3 });
  await expect(r.status === 403 && r.data.kycLevel === 1, 'Level-1 applicant blocked for high-value VICOBA loan (403)', `status=${r.status} kyc=${JSON.stringify(r.data)}`);
  r = await api('POST', '/api/vicoba/groups/99999999/loans', leg2.data.token, { applicantUserId: leg2.data.user.id, requestedAmount: HIGH, interestRate: 10, repaymentMonths: 3 });
  await expect(r.status === 403 && r.data.kycLevel === 2, 'Level-2 applicant blocked for high-value VICOBA loan (403)', `status=${r.status}`);
  r = await api('POST', '/api/vicoba/groups/99999999/loans', leg2.data.token, { applicantUserId: l3.data.user.id, requestedAmount: HIGH, interestRate: 10, repaymentMonths: 3 });
  await expect(r.status === 403 && r.data.kycLevel === undefined, 'Level-3 applicant clears gate - blocked only by chairman role (403 no kycLevel)', `status=${r.status} kyc=${JSON.stringify(r.data)}`);

  console.log(`\n===== LENDING GATES: ${passed} passed, ${failed} failed =====`);
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