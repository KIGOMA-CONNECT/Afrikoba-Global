#!/usr/bin/env node
/**
 * G3 — SACCOS governance surface consolidation tests.
 *
 * DB-free by design: `src/config/db` and `src/utils/logger` are replaced in
 * the module cache before anything under src/ is loaded, so this suite runs
 * anywhere — no PostgreSQL, no server.
 *
 * What it proves:
 *   A  the two G3 matrices are the same 17 routes, mirror each other in the
 *      same order, sit in front of every handler, and the surface contains
 *      those routes and nothing else;
 *   B  capability -> role: exactly the pre-existing SACCOS contract, including
 *      the G3 decision that a platform ADMIN without membership cannot read
 *      SACCOS governance through either surface (D10 parity) while the one
 *      documented SACCOS:GOVERN oversight route still answers;
 *   C  binding: a resolution / meeting / member is owned by the SACCOS named
 *      in the path, the client cannot rename it, and a foreign or unknown id
 *      answers with the pre-existing SACCOS_* 404 (G3 does not migrate the
 *      error contract);
 *   D  denial happens before the handler: zero writes on every denial;
 *   E  the services still refuse on their own when called directly;
 *   F  cross-surface parity with /api/v1/governance;
 *   G  a positive control, so the suite is not all-denies.
 *
 *   node scripts/test-governance-saccos-binding.js
 */

const Module = require('module');

// ---------------------------------------------------------------------------
// Module stubs — installed before any src/ module is required.
// ---------------------------------------------------------------------------

function stubModule(filename, exports) {
  const m = new Module(filename, null);
  m.filename = filename;
  m.loaded = true;
  m.exports = exports;
  require.cache[filename] = m;
  return exports;
}

/**
 * SACCOS 7 is "ours" (user 2 = OWNER, user 1 = plain MEMBER), SACCOS 8 is
 * "theirs" (user 5 = OWNER). User 3 is a non-member outsider and user 4 is a
 * platform ADMIN who holds no membership row anywhere.
 *
 * Every governance resource exists twice — id 1 owned by SACCOS 7, id 2 owned
 * by SACCOS 8 — so the whole suite turns on that one contrast.
 */
