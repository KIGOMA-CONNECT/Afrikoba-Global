/* ============================================================
 * AFRIKOBA GLOBAL - KYC LIFECYCLE REGRESSION
 * Identity profile, document upload, admin review queue,
 * verify/reject, kyc_level auto-upgrade, access control.
 * ============================================================ */
const BASE = process.env.KYC_TEST_BASE || 'http://127.0.0.1:3000';
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
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
  let token = refresh.data.token;
  // Verify the promoted token actually works; on a transient 401, re-login via OTP
  // to mint a fresh pair rather than aborting the whole script on a stale cookie.
  let probe = token ? await api('GET', '/api/advanced/admin/kyc/pending', token) : null;
  for (let attempt = 0; probe && probe.status === 401 && attempt < 3; attempt++) {
    await sleep(50);
    const otp = await sendOtp(reg.data.user.phone_number);
    const login = await api('POST', '/api/auth/login', null, { phoneNumber: reg.data.user.phone_number, otp });
    token = login.data.token;
    probe = token ? await api('GET', '/api/advanced/admin/kyc/pending', token) : null;
  }
  await expect(!probe || probe.status === 200, 'Reviewer promoted to ADMIN', `probe=${probe ? probe.status : 'no-token'}`);
  return token;
}

function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const user = await register(`255730${suffix}`, 'KYC User Alpha');
  const user2 = await register(`255731${suffix}`, 'KYC User Beta');
  const admin = await register(`255732${suffix}`, 'KYC Admin');
  await expect(user.data.token && user2.data.token && admin.data.token, 'Users registered');
  const token = user.data.token;
  const token2 = user2.data.token;
  const adminToken = await makeAdmin(admin);
  await expect(!!adminToken, 'Reviewer promoted to ADMIN');

  // ---------- access control ----------
  await section('Access control');
  let anon = await api('GET', '/api/advanced/admin/kyc/pending');
  await expect(anon.status === 401, 'Anonymous blocked', `status=${anon.status}`);
  let nonAdmin = await api('GET', '/api/advanced/admin/kyc/pending', token);
  await expect(nonAdmin.status === 403, 'Non-admin blocked from review queue', `status=${nonAdmin.status}`);
  let adminQueue = await api('GET', '/api/advanced/admin/kyc/pending', adminToken);
  await expect(adminQueue.status === 200 && Array.isArray(adminQueue.data.documents), 'Admin views pending queue', `status=${adminQueue.status}`);

  // ---------- biographic profile ----------
  await section('Identity profile submission');
  let badProfile = await api('POST', '/api/advanced/kyc/profile', token, {});
  await expect(badProfile.status === 400, 'Empty profile rejected', `status=${badProfile.status}`);
  let profile = await api('POST', '/api/advanced/kyc/profile', token, { nida_number: `NIDA${suffix}`, residential_address: 'Dar es Salaam, Kinondoni', id_document_url: 'https://cdn.example/tz-id.jpg' });
  await expect(profile.status === 200 && profile.data.profile.nida_number === `NIDA${suffix}`, 'Profile saved with NIDA', `status=${profile.status}`);
  let profileDup = await api('POST', '/api/advanced/kyc/profile', token2, { nida_number: `NIDA${suffix}` });
  await expect(profileDup.status === 409, 'Duplicate NIDA rejected', `status=${profileDup.status}`);

  // ---------- document upload ----------
  await section('Document upload');
  let badType = await api('POST', '/api/advanced/kyc/documents', token, { document_type: 'GUN_LICENSE', document_url: 'https://cdn.example/x.jpg' });
  await expect(badType.status === 400 && /batili/.test(badType.data?.message || ''), 'Invalid doc type rejected', `status=${badType.status}`);
  let upload = await api('POST', '/api/advanced/kyc/documents', token, { document_type: 'NATIONAL_ID', document_url: 'https://cdn.example/nida-f.jpg', document_number: `NID${suffix}`, issued_country: 'TZ' });
  await expect(upload.status === 200 && upload.data.document.status === 'PENDING' && upload.data.document.document_number === `NID${suffix}`, 'National ID uploaded (PENDING)', `status=${upload.status}`);
  const docId = upload.data.document.id;

  let status = await api('GET', '/api/advanced/kyc/status', token);
  await expect(status.status === 200 && status.data.kyc_level === 1 && status.data.documents.length === 1, 'Status shows level 1 + 1 doc', `status=${status.status}`);

  // ---------- review queue + verify ----------
  await section('Admin review queue');
  let pendingDoc = null;
  let lastQueue = null;
  for (let attempt = 0; attempt < 5 && !pendingDoc; attempt++) {
    adminQueue = await api('GET', '/api/advanced/admin/kyc/pending', adminToken);
    lastQueue = adminQueue;
    if (Array.isArray(adminQueue.data?.documents)) {
      pendingDoc = adminQueue.data.documents.find((d) => d.id === docId) || null;
    }
    if (!pendingDoc) await sleep(50);
  }
  await expect(!!pendingDoc, 'Pending doc appears in queue', `status=${lastQueue ? lastQueue.status : 'no-call'}`);
  await expect(pendingDoc && pendingDoc.full_name === 'KYC User Alpha' && pendingDoc.phone_number === `255730${suffix}`, 'Queue exposes claimant name + phone', `name=${pendingDoc ? pendingDoc.full_name : 'n/a'}`);

  let verify = await api('PUT', `/api/advanced/admin/kyc/${docId}/verify`, adminToken, { status: 'APPROVED' });
  await expect(verify.status === 200 && verify.data.document.status === 'APPROVED', 'Doc approved by admin', `status=${verify.status}`);
  const level = await pool.query('SELECT kyc_level FROM users WHERE id = $1', [user.data.user.id]);
  await expect(level.rows[0].kyc_level === 2, 'National ID bumps kyc_level to 2', `level=${level.rows[0].kyc_level}`);

  // ---------- reject path ----------
  await section('Reject + level 3 upgrade');
  let upload2 = await api('POST', '/api/advanced/kyc/documents', token2, { document_type: 'PASSPORT', document_url: 'https://cdn.example/pass.jpg', document_number: `PB${suffix}` });
  await expect(upload2.status === 200, 'Second user uploads passport', `status=${upload2.status}`);
  let reject = await api('PUT', `/api/advanced/admin/kyc/${upload2.data.document.id}/verify`, adminToken, { status: 'REJECTED', rejection_reason: 'Hati haijasomika' });
  await expect(reject.status === 200 && reject.data.document.status === 'REJECTED' && reject.data.document.rejection_reason === 'Hati haijasomika', 'Doc rejected with reason', `status=${reject.status}`);
  const level2 = await pool.query('SELECT kyc_level FROM users WHERE id = $1', [user2.data.user.id]);
  await expect(level2.rows[0].kyc_level === 1, 'Rejected doc does not upgrade level', `level=${level2.rows[0].kyc_level}`);

  let selfie = await api('POST', '/api/advanced/kyc/documents', token, { document_type: 'SELFIE', document_url: 'https://cdn.example/selfie.jpg' });
  await expect(selfie.status === 200, 'Selfie uploaded', `status=${selfie.status}`);
  await api('PUT', `/api/advanced/admin/kyc/${selfie.data.document.id}/verify`, adminToken, { status: 'APPROVED' });
  const level3 = await pool.query('SELECT kyc_level FROM users WHERE id = $1', [user.data.user.id]);
  await expect(level3.rows[0].kyc_level === 3, 'ID + SELFIE upgrades to level 3', `level=${level3.rows[0].kyc_level}`);

  let stats = await api('GET', '/api/advanced/admin/kyc/stats', adminToken);
  await expect(stats.status === 200 && stats.data.stats.approved >= 2 && stats.data.stats.rejected >= 1 && stats.data.stats.pending === 0, 'Stats reflect lifecycle', `stats=${JSON.stringify(stats.data.stats)}`);

  let myDocs = await api('GET', '/api/advanced/kyc/documents', token);
  await expect(myDocs.status === 200 && myDocs.data.documents.length === 2, 'User lists own docs', `status=${myDocs.status}`);

  // ---------- expiry + level refresh + sweep ----------
  await section('Expiry, level refresh, sweep + legacy compat');
  const user3 = await register(`255733${suffix}`, 'KYC User Gamma');
  const token3 = user3.data.token;
  await expect(!!token3, 'Third user registered');
  let upload3 = await api('POST', '/api/advanced/kyc/documents', token3, { document_type: 'PASSPORT', document_url: 'https://cdn.example/pass3.jpg', document_number: `PB3${suffix}` });
  await expect(upload3.status === 200, 'Third user uploads passport', `status=${upload3.status}`);
  const doc3Id = upload3.data.document.id;
  await api('PUT', `/api/advanced/admin/kyc/${doc3Id}/verify`, adminToken, { status: 'APPROVED' });
  const lvlBefore = await pool.query('SELECT kyc_level FROM users WHERE id = $1', [user3.data.user.id]);
  await expect(lvlBefore.rows[0].kyc_level === 2, 'Approved doc upgrades to level 2', `level=${lvlBefore.rows[0].kyc_level}`);

