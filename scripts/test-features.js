/* ============================================================
 * AFRIKOBA GLOBAL - FEATURE FLAGS + FRAUD OPS CENTRE REGRESSION
 * Flag evaluation semantics (fail-closed, rollout, audience,
 * per-user override, expiry), admin CRUD + analytics, and the
 * Fraud Operations Centre aggregation with live kill-switch.
 * ============================================================ */
const BASE = process.env.FEATURES_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const ff = require('../src/services/featureFlagService');

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
  const adminPhone = `255710${suffix}`;
  const memberPhone = `255711${suffix}`;

  // ---------- users ----------
  await section('Users setup');
  const adminReg = await register(adminPhone, 'Admin Test');
  await expect(adminReg.status < 300 && adminReg.data.token, 'Admin registered', `status=${adminReg.status}`);
  const memberReg = await register(memberPhone, 'Member Test');
  await expect(memberReg.status < 300 && memberReg.data.token, 'Member registered', `status=${memberReg.status}`);

  const adminId = adminReg.data.user.id;
  const memberId = memberReg.data.user.id;

  await pool.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminId]);
  const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: adminReg.data.refreshToken });
  await expect(refresh.status === 200 && refresh.data.token, 'Admin token refreshed with ADMIN role', `status=${refresh.status}`);
  const adminToken = refresh.data.token;
  const memberToken = memberReg.data.token;

  // ---------- service-level semantics ----------
  await section('Feature flag evaluation semantics');
  const missing = await ff.isEnabled('FLAG_DOES_NOT_EXIST', { id: memberId, role: 'MJUMBE' });
  await expect(missing === false, 'Missing flag fails closed (OFF)', JSON.stringify(missing));

  let tmp = await ff.createFlag({ flag_key: 'TEMP_FLAG_TEST', label: 'Temp Test Flag', description: 't', enabled: true, rollout_percent: 100 }, adminId);
  await expect(!!tmp.flag_key, 'createFlag returns flag');

  let on = await ff.isEnabled('TEMP_FLAG_TEST', { id: memberId, role: 'MJUMBE' });
  await expect(on === true, 'Enabled flag is ON for member');

  await ff.updateFlag('TEMP_FLAG_TEST', { enabled: false });
  let off = await ff.isEnabled('TEMP_FLAG_TEST', { id: memberId, role: 'MJUMBE' });
  await expect(off === false, 'Disabled flag is OFF');

  await ff.updateFlag('TEMP_FLAG_TEST', { enabled: true, rollout_percent: 0 });
  let rollout0 = await ff.isEnabled('TEMP_FLAG_TEST', { id: memberId, role: 'MJUMBE' });
  await expect(rollout0 === false, 'Rollout 0% excludes everyone (ROLLOUT_OFF)');

  await ff.updateFlag('TEMP_FLAG_TEST', { enabled: true, rollout_percent: 100, audience: ['ADMIN'] });
  let audienceBlock = await ff.isEnabled('TEMP_FLAG_TEST', { id: memberId, role: 'MJUMBE' });
  await expect(audienceBlock === false, 'Role audience excludes MJUMBE (ROLE_BLOCKED)');
  let audiencePass = await ff.isEnabled('TEMP_FLAG_TEST', { id: adminId, role: 'ADMIN' });
  await expect(audiencePass === true, 'Role audience allows ADMIN');

  await ff.updateFlag('TEMP_FLAG_TEST', { enabled: true, rollout_percent: 0, audience: [], override_user_ids: [memberId] });
  let overrideOn = await ff.isEnabled('TEMP_FLAG_TEST', { id: memberId, role: 'MJUMBE' });
  await expect(overrideOn === true, 'Per-user override beats rollout 0% (OVERRIDE_ON)');

  await ff.updateFlag('TEMP_FLAG_TEST', { enabled: true, audience: [], override_user_ids: [], expires_at: new Date(Date.now() - 60000).toISOString() });
  let expired = await ff.isEnabled('TEMP_FLAG_TEST', { id: memberId, role: 'MJUMBE' });
  await expect(expired === false, 'Expired flag is OFF (EXPIRED)');

  const analytics = await ff.flagAnalytics('TEMP_FLAG_TEST');
  await expect(analytics.flagKey === 'TEMP_FLAG_TEST' && analytics.total >= 6, `flagAnalytics aggregates (total=${analytics.total})`);
  const evals = await ff.listEvaluations('TEMP_FLAG_TEST', 50);
  await expect(evals.length >= 6, 'listEvaluations returns history', `n=${evals.length}`);

  await ff.deleteFlag('TEMP_FLAG_TEST');
  const gone = await ff.isEnabled('TEMP_FLAG_TEST', { id: memberId, role: 'MJUMBE' });
  await expect(gone === false, 'Deleted flag fails closed');

  // ---------- HTTP: feature flags ----------
  await section('Feature flags API');
  let neth401 = await api('GET', '/api/features');
  await expect(neth401.status === 401, 'GET /features requires auth', `status=${neth401.status}`);

  let memberList = await api('GET', '/api/features', memberToken);
  await expect(memberList.status === 200 && Array.isArray(memberList.data.flags), 'GET /features lists flags for user');

  let memberEval = await api('POST', '/api/features/evaluate', memberToken, { keys: ['FRAUD_OPS_DASHBOARD', 'ONBOARDING_V2'] });
  await expect(memberEval.status === 200 && memberEval.data.evaluations.FRAUD_OPS_DASHBOARD === true, 'POST /features/evaluate returns map');

  let memberAdmin = await api('GET', '/api/features/admin', memberToken);
  await expect(memberAdmin.status === 403, 'Non-admin blocked from /features/admin', `status=${memberAdmin.status}`);

  let adminCreate = await api('POST', '/api/features/admin', adminToken, { flag_key: 'TEMP_API_FLAG', label: 'API Flag', enabled: true });
  await expect(adminCreate.status === 201 && adminCreate.data.flag.flag_key === 'TEMP_API_FLAG', 'Admin creates flag', `status=${adminCreate.status}`);

  let adminList = await api('GET', '/api/features/admin', adminToken);
  await expect(adminList.status === 200 && adminList.data.flags.some((f) => f.flag_key === 'TEMP_API_FLAG'), 'Admin lists flags');

  let adminUpdate = await api('PUT', '/api/features/admin/TEMP_API_FLAG', adminToken, { enabled: false, rollout_percent: 25 });
  await expect(adminUpdate.status === 200 && adminUpdate.data.flag.enabled === false, 'Admin updates flag', `status=${adminUpdate.status}`);

  let adminAnalytics = await api('GET', '/api/features/admin/TEMP_API_FLAG/analytics', adminToken);
  await expect(adminAnalytics.status === 200 && adminAnalytics.data.analytics.flagKey === 'TEMP_API_FLAG', 'Admin reads flag analytics');

  let adminEvals = await api('GET', '/api/features/admin/TEMP_API_FLAG/evaluations', adminToken, null);
  await expect(adminEvals.status === 200, 'Admin reads flag evaluations');

  let adminDel = await api('DELETE', '/api/features/admin/TEMP_API_FLAG', adminToken);
  await expect(adminDel.status === 200, 'Admin deletes flag', `status=${adminDel.status}`);

  // ---------- ready fraud data ----------
  await section('Fraud Ops Centre');
  const alertIns = await pool.query(
    `INSERT INTO fraud_alerts (user_id, alert_type, severity, description)
     VALUES ($1, 'VELOCITY', 'HIGH', 'Test high-velocity alert') RETURNING id`,
    [memberId]
  );
  const alertId = alertIns.rows[0].id;
  await expect(!!alertId, 'Seeded fraud alert');

  let noAuthDash = await api('GET', '/api/fraud-ops/dashboard');
  await expect(noAuthDash.status === 401, 'Fraud-ops dashboard requires auth', `status=${noAuthDash.status}`);

  let memberDash = await api('GET', '/api/fraud-ops/dashboard', memberToken);
  await expect(memberDash.status === 403, 'Non-admin blocked from fraud-ops', `status=${memberDash.status}`);

  let dash = await api('GET', '/api/fraud-ops/dashboard', adminToken);
  await expect(dash.status === 200 && dash.data.dashboard.alerts.total >= 1, 'Admin reads fraud-ops dashboard', `status=${dash.status}`);
  await expect(dash.data.dashboard.alerts.open >= 1, 'Dashboard counts open alert');
  await expect(Array.isArray(dash.data.dashboard.priority.alerts), 'Dashboard has priority queue');

  let caseOpen = await api('POST', '/api/fraud-ops/cases', adminToken, {
    alertId, userId: memberId, caseType: 'SUSPICIOUS_ACTIVITY', riskLevel: 'HIGH', summary: 'Investigate velocity pattern',
  });
  await expect(caseOpen.status === 201 && caseOpen.data.case.id, 'Admin opens AML case', `status=${caseOpen.status}`);
  const caseId = caseOpen.data.case.id;

  let caseList = await api('GET', '/api/fraud-ops/cases?status=OPEN', adminToken);
  await expect(caseList.status === 200 && caseList.data.cases.some((c) => c.id === caseId), 'Cases list contains new case');

  let caseDetail = await api('GET', `/api/fraud-ops/cases/${caseId}`, adminToken);
  await expect(caseDetail.status === 200 && caseDetail.data.case.case.id === caseId && Array.isArray(caseDetail.data.case.notes), 'Case detail returns notes');

  let noteAdd = await api('POST', `/api/fraud-ops/cases/${caseId}/notes`, adminToken, { note: 'Reviewing transactions' });
  await expect(noteAdd.status === 201 && noteAdd.data.note.id, 'Admin adds case note', `status=${noteAdd.status}`);

  let caseUpdate = await api('PUT', `/api/fraud-ops/cases/${caseId}`, adminToken, { status: 'RESOLVED', disposition: 'CONFIRMED_FRAUD' });
  await expect(caseUpdate.status === 200 && caseUpdate.data.case.status === 'RESOLVED' && caseUpdate.data.case.disposition === 'CONFIRMED_FRAUD', 'Admin updates case', `status=${caseUpdate.status}`);

  await pool.query(
    `INSERT INTO ai_risk_assessments (user_id, risk_score, risk_level, confidence, model_version)
     VALUES ($1, 92, 'CRITICAL', 88, 'afri-risk-1.0')`,
    [memberId]
  );

  let riskProfiles = await api('GET', '/api/fraud-ops/risk-profiles', adminToken);
  await expect(riskProfiles.status === 200 && riskProfiles.data.profiles.some((p) => p.user_id === memberId && p.risk_level === 'CRITICAL'), 'Risk profiles include seeded assessment');

  let resolvedAlert = await api('POST', `/api/fraud-ops/alerts/${alertId}/resolve`, adminToken);
  await expect(resolvedAlert.status === 200 && resolvedAlert.data.alert.is_resolved === true, 'Admin resolves alert', `status=${resolvedAlert.status}`);

  let dash2 = await api('GET', '/api/fraud-ops/dashboard', adminToken);
  await expect(dash2.data.dashboard.alerts.resolved >= 1, 'Dashboard counts resolved alerts');
  await expect(dash2.data.dashboard.cases.closed >= 1, 'Dashboard counts closed cases');

  // ---------- kill-switch ----------
  await section('Kill-switch (FRAUD_OPS_DASHBOARD)');
  let kill = await api('PUT', '/api/features/admin/FRAUD_OPS_DASHBOARD', adminToken, { enabled: false });
  await expect(kill.status === 200 && kill.data.flag.enabled === false, 'Flag disabled via admin API');

  let killedDash = await api('GET', '/api/fraud-ops/dashboard', adminToken);
  await expect(killedDash.status === 403 && killedDash.data.error === 'FEATURE_DISABLED', 'Fraud-ops killed by flag (403)', `status=${killedDash.status}`);

  let revive = await api('PUT', '/api/features/admin/FRAUD_OPS_DASHBOARD', adminToken, { enabled: true });
  await expect(revive.status === 200 && revive.data.flag.enabled === true, 'Flag re-enabled');

  let revivedDash = await api('GET', '/api/fraud-ops/dashboard', adminToken);
  await expect(revivedDash.status === 200, 'Fraud-ops live again', `status=${revivedDash.status}`);

  // ---------- result ----------
  console.log(`\n===== FEATURES + FRAUD OPS: ${passed} passed, ${failed} failed =====`);
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