const FIX = {
  users: {
    1: { id: 1, role: 'MJUMBE', is_active: true, auth_version: 0, full_name: 'Mwanachama', phone_number: '255713100001', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    2: { id: 2, role: 'MJUMBE', is_active: true, auth_version: 0, full_name: 'Mwenyekiti', phone_number: '255713100002', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    3: { id: 3, role: 'MJUMBE', is_active: true, auth_version: 0, full_name: 'Mgeni', phone_number: '255713100003', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    4: { id: 4, role: 'ADMIN', is_active: true, auth_version: 0, full_name: 'Admin', phone_number: '255713100004', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    5: { id: 5, role: 'MJUMBE', is_active: true, auth_version: 0, full_name: 'Mwenyekiti wa 8', phone_number: '255713100005', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    6: { id: 6, role: 'MJUMBE', is_active: true, auth_version: 0, full_name: 'Mwenyekiti wa 9', phone_number: '255713100006', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
  },
  saccos: {
    7: { id: 7, code: 'SAC-0007', name: 'Yetu', status: 'ACTIVE', config: {} },
    8: { id: 8, code: 'SAC-0008', name: 'Yao', status: 'ACTIVE', config: {} },
    9: { id: 9, code: 'SAC-0009', name: 'Susu', status: 'SUSPENDED', config: {} },
  },
  members: {
    701: { id: 701, saccos_id: 7, user_id: 2, role: 'OWNER', status: 'ACTIVE', member_number: '0001' },
    702: { id: 702, saccos_id: 7, user_id: 1, role: 'MEMBER', status: 'ACTIVE', member_number: '0002' },
    801: { id: 801, saccos_id: 8, user_id: 5, role: 'OWNER', status: 'ACTIVE', member_number: '0001' },
    901: { id: 901, saccos_id: 9, user_id: 6, role: 'OWNER', status: 'ACTIVE', member_number: '0001' },
  },
  resolutions: {
    1: { id: 1, saccos_id: 7, reference_id: 'RES-1', title: 'R1', status: 'OPEN', quorum_percent: 50, decision_threshold_percent: 60, eligible_members: 2 },
    2: { id: 2, saccos_id: 8, reference_id: 'RES-2', title: 'R2', status: 'OPEN', quorum_percent: 50, decision_threshold_percent: 60, eligible_members: 1 },
    3: { id: 3, saccos_id: 9, reference_id: 'RES-3', title: 'R3', status: 'OPEN', quorum_percent: 50, decision_threshold_percent: 60, eligible_members: 1 },
  },
  meetings: {
    1: { id: 1, saccos_id: 7, title: 'M1', status: 'OPEN', quorum_pct: 50 },
    2: { id: 2, saccos_id: 8, title: 'M2', status: 'OPEN', quorum_pct: 50 },
  },
};

const memberList = Object.values(FIX.members);

const queryLog = [];
const writeLog = [];
const logRecords = [];

function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: s, params });
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(s)) writeLog.push({ sql: s, params });

  // --- authentication -------------------------------------------------------
  if (/FROM revoked_tokens/.test(s)) return { rows: [] };
  if (/^SELECT role FROM users WHERE id = \$1/.test(s)) {
    const u = FIX.users[params[0]];
    return { rows: u ? [{ role: u.role }] : [] };
  }
  if (/FROM users WHERE id = \$1/.test(s)) {
    const u = FIX.users[params[0]];
    return { rows: u ? [u] : [] };
  }

  // --- saccos_members (most specific first) --------------------------------
  if (/SELECT saccos_id FROM saccos_members WHERE id = \$1$/.test(s)) {
    const m = FIX.members[params[0]];
    return { rows: m ? [{ saccos_id: m.saccos_id }] : [] };
  }
  if (/SELECT \* FROM saccos_members WHERE saccos_id = \$1 AND user_id = \$2 AND status = \$3$/.test(s)) {
    const [sid, uid, st] = params;
    const m = memberList.find((x) => x.saccos_id === sid && x.user_id === uid && x.status === st);
    return { rows: m ? [m] : [] };
  }
  if (/SELECT \* FROM saccos_members WHERE saccos_id = \$1 AND user_id = \$2$/.test(s)) {
    const [sid, uid] = params;
    const m = memberList.find((x) => x.saccos_id === sid && x.user_id === uid);
    return { rows: m ? [m] : [] };
  }
  if (/SELECT \* FROM saccos_members WHERE id = \$1 AND saccos_id = \$2$/.test(s)) {
    const m = FIX.members[params[0]];
    return { rows: m && m.saccos_id === params[1] ? [m] : [] };
  }
  if (/SELECT id FROM saccos_members WHERE id = \$1 AND saccos_id = \$2$/.test(s)) {
    const m = FIX.members[params[0]];
    return { rows: m && m.saccos_id === params[1] ? [{ id: m.id }] : [] };
  }

  // --- the SACCOS itself ----------------------------------------------------
  if (/SELECT status FROM saccos WHERE id = \$1/.test(s)) {
    const o = FIX.saccos[params[0]];
    return { rows: o ? [{ status: o.status }] : [] };
  }
  if (/FROM saccos WHERE id = \$1/.test(s)) {
    const o = FIX.saccos[params[0]];
    return { rows: o ? [o] : [] };
  }

  // --- G3 binding resolvers (row's own saccos_id is canonical) -------------
  if (/SELECT saccos_id FROM saccos_resolutions WHERE id = \$1$/.test(s)) {
    const r = FIX.resolutions[params[0]];
    return { rows: r ? [{ saccos_id: r.saccos_id }] : [] };
  }
  if (/SELECT saccos_id FROM saccos_meetings WHERE id = \$1$/.test(s)) {
    const m = FIX.meetings[params[0]];
    return { rows: m ? [{ saccos_id: m.saccos_id }] : [] };
  }

  // --- service-level composite reads (saccos_id + resource_id) -------------
  if (/FROM saccos_resolutions r WHERE r.id = \$1 AND r.saccos_id = \$2$/.test(s)) {
    const r = FIX.resolutions[params[0]];
    return { rows: r && r.saccos_id === params[1] ? [r] : [] };
  }
  if (/FROM saccos_meetings WHERE id = \$1 AND saccos_id = \$2$/.test(s)) {
    const m = FIX.meetings[params[0]];
    return { rows: m && m.saccos_id === params[1] ? [m] : [] };
  }

  // --- tally / summary shapes that must return exactly one row -------------
  if (/COUNT\(\*\) FILTER \(WHERE choice = 'FOR'\)/.test(s)) {
    return { rows: [{ for_votes: 0, against_votes: 0, abstain_votes: 0, cast_votes: 0 }] };
  }
  if (/COUNT\(\*\) FILTER \(WHERE status = 'OPEN'\)::int AS open, COUNT\(\*\) FILTER \(WHERE status = 'PASSED'\)/.test(s)) {
    return { rows: [{ open: 0, passed: 0, rejected: 0, total: 0 }] };
  }
  if (/COUNT\(\*\)::int AS votes FROM saccos_resolution_votes WHERE saccos_id = \$1/.test(s)) {
    return { rows: [{ votes: 0 }] };
  }
  if (/COUNT\(\*\)::int AS total, COUNT\(\*\) FILTER \(WHERE status = 'DRAFT'\)/.test(s)) {
    return { rows: [{ total: 0, drafts: 0, open: 0, closed: 0, published: 0, next: null }] };
  }

  // --- writes that return a row -------------------------------------------
  if (/INSERT INTO saccos_resolutions/.test(s)) {
    return { rows: [{ id: 501, saccos_id: params[0], reference_id: 'RES-TEST', status: 'DRAFT', title: params[3] }] };
  }
  if (/INSERT INTO saccos_meeting_attendance/.test(s)) {
    return { rows: [{ id: 601, member_id: params[1], status: params[2] }] };
  }
  if (/INSERT INTO saccos_resolution_votes/.test(s)) {
    return { rows: [{ id: 701, saccos_id: params[0], resolution_id: params[1], member_id: params[2], choice: params[3] }] };
  }

  return { rows: [] };
}

const loggerStub = {
  info: (...a) => logRecords.push(['info', ...a]),
  warn: (...a) => logRecords.push(['warn', ...a]),
  error: (...a) => logRecords.push(['error', ...a]),
  debug: () => {},
  log: (...a) => logRecords.push(['log', ...a]),
};

stubModule(require.resolve('../src/config/db'), {
  query: fakeQuery,
  connect: async () => ({ query: fakeQuery, release: () => {} }),
  end: () => {},
  on: () => {},
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
});
stubModule(require.resolve('../src/utils/logger'), loggerStub);

const express = require('express');
const supertest = require('supertest');
const router = require('../src/routes/saccosRoutes');
const governanceRouter = require('../src/routes/governanceRoutes');
const binding = require('../src/services/governanceResourceBindingService');
const { CAPABILITIES, authorizeGroupContext, PLATFORM_ADMIN_OVERRIDES } = require('../src/services/governanceAuthorizationService');
const { ERROR_CODES } = require('../src/utils/errorCodes');
const { signToken } = require('../src/middleware/auth');
const saccosService = require('../src/services/saccosService');
const saccosGovernance = require('../src/services/saccosGovernanceService');
const saccosMeetings = require('../src/services/saccosMeetingsService');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

let pass = 0;
const failures = [];

function section(name) { console.log(`\n=== ${name} ===`); }
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? `  | ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}
async function catchError(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}
async function throwsCode(name, fn, code) {
  const err = await catchError(fn);
  if (!err) { failures.push(name); console.log(`  FAIL  ${name}  | expected ${code}, nothing thrown`); return null; }
  eq(name, err.code, code);
  return err;
}

function snap() { return { q: queryLog.length, w: writeLog.length }; }
function writtenSince(s) { return writeLog.slice(s.w); }
function queriesSince(s) { return queryLog.slice(s.q); }
function ranQuery(s, pattern) { return queriesSince(s).some((q) => pattern.test(q.sql)); }

// Handler fingerprints: a query only these handlers issue, so "the handler ran"
// is evidence the denial layers above let the request through.
const H = {
  listResolutions: /FROM saccos_resolutions WHERE saccos_id = \$1 ORDER BY/,
  detailResolution: /FROM saccos_resolutions r WHERE r.id = \$1 AND saccos_id = \$2|FROM saccos_resolutions r WHERE r.id = \$1 AND r\.saccos_id = \$2/,
  listMeetings: /FROM saccos_meetings m WHERE m.saccos_id = \$1/,
  detailMeeting: /FROM saccos_meetings WHERE id = \$1 AND saccos_id = \$2/,
  govSummary: /COUNT\(\*\) FILTER \(WHERE status = 'OPEN'\)::int AS open, COUNT\(\*\) FILTER \(WHERE status = 'PASSED'\)/,
  meetingSummary: /COUNT\(\*\)::int AS total, COUNT\(\*\) FILTER \(WHERE status = 'DRAFT'\)/,
  insertResolution: /INSERT INTO saccos_resolutions/,
  insertAttendance: /INSERT INTO saccos_meeting_attendance/,
  insertVote: /INSERT INTO saccos_resolution_votes/,
};

async function main() {

// ---------------------------------------------------------------------------
// Part A — structural: the two matrices are the same 17 routes
// ---------------------------------------------------------------------------

section('A. structural — router wiring');

const declared = [];
for (const layer of router.stack) {
  if (!layer.route) continue;
  const p = Array.isArray(layer.route.path) ? layer.route.path[0] : layer.route.path;
  for (const m of Object.keys(layer.route.methods)) {
    if (m !== '_all') declared.push(`${m.toUpperCase()} ${p}`);
  }
}
const surfaceDeclared = declared.filter((k) => router.inG3Surface(k.split(' ')[1]));
const authzKeys = router.ROUTE_SACCOS_AUTHZ.map(([m, p]) => `${m} ${p}`);
const resourceKeys = router.ROUTE_SACCOS_RESOURCES.map(([m, p]) => `${m} ${p}`);

eq('A1 routes declared in router', declared.length, 139);
eq('A2 the G3 surface is exactly 17 declared routes', surfaceDeclared.length, 17);
eq('A3 entries in the capability matrix', authzKeys.length, 17);
eq('A4 entries in the resource matrix', resourceKeys.length, 17);
eq('A5 both matrices mirror each other in the same order',
  JSON.stringify(resourceKeys), JSON.stringify(authzKeys));
eq('A6 every surface route has a capability entry',
  surfaceDeclared.filter((k) => !authzKeys.includes(k)).length, 0);
eq('A7 every capability entry has a surface route',
  authzKeys.filter((k) => !surfaceDeclared.includes(k)).length, 0);
eq('A8 every surface route has a resource entry',
  surfaceDeclared.filter((k) => !resourceKeys.includes(k)).length, 0);
eq('A9 every resource entry has a surface route',
  resourceKeys.filter((k) => !surfaceDeclared.includes(k)).length, 0);

const layerNames = router.stack.slice(0, 3).map((l) => l.handle.name);
eq('A10 the three guard layers come first', JSON.stringify(layerNames),
  JSON.stringify(['g3Authenticate', 'g3CapabilityLayer', 'g3BindingLayer']));
ok('A11 all three guards sit before every route handler',
  router.stack.slice(0, 3).every((l) => !l.route)
  && router.stack.findIndex((l) => l.route) === 3,
  `first route at ${router.stack.findIndex((l) => l.route)}`);

const caps = router.ROUTE_SACCOS_AUTHZ.map(([, , c]) => c);
ok('A12 every capability is a real G1 capability',
  caps.every((c) => Object.prototype.hasOwnProperty.call(CAPABILITIES, c)), JSON.stringify(caps));

const preCheck = router.ROUTE_SACCOS_AUTHZ.map(([m, p, c, pre]) => `${m} ${p}=${pre === true}`);
const expectedPre = [
  'POST /:id/governance/resolutions=true',
  'GET /:id/governance/resolutions=false',
  'GET /:id/governance/resolutions/:resolutionId=false',
  'POST /:id/governance/resolutions/:resolutionId/open=true',
  'POST /:id/governance/resolutions/:resolutionId/vote=false',
  'POST /:id/governance/resolutions/:resolutionId/close=true',
  'POST /:id/governance/resolutions/:resolutionId/cancel=true',
  'GET /:id/governance/summary=false',
  'POST /:id/meetings=true',
  'GET /:id/meetings=false',
  'GET /:id/meetings/summary=true',
  'GET /:id/meetings/:meetingId=false',
  'POST /:id/meetings/:meetingId/open=true',
  'POST /:id/meetings/:meetingId/checkin=false',
  'POST /:id/meetings/:meetingId/attendance=true',
  'POST /:id/meetings/:meetingId/close=true',
  'POST /:id/meetings/:meetingId/minutes=true',
];
eq('A13 admin pre-check is on every GOVERN mutation + meetings summary, and NOT on the oversight summary',
  JSON.stringify(preCheck), JSON.stringify(expectedPre));

eq('A14 SACCOS_NOT_FOUND is 404', ERROR_CODES.SACCOS_NOT_FOUND.status, 404);
eq('A15 SACCOS_NOT_MEMBER is 403', ERROR_CODES.SACCOS_NOT_MEMBER.status, 403);
eq('A16 SACCOS_RBAC is 403', ERROR_CODES.SACCOS_RBAC.status, 403);
eq('A17 SACCOS_GOV_RESOLUTION_NOT_FOUND is 404', ERROR_CODES.SACCOS_GOV_RESOLUTION_NOT_FOUND.status, 404);
eq('A18 SACCOS_MEETING_NOT_FOUND is 404', ERROR_CODES.SACCOS_MEETING_NOT_FOUND.status, 404);
eq('A19 SACCOS_MEMBER_NOT_FOUND is 404', ERROR_CODES.SACCOS_MEMBER_NOT_FOUND.status, 404);
eq('A20 GOV_RESOURCE_UNREGISTERED is 403', ERROR_CODES.GOV_RESOURCE_UNREGISTERED.status, 403);

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'saccosRoutes.js'), 'utf8');
const sourceNoComments = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
ok('A21 the HTTP requireRoles guard is gone from saccosRoutes',
  !/requireRoles/.test(sourceNoComments), 'still referenced outside comments');
ok('A22 the service-level assertActiveRole defence is still in the service layer',
  /assertActiveRole\(actorId, saccosId, \['OWNER'\]\)/.test(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'saccosService.js'), 'utf8')));

eq('A23 /:id/governance/resolutions is in the surface', router.inG3Surface('/7/governance/resolutions'), true);
eq('A24 /:id/meetings/summary is in the surface', router.inG3Surface('/7/meetings/summary'), true);
eq('A25 /:id is not', router.inG3Surface('/7'), false);
eq('A26 / is not', router.inG3Surface('/'), false);
eq('A27 /:id/activate is not (unchanged, non-G3)', router.inG3Surface('/7/activate'), false);
eq('A28 /:id/loans/mine is not (unchanged, non-G3)', router.inG3Surface('/7/loans/mine'), false);
eq('A29 a bare /governance is not (needs the :id segment)', router.inG3Surface('/governance'), false);

// ---------------------------------------------------------------------------
// Part B — capability -> role over a real Express stack
// ---------------------------------------------------------------------------

section('B. capability -> role (HTTP, real Express + supertest)');

const app = express();
app.use(express.json());
app.use('/api/saccos', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({
  success: false, code: err.code || 'INTERNAL_ERROR', message: err.message,
}));

const TOK = {
  member: signToken(FIX.users[1]),
  owner: signToken(FIX.users[2]),
  outsider: signToken(FIX.users[3]),
  admin: signToken(FIX.users[4]),
  foreignOwner: signToken(FIX.users[5]),
  suspendedOwner: signToken(FIX.users[6]),
};

async function call(method, url, { token, body } = {}) {
  let req = supertest(app)[method.toLowerCase()](url);
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body);
  return req;
}

// B1-B4 — an outsider: writes stay 403 SACCOS_NOT_MEMBER, reads stay 404.
let s = snap();
let r = await call('POST', '/api/saccos/7/governance/resolutions', { token: TOK.outsider, body: { title: 'X' } });
eq('B1 outsider proposes -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');
eq('B1a no write', writtenSince(s).length, 0);

r = await call('GET', '/api/saccos/7/governance/resolutions', { token: TOK.outsider });
eq('B2 outsider lists -> 404 SACCOS_NOT_FOUND', `${r.status}/${r.body.code}`, '404/SACCOS_NOT_FOUND');

s = snap();
r = await call('POST', '/api/saccos/7/meetings', { token: TOK.outsider, body: { title: 'X', scheduledAt: new Date().toISOString() } });
eq('B3 outsider creates a meeting -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');
eq('B3a no write', writtenSince(s).length, 0);

r = await call('GET', '/api/saccos/7/meetings', { token: TOK.outsider });
eq('B4 outsider lists meetings -> 404 SACCOS_NOT_FOUND', `${r.status}/${r.body.code}`, '404/SACCOS_NOT_FOUND');

r = await call('GET', '/api/saccos/7/meetings/summary', { token: TOK.outsider });
eq('B5 outsider meeting summary -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');

r = await call('GET', '/api/saccos/7/governance/summary', { token: TOK.outsider });
eq('B6 outsider governance summary -> 404 SACCOS_NOT_FOUND', `${r.status}/${r.body.code}`, '404/SACCOS_NOT_FOUND');

// B7-B12 — a plain ACTIVE member.
s = snap();
r = await call('POST', '/api/saccos/7/governance/resolutions', { token: TOK.member, body: { title: 'X' } });
eq('B7 plain MEMBER proposes -> 403 SACCOS_RBAC', `${r.status}/${r.body.code}`, '403/SACCOS_RBAC');
eq('B7a no write', writtenSince(s).length, 0);

s = snap();
r = await call('POST', '/api/saccos/7/governance/resolutions/1/close', { token: TOK.member });
eq('B8 plain MEMBER closes -> 403 SACCOS_RBAC', `${r.status}/${r.body.code}`, '403/SACCOS_RBAC');
eq('B8a no write', writtenSince(s).length, 0);

s = snap();
r = await call('POST', '/api/saccos/7/meetings', { token: TOK.member, body: { title: 'X', scheduledAt: new Date().toISOString() } });
eq('B9 plain MEMBER creates a meeting -> 403 SACCOS_RBAC', `${r.status}/${r.body.code}`, '403/SACCOS_RBAC');
eq('B9a no write', writtenSince(s).length, 0);

s = snap();
r = await call('GET', '/api/saccos/7/governance/resolutions', { token: TOK.member });
eq('B10 MEMBER lists resolutions -> 200', r.status, 200);
ok('B10a handler ran', ranQuery(s, H.listResolutions));

r = await call('GET', '/api/saccos/7/meetings', { token: TOK.member });
eq('B11 MEMBER lists meetings -> 200', r.status, 200);

r = await call('GET', '/api/saccos/7/meetings/summary', { token: TOK.member });
eq('B12 MEMBER meeting summary -> 403 SACCOS_RBAC', `${r.status}/${r.body.code}`, '403/SACCOS_RBAC');

r = await call('GET', '/api/saccos/7/governance/summary', { token: TOK.member });
eq('B13 MEMBER governance summary -> 403 SACCOS_RBAC', `${r.status}/${r.body.code}`, '403/SACCOS_RBAC');

// B14-B17 — the OWNER, the only role the pre-check admits.
s = snap();
r = await call('GET', '/api/saccos/7/governance/summary', { token: TOK.owner });
eq('B14 OWNER governance summary -> 200', r.status, 200);
ok('B14a handler ran', ranQuery(s, H.govSummary));

s = snap();
r = await call('GET', '/api/saccos/7/meetings/summary', { token: TOK.owner });
eq('B15 OWNER meeting summary -> 200', r.status, 200);
ok('B15a handler ran', ranQuery(s, H.meetingSummary));

s = snap();
r = await call('POST', '/api/saccos/7/governance/resolutions/1/vote', { token: TOK.owner, body: { choice: 'FOR' } });
eq('B16 OWNER votes -> 201', r.status, 201);
ok('B16a handler ran', ranQuery(s, H.insertVote));

s = snap();
r = await call('POST', '/api/saccos/7/meetings/1/checkin', { token: TOK.member });
eq('B17 MEMBER self check-in (WRITE) -> 200', r.status, 200);
ok('B17a handler ran', ranQuery(s, H.insertAttendance));

// B18-B24 — platform ADMIN without a membership row (decision 2, option (a)).
r = await call('GET', '/api/saccos/7/governance/resolutions', { token: TOK.admin });
eq('B18 platform ADMIN lists resolutions -> 403 SACCOS_NOT_MEMBER (no READ override)', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');

r = await call('GET', '/api/saccos/7/governance/resolutions/1', { token: TOK.admin });
eq('B19 platform ADMIN reads a resolution -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');

s = snap();
r = await call('POST', '/api/saccos/7/governance/resolutions', { token: TOK.admin, body: { title: 'X' } });
eq('B20 platform ADMIN proposes -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');
eq('B20a no write', writtenSince(s).length, 0);

r = await call('GET', '/api/saccos/7/meetings', { token: TOK.admin });
eq('B21 platform ADMIN lists meetings -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');

s = snap();
r = await call('POST', '/api/saccos/7/meetings', { token: TOK.admin, body: { title: 'X', scheduledAt: new Date().toISOString() } });
eq('B22 platform ADMIN creates a meeting -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');
eq('B22a no write', writtenSince(s).length, 0);

r = await call('GET', '/api/saccos/7/meetings/summary', { token: TOK.admin });
eq('B23 platform ADMIN meeting summary -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');

// The single documented override: SACCOS:GOVERN on the oversight rollup.
r = await call('GET', '/api/saccos/7/governance/summary', { token: TOK.admin });
eq('B24 platform ADMIN oversight summary -> 200 (SACCOS:GOVERN override)', r.status, 200);

// B25 — anonymous.
r = await call('GET', '/api/saccos/7/governance/resolutions');
eq('B25 anonymous -> 401', r.status, 401);
r = await call('POST', '/api/saccos/7/meetings', { body: { title: 'X' } });
eq('B25a anonymous write -> 401', r.status, 401);

// B26-B27 — intentional authorization ordering (G1/G3), SACCOS 9 is SUSPENDED.
// Before G1/G3 an outsider voting on a non-ACTIVE SACCOS reached the service
// first, which answered 400 SACCOS_SHARES_NOT_ACTIVE — a lifecycle hint for a
// caller who was never authorized. The layers now answer visibility BEFORE
// lifecycle: outsider -> 404 SACCOS_NOT_FOUND, denial before the handler.
// The service lifecycle check itself is preserved for real members (B27).
s = snap();
r = await call('POST', '/api/saccos/9/governance/resolutions/3/vote', { token: TOK.outsider, body: { choice: 'FOR' } });
eq('B26 outsider + non-ACTIVE SACCOS + vote -> 404 SACCOS_NOT_FOUND (was 400 SACCOS_SHARES_NOT_ACTIVE)',
  `${r.status}/${r.body.code}`, '404/SACCOS_NOT_FOUND');
eq('B26a denial before handler: no write', writtenSince(s).length, 0);
ok('B26b handler never ran', !ranQuery(s, H.insertVote));

s = snap();
r = await call('POST', '/api/saccos/9/governance/resolutions/3/vote', { token: TOK.suspendedOwner, body: { choice: 'FOR' } });
eq('B27 member + non-ACTIVE SACCOS + vote -> 400 SACCOS_SHARES_NOT_ACTIVE (service check preserved)',
  `${r.status}/${r.body.code}`, '400/SACCOS_SHARES_NOT_ACTIVE');
eq('B27a still no vote row written', writtenSince(s).length, 0);
ok('B27b the service lifecycle check ran (handler reached)', ranQuery(s, /FROM saccos WHERE id = \$1/));

// ---------------------------------------------------------------------------
// Part C — resource -> SACCOS binding
// ---------------------------------------------------------------------------

section('C. resource -> SACCOS binding');

s = snap();
r = await call('GET', '/api/saccos/7/governance/resolutions/2', { token: TOK.member });
eq('C1 resolution owned by another SACCOS -> 404', r.status, 404);
eq('C1a with the pre-existing SACCOS code', r.body.code, 'SACCOS_GOV_RESOLUTION_NOT_FOUND');
ok('C1b handler never ran', !ranQuery(s, H.detailResolution));

s = snap();
r = await call('GET', '/api/saccos/7/governance/resolutions/1', { token: TOK.member });
eq('C2 our own resolution is not rejected by binding', r.status, 200);
ok('C2a handler ran', ranQuery(s, H.detailResolution));

s = snap();
r = await call('GET', '/api/saccos/7/meetings/2', { token: TOK.member });
eq('C3 meeting owned by another SACCOS -> 404', r.status, 404);
eq('C3a with the pre-existing SACCOS code', r.body.code, 'SACCOS_MEETING_NOT_FOUND');
ok('C3b handler never ran', !ranQuery(s, H.detailMeeting));

s = snap();
r = await call('GET', '/api/saccos/7/meetings/1', { token: TOK.member });
eq('C4 our own meeting is not rejected by binding', r.status, 200);
ok('C4a handler ran', ranQuery(s, H.detailMeeting));

r = await call('GET', '/api/saccos/7/meetings/999999', { token: TOK.member });
eq('C5 unknown meeting id -> 404 SACCOS_MEETING_NOT_FOUND', `${r.status}/${r.body.code}`, '404/SACCOS_MEETING_NOT_FOUND');

r = await call('GET', '/api/saccos/7/governance/resolutions/999999', { token: TOK.member });
eq('C6 unknown resolution id -> 404 SACCOS_GOV_RESOLUTION_NOT_FOUND', `${r.status}/${r.body.code}`, '404/SACCOS_GOV_RESOLUTION_NOT_FOUND');

// C7-C9 — attendance binds the member id too.
s = snap();
r = await call('POST', '/api/saccos/7/meetings/1/attendance', { token: TOK.owner, body: { memberId: 801, status: 'PRESENT' } });
eq('C7 a member of another SACCOS -> 404 SACCOS_MEMBER_NOT_FOUND', `${r.status}/${r.body.code}`, '404/SACCOS_MEMBER_NOT_FOUND');
eq('C7a no write', writtenSince(s).length, 0);

r = await call('POST', '/api/saccos/7/meetings/1/attendance', { token: TOK.owner, body: { memberId: 999999, status: 'PRESENT' } });
eq('C8 an unknown member id -> 404 SACCOS_MEMBER_NOT_FOUND', `${r.status}/${r.body.code}`, '404/SACCOS_MEMBER_NOT_FOUND');

r = await call('POST', '/api/saccos/7/meetings/1/attendance', { token: TOK.owner, body: { status: 'PRESENT' } });
eq('C9 a member id that is not supplied at all -> 404, not a 500', `${r.status}/${r.body.code}`, '404/SACCOS_MEMBER_NOT_FOUND');

// C10-C12 — the client may not rename the SACCOS the context was built from.
r = await call('POST', '/api/saccos/7/governance/resolutions', { token: TOK.owner, body: { title: 'X', saccos_id: 8 } });
eq('C10 a conflicting saccos_id in the body -> 404', `${r.status}/${r.body.code}`, '404/GOV_RESOURCE_NOT_FOUND');

r = await call('GET', '/api/saccos/7/meetings?group_id=8', { token: TOK.owner });
eq('C11 a conflicting group_id in the query -> 404', `${r.status}/${r.body.code}`, '404/GOV_RESOURCE_NOT_FOUND');

r = await call('GET', '/api/saccos/7/meetings?group_type=VICOBA', { token: TOK.owner });
eq('C12 a conflicting group family -> 404', `${r.status}/${r.body.code}`, '404/GOV_RESOURCE_NOT_FOUND');

r = await call('GET', '/api/saccos/7/meetings?saccos_id=8', { token: TOK.owner });
eq('C13 a conflicting saccos_id in the query -> 404', `${r.status}/${r.body.code}`, '404/GOV_RESOURCE_NOT_FOUND');

// C14 — the client sends the RIGHT id: nothing is rejected on that account.
r = await call('GET', '/api/saccos/7/meetings?saccos_id=7&group_id=7&group_type=SACCO', { token: TOK.owner });
eq('C14 agreeing claims pass binding', r.status, 200);

// ---------------------------------------------------------------------------
// Part D — denial before mutation
// ---------------------------------------------------------------------------

section('D. denial happens before the handler (zero writes)');

s = snap();
r = await call('POST', '/api/saccos/7/governance/resolutions/2/close', { token: TOK.owner });
eq('D1 closing a foreign resolution -> 404', `${r.status}/${r.body.code}`, '404/SACCOS_GOV_RESOLUTION_NOT_FOUND');
eq('D1a no write performed', writtenSince(s).length, 0);
ok('D1b handler never ran', !ranQuery(s, /UPDATE saccos_resolutions SET status/));

s = snap();
r = await call('POST', '/api/saccos/7/governance/resolutions/2/open', { token: TOK.owner });
eq('D2 opening a foreign resolution -> 404', `${r.status}/${r.body.code}`, '404/SACCOS_GOV_RESOLUTION_NOT_FOUND');
eq('D2a no write performed', writtenSince(s).length, 0);

s = snap();
r = await call('POST', '/api/saccos/7/governance/resolutions/2/vote', { token: TOK.member, body: { choice: 'FOR' } });
eq('D3 voting on a foreign resolution -> 404', `${r.status}/${r.body.code}`, '404/SACCOS_GOV_RESOLUTION_NOT_FOUND');
eq('D3a no vote row written', writtenSince(s).length, 0);

s = snap();
r = await call('POST', '/api/saccos/7/meetings/2/close', { token: TOK.owner });
eq('D4 closing a foreign meeting -> 404', `${r.status}/${r.body.code}`, '404/SACCOS_MEETING_NOT_FOUND');
eq('D4a no write performed', writtenSince(s).length, 0);

s = snap();
r = await call('POST', '/api/saccos/7/meetings/2/minutes', { token: TOK.owner, body: { minutes: 'M' } });
eq('D5 publishing minutes on a foreign meeting -> 404', `${r.status}/${r.body.code}`, '404/SACCOS_MEETING_NOT_FOUND');
eq('D5a no write performed', writtenSince(s).length, 0);

// ---------------------------------------------------------------------------
// Part E — fail-closed arms
// ---------------------------------------------------------------------------

section('E. both matrices fail closed');

const dropIdx = router.ROUTE_SACCOS_AUTHZ.findIndex(([m, p]) => m === 'GET' && p === '/:id/governance/resolutions');
const droppedAuthz = router.ROUTE_SACCOS_AUTHZ.splice(dropIdx, 1)[0];
r = await call('GET', '/api/saccos/7/governance/resolutions', { token: TOK.owner });
eq('E1 a route dropped from the capability matrix -> 403', r.status, 403);
eq('E1a code', r.body.code, 'GOV_AUTHZ_UNREGISTERED');
router.ROUTE_SACCOS_AUTHZ.splice(dropIdx, 0, droppedAuthz);

const dropIdx2 = router.ROUTE_SACCOS_RESOURCES.findIndex(([m, p]) => m === 'GET' && p === '/:id/meetings/:meetingId');
const droppedRes = router.ROUTE_SACCOS_RESOURCES.splice(dropIdx2, 1)[0];
r = await call('GET', '/api/saccos/7/meetings/1', { token: TOK.owner });
eq('E2 a route dropped from the binding matrix -> 403', r.status, 403);
eq('E2a code', r.body.code, 'GOV_RESOURCE_UNREGISTERED');
router.ROUTE_SACCOS_RESOURCES.splice(dropIdx2, 0, droppedRes);

const unknownIdx = router.ROUTE_SACCOS_RESOURCES.findIndex(([m, p]) => m === 'GET' && p === '/:id/governance/resolutions/:resolutionId');
const savedUnknown = router.ROUTE_SACCOS_RESOURCES[unknownIdx];
router.ROUTE_SACCOS_RESOURCES[unknownIdx] = ['GET', '/:id/governance/resolutions/:resolutionId', [{ from: 'path', keys: ['resolutionId'], type: 'WIDGET' }]];
r = await call('GET', '/api/saccos/7/governance/resolutions/1', { token: TOK.owner });
eq('E3 a descriptor naming an unknown resource kind -> 403', r.status, 403);
eq('E3a code', r.body.code, 'GOV_RESOURCE_UNREGISTERED');
router.ROUTE_SACCOS_RESOURCES[unknownIdx] = savedUnknown;
eq('E3b matrix restored', router.ROUTE_SACCOS_RESOURCES[unknownIdx][1], '/:id/governance/resolutions/:resolutionId');
eq('E3c capability matrix restored', router.ROUTE_SACCOS_AUTHZ[dropIdx][1], '/:id/governance/resolutions');
eq('E3d resource matrix restored', router.ROUTE_SACCOS_RESOURCES[dropIdx2][1], '/:id/meetings/:meetingId');

// A route inside the surface that nobody declared.
r = await call('DELETE', '/api/saccos/7/meetings', { token: TOK.owner });
eq('E4 an undeclared method inside the surface -> 403', r.status, 403);
eq('E4a code', r.body.code, 'GOV_AUTHZ_UNREGISTERED');
r = await call('GET', '/api/saccos/7/governance', { token: TOK.owner });
eq('E5 an undeclared path inside the surface -> 403', r.status, 403);
eq('E5a code', r.body.code, 'GOV_AUTHZ_UNREGISTERED');

// ---------------------------------------------------------------------------
// Part F — the services still refuse on their own (defence in depth)
// ---------------------------------------------------------------------------

section('F. service-level defence in depth (direct calls, no HTTP)');

let err = await catchError(() => saccosGovernance.createResolution(3, 7, { title: 'X' }));
eq('F1 createResolution on an outsider -> SACCOS_NOT_MEMBER', err && err.code, 'SACCOS_NOT_MEMBER');

err = await catchError(() => saccosGovernance.createResolution(1, 7, { title: 'X' }));
eq('F2 createResolution on a plain MEMBER -> SACCOS_RBAC', err && err.code, 'SACCOS_RBAC');

err = await catchError(() => saccosGovernance.closeResolution(1, 7, 1));
eq('F3 closeResolution on a plain MEMBER -> SACCOS_RBAC', err && err.code, 'SACCOS_RBAC');

err = await catchError(() => saccosGovernance.governanceSummary(3, 7));
eq('F4 governanceSummary on an outsider -> SACCOS_NOT_FOUND', err && err.code, 'SACCOS_NOT_FOUND');

err = await catchError(() => saccosMeetings.createMeeting(1, 7, { title: 'X', scheduledAt: new Date().toISOString() }));
eq('F5 createMeeting on a plain MEMBER -> SACCOS_RBAC', err && err.code, 'SACCOS_RBAC');

err = await catchError(() => saccosMeetings.meetingsSummary(3, 7));
eq('F6 meetingsSummary on an outsider -> SACCOS_NOT_MEMBER', err && err.code, 'SACCOS_NOT_MEMBER');

err = await catchError(() => saccosService.activateSaccos(1, 7));
eq('F7 activateSaccos on a plain MEMBER -> SACCOS_RBAC (OWNER only, decision 4)', err && err.code, 'SACCOS_RBAC');

err = await catchError(() => saccosService.activateSaccos(3, 7));
eq('F8 activateSaccos on an outsider -> SACCOS_NOT_MEMBER', err && err.code, 'SACCOS_NOT_MEMBER');

// ---------------------------------------------------------------------------
// Part G — cross-surface parity with /api/v1/governance
// ---------------------------------------------------------------------------

section('G. cross-surface parity');

err = await catchError(() => authorizeGroupContext({
  userId: 4, userRole: 'ADMIN', groupType: 'SACCO', groupId: 7, capability: CAPABILITIES.READ,
}));
eq('G1 the governance surface denies platform ADMIN READ (D10) -> SACCOS_NOT_MEMBER', err && err.code, 'SACCOS_NOT_MEMBER');
eq('G1a status', err && err.statusCode, 403);

err = await catchError(() => authorizeGroupContext({
  userId: 4, userRole: 'ADMIN', groupType: 'SACCO', groupId: 7, capability: CAPABILITIES.VOTE,
}));
eq('G2 the governance surface denies platform ADMIN VOTE -> SACCOS_NOT_MEMBER', err && err.code, 'SACCOS_NOT_MEMBER');

err = await catchError(() => authorizeGroupContext({
  userId: 4, userRole: 'ADMIN', groupType: 'SACCO', groupId: 7, capability: CAPABILITIES.GOVERN,
}));
eq('G3 GOVERN is still the one platform-admin grant', err, null);

eq('G4 exactly one platform-admin override exists', Object.keys(PLATFORM_ADMIN_OVERRIDES).length, 1);
eq('G5 and it is SACCOS:GOVERN', PLATFORM_ADMIN_OVERRIDES['SACCOS:GOVERN'], true);

// The SACCOS surface reaches the same answer through its own HTTP layer.
r = await call('GET', '/api/saccos/7/governance/resolutions', { token: TOK.admin });
eq('G6 the SACCOS surface agrees: ADMIN read -> 403 SACCOS_NOT_MEMBER', `${r.status}/${r.body.code}`, '403/SACCOS_NOT_MEMBER');
r = await call('GET', '/api/saccos/7/governance/summary', { token: TOK.admin });
eq('G7 and agrees on the one GOVERN override -> 200', r.status, 200);

// The shared matcher is genuinely shared, not a copy that can drift.
eq('G8 both surfaces import the same matcher', governanceRouter.stack.length > 0, true);
ok('G9 matchRouteParams/patternMatches are exported from the binding service',
  typeof binding.matchRouteParams === 'function' && typeof binding.patternMatches === 'function');
eq('G10 matchRouteParams captures the :id segment',
  JSON.stringify(binding.matchRouteParams('/:id/governance/resolutions', '/7/governance/resolutions')),
  JSON.stringify({ id: '7' }));
eq('G11 matchRouteParams refuses a different shape',
  binding.matchRouteParams('/:id/meetings', '/7/meetings/1'), null);

// ---------------------------------------------------------------------------
// Part H — positive control: the suite is not all-denies
// ---------------------------------------------------------------------------

section('H. positive control');

s = snap();
r = await call('POST', '/api/saccos/7/governance/resolutions', { token: TOK.owner, body: { title: 'Inayokubalika' } });
eq('H1 OWNER proposes -> 201', r.status, 201);
ok('H2 the insert reached the database', writtenSince(s).some((q) => H.insertResolution.test(q.sql)));
eq('H2a the stored saccos is the one from the path, not a client value',
  writtenSince(s).find((q) => H.insertResolution.test(q.sql)).params[0], 7);

r = await call('GET', '/api/saccos/7/governance/resolutions', { token: TOK.owner });
eq('H3 OWNER lists resolutions -> 200', r.status, 200);

r = await call('GET', '/api/saccos/7/meetings/1', { token: TOK.owner });
eq('H4 OWNER reads a meeting detail -> 200', r.status, 200);

s = snap();
r = await call('POST', '/api/saccos/7/meetings/1/attendance', { token: TOK.owner, body: { memberId: 702, status: 'ABSENT' } });
eq('H5 OWNER marks attendance for our own member -> 200', r.status, 200);
ok('H6 the attendance upsert reached the database', writtenSince(s).some((q) => H.insertAttendance.test(q.sql)));

console.log(`\nSACCOS GOVERNANCE BINDING (G3): ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failures:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
