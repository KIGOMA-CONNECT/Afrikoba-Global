/* ============================================================
 * AFRIKOBA GLOBAL - A/B EXPERIMENTS REGRESSION
 * Deterministic assignment, audience targeting, event tracking,
 * report math (rate/uplift/z/verdict), flag gating, transitions.
 * ============================================================ */
const BASE = process.env.EXPERIMENTS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const ff = require('../src/services/featureFlagService');
const exp = require('../src/services/experimentService');

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
  const adminReg = await register(`255730${suffix}`, 'Exp Admin');
  const memberReg = await register(`255731${suffix}`, 'Exp Member');
  const outsiderReg = await register(`255732${suffix}`, 'Exp Outsider');
  await expect(adminReg.data.token && memberReg.data.token, 'Users registered');

  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [adminReg.data.user.id]);
  const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: adminReg.data.refreshToken });
  const adminToken = refresh.data.token;
  const memberToken = memberReg.data.token;
  const adminId = adminReg.data.user.id;
  const memberId = memberReg.data.user.id;
  const outsiderId = outsiderReg.data.user.id;

  // ---------- access control ----------
  await section('Access control');
  let anon = await api('GET', '/api/experiments/admin');
  await expect(anon.status === 401, 'Anonymous blocked from admin', `status=${anon.status}`);
  let memberAdmin = await api('GET', '/api/experiments/admin', memberToken);
  await expect(memberAdmin.status === 403, 'Non-admin blocked from admin', `status=${memberAdmin.status}`);

  // ---------- create & gate ----------
  await section('Create experiment + flag gating');
  const flagKey = `EXPFLAG_${suffix}`;
  await ff.createFlag({ flag_key: flagKey, label: 'Exp flag', enabled: true, rollout_percent: 100 }, adminId);
  const expKey = `EXP${suffix}`;
  const body = {
    key: expKey, flag_key: flagKey, name: 'Onboarding funnel test',
    variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }],
    audience: {}, metrics: { primary: 'signup_completed', secondary: ['depth'] },
    start_at: new Date(Date.now() - 3600000).toISOString(), end_at: new Date(Date.now() + 86400000).toISOString(),
  };
  let create = await api('POST', '/api/experiments/admin', adminToken, body);
  await expect(create.status === 201 && create.data.experiment.key === expKey, 'Admin creates experiment', `status=${create.status}`);

  let dupKey = await api('POST', '/api/experiments/admin', adminToken, body);
  await expect(dupKey.status === 409, 'Duplicate key rejected', `status=${dupKey.status}`);

  let badKey = await api('POST', '/api/experiments/admin', adminToken, { ...body, key: 'ab' });
  await expect(badKey.status === 400, 'Short key rejected', `status=${badKey.status}`);

  // not running yet
  let assignDraft = await api('POST', '/api/experiments/assign', memberToken, { experimentKey: expKey });
  await expect(assignDraft.status === 409, 'Cannot assign while DRAFT', `status=${assignDraft.status}`);

  // flag off -> cannot start
  await ff.updateFlag(flagKey, { enabled: false });
  let startOff = await api('POST', `/api/experiments/admin/${expKey}/start`, adminToken, {});
  await expect(startOff.status === 403, 'Cannot start while flag disabled', `status=${startOff.status}`);
  await ff.updateFlag(flagKey, { enabled: true });

  let start = await api('POST', `/api/experiments/admin/${expKey}/start`, adminToken, {});
  await expect(start.status === 200 && start.data.experiment.status === 'RUNNING', 'Experiment started', `status=${start.status}`);

  // variants immutable while running
  let mutate = await api('PUT', `/api/experiments/admin/${expKey}`, adminToken, { variants: [{ key: 'a', weight: 100 }] });
  await expect(mutate.status === 409, 'Variants immutable while RUNNING', `status=${mutate.status}`);

  // ---------- deterministic assignment ----------
  await section('Deterministic assignment');
  const N = 60;
  const counts = { control: 0, treatment: 0 };
  const firstByUser = {};
  for (let i = 1; i <= N; i++) {
    const uid = 900000000 + i;
    const v1 = await exp.assignVariant(uid, expKey);
    const v2 = await exp.assignVariant(uid, expKey);
    counts[v1.variant] = (counts[v1.variant] || 0) + 1;
    if (v1.variant !== v2.variant) { fail('Assignment stable across calls'); return; }
    if (!firstByUser[v1.variant]) firstByUser[v1.variant] = uid;
  }
  await expect(true, '60 users assigned deterministically (stable across calls)');
  await expect(counts.control > 15 && counts.control < 45 && counts.treatment === N - counts.control, `Distribution roughly 50/50 (control=${counts.control}, treatment=${counts.treatment})`);

  let assignApi = await api('POST', '/api/experiments/assign', memberToken, { experimentKey: expKey });
  await expect(assignApi.status === 200 && ['control', 'treatment'].includes(assignApi.data.variant), 'API assign returns variant', `status=${assignApi.status}`);
  let reassign = await api('POST', '/api/experiments/assign', memberToken, { experimentKey: expKey });
  await expect(reassign.data.variant === assignApi.data.variant && reassign.data.firstAssigned === false, 'Re-assign is sticky (no double bucket)');

  // ---------- audience targeting ----------
  await section('Audience targeting');
  let upAudience = await api('PUT', `/api/experiments/admin/${expKey}`, adminToken, { audience: { roles: ['ADMIN'] } });
  await expect(upAudience.status === 200, 'Audience set to ADMIN-only');
  let blockedAud = await api('POST', '/api/experiments/assign', memberToken, { experimentKey: expKey });
  await expect(blockedAud.status === 403, 'MJUMBE blocked by role audience', `status=${blockedAud.status}`);
  let allowAdmin = await exp.assignVariant(adminId, expKey);
  await expect(!!allowAdmin.variant, 'ADMIN allowed by role audience');
  await api('PUT', `/api/experiments/admin/${expKey}`, adminToken, { audience: { user_ids: [memberId] } });
  let audUser = await api('POST', '/api/experiments/assign', memberToken, { experimentKey: expKey });
  await expect(audUser.status === 200 && audUser.data.variant === assignApi.data.variant, 'Explicit user_id allowed (sticky variant)', `status=${audUser.status}`);
  await api('PUT', `/api/experiments/admin/${expKey}`, adminToken, { audience: {} });

  // ---------- events & report ----------
  await section('Event tracking + report math');
  let trackNotAssign = await api('POST', '/api/experiments/track', outsiderReg.data.token, { experimentKey: expKey, eventName: 'signup_completed' });
  await expect(trackNotAssign.data.recorded === false && trackNotAssign.data.reason === 'not_assigned', 'Unassigned user event not recorded', JSON.stringify(trackNotAssign.data));

  const perVariantCounts = { control: 0, treatment: 0 };
  for (let i = 1; i <= 12; i++) {
    const uid = 900000000 + i;
    const v = (await exp.assignVariant(uid, expKey)).variant;
    perVariantCounts[v]++;
    await exp.trackEvent({ userId: uid, keyOrId: expKey, eventName: 'signup_completed', value: v === 'control' ? 5 : 1 });
  }
  const totalTracked = 12;
  await expect(perVariantCounts.control > 0 && perVariantCounts.treatment > 0, `Both variants present in tracked cohort (${JSON.stringify(perVariantCounts)})`);

  let report = await api('GET', `/api/experiments/admin/${expKey}/report`, adminToken);
  await expect(report.status === 200 && report.data.report.primaryMetric === 'signup_completed', 'Report returns experiment', `status=${report.status}`);
  const rep = report.data.report;
  await expect(rep.controlKey === 'control', 'Control key detected');
  const controlV = rep.detailByVariant.control;
  const treatV = rep.detailByVariant.treatment;
  await expect(controlV.events === perVariantCounts.control && treatV.events === perVariantCounts.treatment, `Report sums events per variant (${controlV.events}+${treatV.events})`);
  await expect(controlV.rate === Number((perVariantCounts.control / controlV.assigned).toFixed(4)), 'Control rate = tracked/assigned');
  await expect(Number.isFinite(Number(treatV.uplift)) && Number.isFinite(Number(treatV.zScore)), `Uplift & z-score computed (uplift=${treatV.uplift}, z=${treatV.zScore})`);
  await expect(['WIN', 'LOSS', 'NEUTRAL'].includes(treatV.verdict), `Verdict is one of WIN/LOSS/NEUTRAL (${treatV.verdict})`);
  await expect(rep.totalEvents >= totalTracked, 'Total events counted');

  // value aggregation (deterministic: control got 5 per event, treatment 1)
  const sumAgg = await pool.query(`SELECT variant, COALESCE(SUM(value),0)::int AS s FROM experiment_events WHERE experiment_id = (SELECT id FROM experiments WHERE key = $1) GROUP BY variant`, [expKey]);
  const bySum = Object.fromEntries(sumAgg.rows.map((r) => [r.variant, r.s]));
  await expect(bySum.control === 5 * perVariantCounts.control && bySum.treatment === perVariantCounts.treatment, `Value sums exact (${JSON.stringify(bySum)})`);

  let assignments = await api('GET', `/api/experiments/admin/${expKey}/assignments`, adminToken);
  await expect(assignments.status === 200 && assignments.data.assignments.length === 62, 'Assignments listed (60 synthetic + member + admin)', `n=${assignments.data.assignments.length}`);

  let events = await api('GET', `/api/experiments/admin/${expKey}/events`, adminToken);
  await expect(events.status === 200 && events.data.events.length === totalTracked, 'Events listed');

  // ---------- transitions ----------
  await section('Transitions');
  let pause = await api('POST', `/api/experiments/admin/${expKey}/pause`, adminToken, {});
  await expect(pause.status === 200 && pause.data.experiment.status === 'PAUSED', 'Pause works');
  let assignPaused = await api('POST', '/api/experiments/assign', memberToken, { experimentKey: expKey });
  await expect(assignPaused.status === 409, 'Cannot assign while PAUSED', `status=${assignPaused.status}`);
  let trackPaused = await api('POST', '/api/experiments/track', memberToken, { experimentKey: expKey, eventName: 'x' });
  await expect(trackPaused.data.recorded === false && trackPaused.data.reason === 'not_running', 'Events not recorded while paused', JSON.stringify(trackPaused.data));

  let stop = await api('POST', `/api/experiments/admin/${expKey}/stop`, adminToken, {});
  await expect(stop.status === 200 && stop.data.experiment.status === 'STOPPED', 'Stop works');
  let resumeStopped = await api('POST', `/api/experiments/admin/${expKey}/start`, adminToken, {});
  await expect(resumeStopped.status === 409, 'Stopped experiment cannot restart', `status=${resumeStopped.status}`);

  let list = await api('GET', '/api/experiments/admin', adminToken);
  await expect(list.status === 200 && list.data.experiments.some((e) => e.key === expKey), 'Admin lists experiments', `status=${list.status} n=${list.data.experiments?.length}`);

  // cleanup
  await ff.deleteFlag(flagKey);
  await pool.query('DELETE FROM experiments WHERE key = $1', [expKey]);

  console.log(`\n===== EXPERIMENTS: ${passed} passed, ${failed} failed =====`);
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