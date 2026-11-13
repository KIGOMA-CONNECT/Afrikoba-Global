#!/usr/bin/env node
'use strict';
/* R36 route review (owner request): every route reachable under the pilot allow-list, classified and tested
 * against the REAL src/server.js (runner r36lpint.sh with R36_PILOT=1 R36_PROD=1: PILOT_MODE=true,
 * NODE_ENV=production, disposable DB).
 *
 * The inventory is computed at runtime from the Express stacks of the routers mounted under the allowed
 * segments (nested routers included), so a route added later is classified or the test fails.
 * Classes:
 *   BLOCKED       refused in pilot with 403 PILOT_* (route gate)                         -> asserted
 *   ALLOWED       pilot product / guarded admin-ops route                                -> guard asserted
 *   NEEDS_REVIEW  reachable by a single ADMIN in pilot and either acts on an excluded product's money or
 *                 changes a control (thresholds, four-eyes policy, feature flags, keys)   -> guard asserted,
 *                 reachability recorded as a FINDING (not a pass)
 * Checks (exit 1 on any failure):
 *   [A] no token -> 401/403 for every route except the declared PUBLIC list;
 *   [B] ordinary member token -> 403 on every admin-class route (admin, ops, cache, outbox, features/admin,
 *       admin/four-eyes, fraud-ops);
 *   [C] BLOCKED routes -> 403 PILOT_* for member and admin;
 *   [D] ALLOWED member routes -> not refused by a pilot gate (the pilot does not break them);
 *   [E] every route is classified (no UNCLASSIFIED).
 * Findings (recorded, do not change the exit code): [F1] admin reachability of NEEDS_REVIEW money routes on
 *   excluded products (non-existent ids; no money can move); [F2] single-admin four-eyes self-approval chain;
 *   [F3] single-admin change of HIGH_VALUE_TRANSFER_THRESHOLD (restored afterwards).
 */