await pool.query(`UPDATE kyc_documents SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [doc3Id]);
  let sweep = await api('POST', '/api/advanced/admin/kyc/sweep', adminToken, {});
  await expect(sweep.status === 200 && sweep.data.expired >= 1 && sweep.data.downgraded >= 1, 'Sweep flags expired docs + downgrades levels', `sweep=${JSON.stringify(sweep.data)}`);
  const doc3 = await pool.query('SELECT status FROM kyc_documents WHERE id = $1', [doc3Id]);
  await expect(doc3.rows[0].status === 'EXPIRED', 'Expired document marked EXPIRED', `status=${doc3.rows[0].status}`);
  const lvlSwept = await pool.query('SELECT kyc_level FROM users WHERE id = $1', [user3.data.user.id]);
  await expect(lvlSwept.rows[0].kyc_level === 1, 'Sweep downgrades user to level 1', `level=${lvlSwept.rows[0].kyc_level}`);

  const user4 = await register(`255734${suffix}`, 'KYC User Delta');
  await pool.query(`UPDATE kyc_documents SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [doc3Id]);
  let gatedKilimo = await api('POST', '/api/v1/kilimo/loans', token3, { farm_id: 0, amount: 1000, loan_type: 'HARVEST_CYCLE' });
  await expect(gatedKilimo.status === 403 && gatedKilimo.data.kycLevel === 1, 'Expired doc gates kilimo loans (403)', `status=${gatedKilimo.status}`);
  await pool.query('UPDATE users SET kyc_level = 2 WHERE id = $1', [user4.data.user.id]);
  let gatedLegacy = await api('POST', '/api/v1/kilimo/loans', user4.data.token, { farm_id: 0, amount: 1000, loan_type: 'HARVEST_CYCLE' });
  await expect(gatedLegacy.status !== 403, 'Doc-less legacy level-2 user still passes gate', `status=${gatedLegacy.status}`);

  console.log(`\n===== KYC: ${passed} passed, ${failed} failed =====`);
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