const BASE = process.env.TEST_BASE;
if (!BASE || !/^phase71_financial_audit_r36_i[a-z0-9_]+$/.test(process.env.DB_NAME || '')) { console.error('REFUSING'); process.exit(2); }
const path = require('path'); const fs = require('fs');
const ROOT = process.cwd();
const pool = require(path.join(ROOT, 'src/config/db'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));
let passed = 0; let failed = 0; const findings = [];
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ''}`); } };
const finding = (id, l, d) => { findings.push({ id, l, d }); console.log(`  ! FINDING ${id}: ${l}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ''}`); };
async function call(method, p, token, body) {
  const headers = { 'content-type': 'application/json' }; if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}
const pilotRefused = (r) => r.status === 403 && r.body && /^PILOT_/.test(String(r.body.code || ''));

// ---- inventory (runtime) ----
const MOUNTS = [['auth', 'authRoutes'], ['wallet', 'walletRoutes'], ['vicoba', 'vicobaRoutes'], ['vicoba', 'mkobaRoutes'], ['admin', 'adminRoutes'],
  ['ops', 'opsRoutes.audit'], ['ops', 'opsRoutes'], ['services', 'serviceRoutes'], ['totp', 'totpRoutes'], ['countries', 'countryRoutes'], ['devices', 'deviceRoutes'],
  ['notifications', 'notificationRoutes'], ['cache', 'cacheRoutes'], ['outbox', 'outboxRoutes'], ['features', 'featureFlagRoutes'], ['admin/four-eyes', 'fourEyesRoutes'], ['fraud-ops', 'fraudOpsRoutes']];
function inventory() {
  const out = [];
  for (const [seg, spec] of MOUNTS) {
    const [file, sub] = spec.split('.'); let r = require(path.join(ROOT, 'src/routes', file)); if (sub) r = r[sub];
    const walk = (stack, prefix) => {
      for (const layer of stack) {
        if (!layer.route) {
          if (layer.handle && Array.isArray(layer.handle.stack)) walk(layer.handle.stack, prefix + layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\\\//g, '/'));
          continue;
        }
        for (const m of Object.keys(layer.route.methods)) {
          const full = (prefix + layer.route.path).replace(/\/$/, '');
          out.push({ method: m.toUpperCase(), route: `/${seg}${full}`, router: spec });
        }
      }
    };
    walk(r.stack, '');
  }
  return out;
}
// Server mount order matters: /admin/four-eyes/* is served by fourEyesRoutes, not adminRoutes.
const PUBLIC = new Set(['GET /auth/countries', 'POST /auth/send-otp', 'POST /auth/login', 'POST /auth/register', 'POST /auth/login/password', 'POST /auth/totp-login', 'POST /auth/refresh']);
const SKIP_CALL_NO_TOKEN = new Set(['POST /auth/send-otp']); // production mode would contact the SMS provider; devOtp behaviour is r36-7 [5]
const ADMIN_CLASS = (o) => /^(adminRoutes|opsRoutes|opsRoutes\.audit|cacheRoutes|outboxRoutes|fourEyesRoutes|fraudOpsRoutes)$/.test(o.router) || o.route.startsWith('/features/admin');
function classify(o) {
  const k = `${o.method} ${o.route}`;
  const pilot = require(path.join(ROOT, 'src/config/pilot'));
  const gated = pilot.ROUTE_GATES.find(([m, p]) => m.toUpperCase() === o.method && p === o.route);
  if (gated) return { cls: 'BLOCKED', why: `route gate (${gated[2]})` };
  // excluded-product money / admin actions reachable by a single admin
  if (/^POST \/admin\/(milestones\/:milestoneId\/release|projects\/:projectId\/(revenue|split|review\/start|review|audit|milestones)|projects\/(monitoring|milestones))$/.test(k) || /^PUT \/admin\/projects\/milestones\/:id$/.test(k))
    return { cls: 'NEEDS_REVIEW', why: 'crowdfunding (excluded product) admin action; service not pilot-gated', money: /release|revenue|split/.test(k) };
  if (/^POST \/admin\/treasury\/proposals(\/:id\/sign)?$/.test(k)) return { cls: 'NEEDS_REVIEW', why: 'treasury multi-sig proposal/sign; service not pilot-gated (step-up on sign)', money: true };
  if (/^(POST|PUT) \/admin\/countries(\/:id)?$/.test(k) || k === 'POST /admin/countries/quote') return { cls: 'NEEDS_REVIEW', why: 'cross-border (remittance, excluded) configuration/quote; transfer itself is BLOCKED' };
  if (k === 'PUT /admin/config/:key') return { cls: 'NEEDS_REVIEW', why: 'single admin changes control thresholds (e.g. HIGH_VALUE_TRANSFER_THRESHOLD), audited' };
  if (k === 'PUT /admin/four-eyes/policies/:code') return { cls: 'NEEDS_REVIEW', why: 'single admin changes four-eyes policy (incl. allow_self_approve), audited' };
  if (/^(POST|PUT|DELETE) \/features\/admin(\/:flagKey)?$/.test(k)) return { cls: 'NEEDS_REVIEW', why: 'single admin changes feature flags (FOUR_EYES, FRAUD_OPS_DASHBOARD...), audited' };
  if (k === 'POST /admin/api-keys') return { cls: 'NEEDS_REVIEW', why: 'single admin issues API keys' };
  if (/^POST \/admin\/(backup\/create|backup\/cleanup|maintenance\/run)$/.test(k)) return { cls: 'NEEDS_REVIEW', why: 'operational action by single admin (backup/maintenance)' };
  if (/^POST \/admin\/four-eyes\/actions\/(card-settle|card-refund|credit-loan-disburse|business-loan-disburse|lending-circle-disburse|kilimo-loan-disburse|large-refund)$/.test(k))
    return { cls: 'ALLOWED', why: 'request creation only; executor refused in pilot (guardExecutor, r36-7 [3])' };
  if (/^GET \/admin\/(users|transactions)$/.test(k)) return { cls: 'ALLOWED', why: 'admin read; returns member PII (phone, balances) to any ADMIN - privacy note' };
  if (ADMIN_CLASS(o)) return { cls: 'ALLOWED', why: 'admin/ops/compliance route behind role guard' };
  if (PUBLIC.has(k)) return { cls: 'ALLOWED', why: 'public authentication entry point' };
  if (/^(authRoutes|walletRoutes|vicobaRoutes|mkobaRoutes|totpRoutes|countryRoutes|deviceRoutes|notificationRoutes|serviceRoutes|featureFlagRoutes)$/.test(o.router))
    return { cls: 'ALLOWED', why: 'pilot product route (authenticated user)' };
  return { cls: 'UNCLASSIFIED', why: '' };
}
const fill = (r) => r.replace(/:[A-Za-z]+/g, '999999');

(async () => {
  // users
  const mk = async (label, role) => {
    const u = (await pool.query(`INSERT INTO users (full_name, phone_number, role) VALUES ($1, $2, $3) RETURNING id, role, phone_number, auth_version`,
      [`R36 RR ${label}`, `2557${String(Date.now()).slice(-6)}${label.length}${Math.floor(Math.random() * 9)}`, role])).rows[0];
    await pool.query(`INSERT INTO user_service_subscriptions (user_id, service_key, status) VALUES ($1,'VICOBA','ACTIVE') ON CONFLICT DO NOTHING`, [u.id]);
    return { ...u, token: signToken(u) };
  };
  const member = await mk('member', 'USER'); const adminA = await mk('adminA', 'ADMIN'); const adminB = await mk('adminB', 'ADMIN'); const target = await mk('target', 'USER');

  const inv = inventory().map((o) => ({ ...o, ...classify(o) }));
  console.log(`\ninventory: ${inv.length} routes`);
  const unclassified = inv.filter((o) => o.cls === 'UNCLASSIFIED');
  check(`[E] every route classified (${inv.length})`, unclassified.length === 0, unclassified.map((o) => `${o.method} ${o.route}`));

  console.log('\n[A] no token');
  for (const o of inv) {
    const k = `${o.method} ${o.route}`;
    if (SKIP_CALL_NO_TOKEN.has(k)) { console.log(`  - ${k} not called in production mode (SMS); see r36-7 [5]`); continue; }
    const r = await call(o.method, `/api/v1${fill(o.route)}`, null, {});
    o.noToken = r.status;
    if (PUBLIC.has(k)) check(`[A] ${k} public -> ${r.status} (no 5xx)`, r.status < 500, r);
    else check(`[A] ${k} -> 401/403 without token`, r.status === 401 || r.status === 403, r);
  }

  console.log('\n[B] ordinary member on admin-class routes');
  for (const o of inv.filter(ADMIN_CLASS)) {
    const r = await call(o.method, `/api/v1${fill(o.route)}`, member.token, {});
    o.member = r.status;
    check(`[B] ${o.method} ${o.route} -> 403 for member`, r.status === 403, r);
  }

  console.log('\n[C] BLOCKED routes refused in pilot');
  for (const o of inv.filter((x) => x.cls === 'BLOCKED')) {
    for (const [who, t] of [['member', member.token], ['admin', adminA.token]]) {
      const r = await call(o.method, `/api/v1${fill(o.route)}`, t, { amount: 5000 });
      check(`[C] ${o.method} ${o.route} (${who}) -> 403 PILOT_*`, pilotRefused(r), r);
    }
  }

  console.log('\n[D] ALLOWED member routes are not refused by a pilot gate');
  const fiveXX = [];
  for (const o of inv.filter((x) => x.cls === 'ALLOWED' && !ADMIN_CLASS(x) && !PUBLIC.has(`${x.method} ${x.route}`))) {
    const r = await call(o.method, `/api/v1${fill(o.route)}`, member.token, {});
    o.memberStatus = r.status;
    if (r.status >= 500) fiveXX.push(`${o.method} ${o.route} -> ${r.status}`);
    check(`[D] ${o.method} ${o.route} -> ${r.status} (not a pilot refusal)`, !pilotRefused(r), r);
  }
  if (fiveXX.length) finding('F0', `member calls with empty body/non-existent ids returned 5xx on ${fiveXX.length} route(s)`, fiveXX);

  console.log('\n[F1] NEEDS_REVIEW reachability by a single admin (non-existent ids; no money can move)');
  for (const o of inv.filter((x) => x.cls === 'NEEDS_REVIEW' && /^\/admin\/(milestones|projects|treasury|countries)/.test(x.route))) {
    const r = await call(o.method, `/api/v1${fill(o.route)}`, adminA.token, {});
    o.admin = r.status;
    finding('F1', `${o.method} ${o.route} reachable by ADMIN in pilot (status ${r.status}, not a pilot refusal: ${!pilotRefused(r)})`, r.body && (r.body.code || r.body.message));
  }

  console.log('\n[F2] four-eyes self-approval chain by ONE admin (ADMIN_PROMOTE_ROLE)');
  {
    // the FOUR_EYES flag must be on for the four-eyes routes; one admin can switch it on/off
    let flag = await call('GET', '/api/v1/features/admin/', adminA.token);
    const has = flag.body && Array.isArray(flag.body.flags) && flag.body.flags.find((f) => f.flag_key === 'FOUR_EYES');
    const fset = has
      ? await call('PUT', '/api/v1/features/admin/FOUR_EYES', adminA.token, { enabled: true, rollout_percent: 100 })
      : await call('POST', '/api/v1/features/admin/', adminA.token, { flag_key: 'FOUR_EYES', label: 'Four eyes', enabled: true, rollout_percent: 100 });
    console.log(`  (FOUR_EYES flag set by adminA: ${fset.status})`);
    // control: with allow_self_approve=false, self-approval is refused
    await call('PUT', '/api/v1/admin/four-eyes/policies/ADMIN_PROMOTE_ROLE', adminA.token, { allowSelfApprove: false, requiredApprovers: 1, enabled: true });
    const r1 = await call('POST', '/api/v1/admin/four-eyes/actions/promote-role', adminA.token, { userId: target.id, role: 'COMPLIANCE' });
    const id1 = r1.body && r1.body.request && r1.body.request.id;
    const a1 = await call('POST', `/api/v1/admin/four-eyes/requests/${id1}/approve`, adminA.token, { note: 'r36 self' });
    const role1 = (await pool.query('SELECT role FROM users WHERE id=$1', [target.id])).rows[0].role;
    check('[F2 control] allow_self_approve=false: self-approval refused, role unchanged', a1.status >= 400 && role1 === 'USER', { r1: r1.status, a1, role1 });
    await call('POST', `/api/v1/admin/four-eyes/requests/${id1}/cancel`, adminA.token, {});
    // finding: the same admin flips the policy and approves its own request
    const p = await call('PUT', '/api/v1/admin/four-eyes/policies/ADMIN_PROMOTE_ROLE', adminA.token, { allowSelfApprove: true });
    const r2 = await call('POST', '/api/v1/admin/four-eyes/actions/promote-role', adminA.token, { userId: target.id, role: 'COMPLIANCE' });
    const id2 = r2.body && r2.body.request && r2.body.request.id;
    const a2 = await call('POST', `/api/v1/admin/four-eyes/requests/${id2}/approve`, adminA.token, { note: 'r36 self' });
    const role2 = (await pool.query('SELECT role FROM users WHERE id=$1', [target.id])).rows[0].role;
    const audit = (await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action = 'FOUR_EYES_POLICY_UPDATE'`)).rows[0].n;
    finding('F2', `one ADMIN set allow_self_approve=true (status ${p.status}), requested and self-approved ADMIN_PROMOTE_ROLE (approve ${a2.status}); target role now ${role2}; policy updates audited: ${audit}`, { r2: r2.status, a2: a2.body && (a2.body.status || a2.body.code || a2.body.message) });
    check('[F2] the role change by a single admin is detectable in audit_logs (policy update audited)', audit >= 1, audit);
    // restore policy
    await call('PUT', '/api/v1/admin/four-eyes/policies/ADMIN_PROMOTE_ROLE', adminB.token, { allowSelfApprove: false });
  }

  console.log('\n[F3] single admin changes HIGH_VALUE_TRANSFER_THRESHOLD');
  {
    const before = (await pool.query(`SELECT value FROM config_settings WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'`)).rows[0];
    const r = await call('PUT', '/api/v1/admin/config/HIGH_VALUE_TRANSFER_THRESHOLD', adminA.token, { value: '999999999999' });
    const after = (await pool.query(`SELECT value FROM config_settings WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'`)).rows[0];
    finding('F3', `one ADMIN changed HIGH_VALUE_TRANSFER_THRESHOLD ${before ? before.value : '(unset, default 5000000)'} -> ${after && after.value} (status ${r.status}); no second approval`, r.body && (r.body.code || r.body.success));
    if (before) await pool.query(`UPDATE config_settings SET value=$1 WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'`, [before.value]);
    else await pool.query(`DELETE FROM config_settings WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'`);
  }

  const counts = inv.reduce((a, o) => { a[o.cls] = (a[o.cls] || 0) + 1; return a; }, {});
  console.log(`\nclassification: ${JSON.stringify(counts)}`);
  if (process.env.R36_ROUTE_OUT) fs.writeFileSync(process.env.R36_ROUTE_OUT, JSON.stringify({ counts, routes: inv, findings }, null, 1));
  console.log(`\nR36 (8) pilot route review: ${passed} passed, ${failed} failed, ${findings.length} findings recorded`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); await pool.end().catch(() => {}); process.exit(1); });
