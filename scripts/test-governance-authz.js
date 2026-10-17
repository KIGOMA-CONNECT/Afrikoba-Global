#!/usr/bin/env node
/**
 * G1 — Governance Authentication & Authorization Boundary tests.
 *
 * DB-free by design: `src/config/db` is replaced by an in-memory pool before
 * anything loads it, so this suite runs anywhere — no PostgreSQL, no server.
 * The SACCOS assertions are NOT stubbed; they run for real against the fake
 * pool, so what is tested is this branch's dispatch logic plus the pre-existing
 * saccosService semantics it relies on.
 *
 *   node scripts/test-governance-authz.js
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

const FIX = {
  users: {
    1: { id: 1, role: 'USER', is_active: true, auth_version: 0, full_name: 'Mjumbe', phone_number: '255713100001', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    2: { id: 2, role: 'USER', is_active: true, auth_version: 0, full_name: 'Mwenyekiti', phone_number: '255713100002', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    3: { id: 3, role: 'USER', is_active: true, auth_version: 0, full_name: 'Mgeni', phone_number: '255713100003', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    99: { id: 99, role: 'ADMIN', is_active: true, auth_version: 0, full_name: 'Admin', phone_number: '255713100099', email: null, kyc_level: 3, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
  },
  vicobaGroups: {
    7: { id: 7, status: 'ACTIVE' },
    8: { id: 8, status: 'ACTIVE' },
    9: { id: 9, status: 'SUSPENDED' },
    10: { id: 10, status: 'CLOSED' },
  },
  vicobaMembers: [
    { id: 101, group_id: 7, user_id: 1, role_in_group: 'MJUMBE' },
    { id: 102, group_id: 7, user_id: 2, role_in_group: 'MWENYEKITI' },
    { id: 103, group_id: 9, user_id: 1, role_in_group: 'MWENYEKITI' },
    { id: 104, group_id: 10, user_id: 1, role_in_group: 'MWENYEKITI' },
    { id: 105, group_id: 7, user_id: 99, role_in_group: 'MJUMBE' },
  ],
  saccosMembers: [
    { id: 201, saccos_id: 5, user_id: 1, role: 'MEMBER', status: 'ACTIVE' },
    { id: 202, saccos_id: 5, user_id: 2, role: 'OWNER', status: 'ACTIVE' },
    { id: 203, saccos_id: 6, user_id: 1, role: 'MEMBER', status: 'INVITED' },
    { id: 204, saccos_id: 7, user_id: 3, role: 'MEMBER', status: 'SUSPENDED' },
  ],
  // Governance resources owned by VICOBA group 7. G2 resolves every resource
  // id back to its owning group before a handler runs, so F11's sweep needs
  // these rows to exist and to belong to the group the officer is acting as.
  governance: {
    meetings: { 1: { id: 1, group_type: 'VICOBA', group_id: 7 } },
    channels: { 1: { id: 1, group_type: 'VICOBA', group_id: 7 } },
    documents: { 1: { id: 1, group_type: 'VICOBA', group_id: 7 } },
    proposals: { 1: { id: 1, group_type: 'VICOBA', group_id: 7 } },
    resolutions: { 1: { id: 1, group_type: 'VICOBA', group_id: 7 } },
    actionItems: { 1: { id: 1, group_type: 'VICOBA', group_id: 7 } },
    minutes: { 1: { id: 1, meeting_id: 1, group_type: 'VICOBA', group_id: 7 } },
    transcripts: { 1: { id: 1, meeting_id: 1, group_type: 'VICOBA', group_id: 7 } },
    executions: { 1: { id: 1, group_id: 7, resolution_id: 1 } },
    accessGrants: { 1: { id: 1, record_type: 'DOCUMENT', record_id: 1 } },
  },
};

const queryLog = [];

function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ');
  queryLog.push({ sql: s, params });
  if (/revoked_tokens/.test(s)) return { rows: [] };
  if (/FROM users WHERE id/.test(s)) {
    const u = FIX.users[params[0]];
    return { rows: u ? [u] : [] };
  }
  if (/vicoba_members/.test(s)) {
    const [gid, uid] = params;
    const m = FIX.vicobaMembers.find((x) => x.group_id === gid && x.user_id === uid);
    return { rows: m ? [m] : [] };
  }
  if (/vicoba_groups/.test(s)) {
    const g = FIX.vicobaGroups[params[0]];
    return { rows: g ? [g] : [] };
  }
  if (/saccos_members/.test(s)) {
    const [sid, uid] = params;
    if (/AND status\s*=\s*\$3/.test(s)) {
      const m = FIX.saccosMembers.find((x) => x.saccos_id === sid && x.user_id === uid && x.status === params[2]);
      return { rows: m ? [m] : [] };
    }
    const m = FIX.saccosMembers.find((x) => x.saccos_id === sid && x.user_id === uid);
    return { rows: m ? [m] : [] };
  }

  // G2 resource-to-group binding — canonical ownership lookups. Minutes and
  // transcripts carry no group columns of their own, so they resolve through
  // their meeting; those JOINs are matched first because they also mention
  // governance_meetings.
  if (/FROM governance_minutes c JOIN/.test(s)) {
    const r = FIX.governance.minutes[params[0]];
    return { rows: r ? [{ group_type: r.group_type, group_id: r.group_id }] : [] };
  }
  if (/FROM governance_transcripts c JOIN/.test(s)) {
    const r = FIX.governance.transcripts[params[0]];
    return { rows: r ? [{ group_type: r.group_type, group_id: r.group_id }] : [] };
  }
  const directOwnership = [
    [/FROM governance_meetings WHERE id\s*=\s*\$1$/, FIX.governance.meetings],
    [/FROM governance_channels WHERE id\s*=\s*\$1$/, FIX.governance.channels],
    [/FROM governance_documents WHERE id\s*=\s*\$1$/, FIX.governance.documents],
    [/FROM governance_proposals WHERE id\s*=\s*\$1$/, FIX.governance.proposals],
    [/FROM governance_resolutions WHERE id\s*=\s*\$1$/, FIX.governance.resolutions],
    [/FROM governance_action_items WHERE id\s*=\s*\$1$/, FIX.governance.actionItems],
    [/FROM governance_financial_executions WHERE id\s*=\s*\$1$/, FIX.governance.executions],
    [/FROM governance_access_grants WHERE id\s*=\s*\$1$/, FIX.governance.accessGrants],
  ];
  for (const [pattern, table] of directOwnership) {
    if (pattern.test(s)) {
      const r = table[params[0]];
      return { rows: r ? [r] : [] };
    }
  }

  return { rows: [] };
}

const logRecords = [];
const loggerStub = {
  info: (...a) => logRecords.push(['info', ...a]),
  warn: (...a) => logRecords.push(['warn', ...a]),
  error: (...a) => logRecords.push(['error', ...a]),
  debug: () => {},
  log: (...a) => logRecords.push(['log', ...a]),
};

stubModule(require.resolve('../src/config/db'), {
  query: fakeQuery,
  connect: async () => {},
  end: () => {},
  on: () => {},
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
});
stubModule(require.resolve('../src/utils/logger'), loggerStub);

const router = require('../src/routes/governanceRoutes');
const { CAPABILITIES, extractGroupContext, authorizeGroupContext, requireGovernance, PLATFORM_ADMIN_OVERRIDES } = require('../src/services/governanceAuthorizationService');
const { signToken } = require('../src/middleware/auth');

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

let pass = 0;
const failures = [];

function section(name) {
  console.log(`\n=== ${name} ===`);
}
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  | ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}
async function throwsCode(name, fn, code) {
  try {
    await fn();
    failures.push(name);
    console.log(`  FAIL  ${name}  | expected ${code}, nothing thrown`);
  } catch (err) {
    eq(name, err.code, code);
  }
}

// ---------------------------------------------------------------------------
// Part A — structural: every route is authenticated and declared in the matrix
// ---------------------------------------------------------------------------

section('A. structural — router wiring');

const declared = [];
for (const layer of router.stack) {
  if (!layer.route) continue;
  const path = Array.isArray(layer.route.path) ? layer.route.path[0] : layer.route.path;
  for (const m of Object.keys(layer.route.methods)) {
    if (m !== '_all') declared.push(`${m.toUpperCase()} ${path}`);
  }
}
const matrix = router.ROUTE_AUTHZ.map(([m, p, c]) => `${m} ${p}`);
const matrixCaps = router.ROUTE_AUTHZ.map(([, , c]) => c);

eq('A1 routes declared in router', declared.length, 43);
eq('A2 entries in capability matrix', matrix.length, 43);
eq('A3 every declared route has a matrix entry',
  declared.filter((k) => !matrix.includes(k)).length, 0);
eq('A4 every matrix entry has a declared route',
  matrix.filter((k) => !declared.includes(k)).length, 0);

const src = require('fs').readFileSync(require.resolve('../src/routes/governanceRoutes.js'), 'utf8');
ok('A5 ensurePrivilege() removed', !/ensurePrivilege/.test(src));
ok('A6 authRequired mounted at router level',
  router.stack.length > 0 && !router.stack[0].route && router.stack[0].handle.name === 'authRequired');
ok('A7 authorization layer mounted immediately after auth',
  router.stack.length > 1 && !router.stack[1].route);
ok('A8 no route declares an unknown capability',
  matrixCaps.every((c) => Object.values(CAPABILITIES).includes(c)));
ok('A9 officer-only capabilities are represented',
  matrixCaps.includes(CAPABILITIES.GOVERN) && matrixCaps.includes(CAPABILITIES.FINANCIAL));
eq('A10 FINANCIAL routes (must be guarded)',
  matrixCaps.filter((c) => c === CAPABILITIES.FINANCIAL).length, 4);

// ---------------------------------------------------------------------------
// Part B — group context extraction (pure, no DB)
// ---------------------------------------------------------------------------

section('B. extractGroupContext');

const ctxOf = (o) => extractGroupContext(o);

eq('B1 missing group id -> null', ctxOf({ body: {}, query: {}, params: {} }), null);
eq('B2 snake_case from query', JSON.stringify(ctxOf({ query: { group_id: '7', group_type: 'VICOBA' } })), JSON.stringify({ groupType: 'VICOBA', groupId: 7 }));
eq('B3 camelCase from body', JSON.stringify(ctxOf({ body: { groupId: 7, groupType: 'VICOBA' } })), JSON.stringify({ groupType: 'VICOBA', groupId: 7 }));
eq('B4 group type defaults to VICOBA', ctxOf({ query: { group_id: 7 } }).groupType, 'VICOBA');
eq('B5 group type is normalised', ctxOf({ query: { group_id: 7, group_type: 'vicoba' } }).groupType, 'VICOBA');
eq('B6 non-numeric group id -> null', ctxOf({ query: { group_id: 'abc' } }), null);
eq('B7 zero group id -> null', ctxOf({ query: { group_id: 0 } }), null);
eq('B8 negative group id -> null', ctxOf({ query: { group_id: -3 } }), null);
eq('B9 fractional group id -> null', ctxOf({ query: { group_id: '7.5' } }), null);
eq('B10 params source works', ctxOf({ params: { group_id: '7' } }).groupId, 7);
eq('B11 numeric string accepted', ctxOf({ body: { groupId: '7' } }).groupId, 7);
ok('B12 body wins over query when both present',
  ctxOf({ body: { groupId: 7 }, query: { group_id: 8 } }).groupId === 7);

// ---------------------------------------------------------------------------
// Part C — VICOBA authorization
// ---------------------------------------------------------------------------

async function main() {

section('C. VICOBA authorization (vicoba_members / vicoba_groups)');

const V = (p) => Object.assign({ userId: 1, userRole: 'USER', groupType: 'VICOBA', capability: CAPABILITIES.READ, groupId: 7 }, p);

await throwsCode('C1 non-member denied', () => authorizeGroupContext(V({ groupId: 8 })), 'GOV_NOT_A_MEMBER');
await throwsCode('C2 member denied on suspended group', () => authorizeGroupContext(V({ groupId: 9 })), 'GOV_GROUP_INACTIVE');
await throwsCode('C3 member denied on closed group', () => authorizeGroupContext(V({ groupId: 10 })), 'GOV_GROUP_INACTIVE');

const c4 = await authorizeGroupContext(V({}));
eq('C4 member + READ allowed', c4.allowed, true);
eq('C4a context.membershipId', c4.membershipId, 101);
eq('C4b context.role', c4.role, 'MJUMBE');
eq('C4c context.status is null (vicoba_members has no status column)', c4.status, null);
eq('C4d context.groupStatus', c4.groupStatus, 'ACTIVE');
eq('C4e context.groupType', c4.groupType, 'VICOBA');
eq('C4f context.groupId', c4.groupId, 7);
eq('C4g context.isPlatformAdmin', c4.isPlatformAdmin, false);
eq('C4h context.reason', c4.reason, 'member');
eq('C4i context.capability', c4.capability, CAPABILITIES.READ);

await throwsCode('C5 MJUMBE denied GOVERN', () => authorizeGroupContext(V({ capability: CAPABILITIES.GOVERN })), 'GOV_ROLE_FORBIDDEN');
const c6 = await authorizeGroupContext(V({ userId: 2, capability: CAPABILITIES.GOVERN }));
eq('C6 MWENYEKITI allowed GOVERN', c6.allowed, true);
eq('C6a officer role reported', c6.role, 'MWENYEKITI');

await throwsCode('C7 MJUMBE denied FINANCIAL', () => authorizeGroupContext(V({ capability: CAPABILITIES.FINANCIAL })), 'GOV_ROLE_FORBIDDEN');
const c8 = await authorizeGroupContext(V({ userId: 2, capability: CAPABILITIES.FINANCIAL }));
eq('C8 MWENYEKITI allowed FINANCIAL', c8.allowed, true);

const c9 = await authorizeGroupContext(V({ capability: CAPABILITIES.VOTE }));
eq('C9 MJUMBE allowed VOTE (member participates)', c9.allowed, true);
const c10 = await authorizeGroupContext(V({ capability: CAPABILITIES.WRITE }));
eq('C10 MJUMBE allowed WRITE', c10.allowed, true);

// platform ADMIN — never a member, voter or financial authority here
const ADMIN = { userId: 99, userRole: 'ADMIN' };
await throwsCode('C11 ADMIN not a VICOBA member (READ)', () => authorizeGroupContext(V(Object.assign({}, ADMIN, { groupId: 8 }))), 'GOV_NOT_A_MEMBER');
await throwsCode('C12 ADMIN never a voter (VOTE)', () => authorizeGroupContext(V(Object.assign({}, ADMIN, { groupId: 8, capability: CAPABILITIES.VOTE }))), 'GOV_NOT_A_MEMBER');
await throwsCode('C13 ADMIN no financial authority', () => authorizeGroupContext(V(Object.assign({}, ADMIN, { groupId: 8, capability: CAPABILITIES.FINANCIAL }))), 'GOV_NOT_A_MEMBER');
await throwsCode('C14 ADMIN no VICOBA GOVERN override', () => authorizeGroupContext(V(Object.assign({}, ADMIN, { groupId: 8, capability: CAPABILITIES.GOVERN }))), 'GOV_NOT_A_MEMBER');

const c15 = await authorizeGroupContext(V({ userId: 99, userRole: 'ADMIN', capability: CAPABILITIES.READ }));
eq('C15 ADMIN who IS a member is judged on membership, not role', c15.allowed, true);
eq('C15a but isPlatformAdmin is still reported', c15.isPlatformAdmin, true);
eq('C15b membership id, not null', c15.membershipId, 105);

await throwsCode('C16 unsupported group type denied', () => authorizeGroupContext(V({ groupType: 'COOPERATIVE' })), 'GOV_GROUP_TYPE_UNSUPPORTED');
await throwsCode('C17 unknown capability denied', () => authorizeGroupContext(V({ capability: 'DELETE' })), 'GOV_GROUP_TYPE_UNSUPPORTED');
await throwsCode('C18 orphan membership (group row missing)', async () => {
  const save = FIX.vicobaGroups[7];
  delete FIX.vicobaGroups[7];
  try { return await authorizeGroupContext(V({})); } finally { FIX.vicobaGroups[7] = save; }
}, 'GOV_GROUP_NOT_FOUND');

// ---------------------------------------------------------------------------
// Part D — SACCOS authorization (real saccosService over the fake pool)
// ---------------------------------------------------------------------------

section('D. SACCOS authorization (assertVisible / assertActiveRole / assertMembershipCanAdminister)');

const S = (p) => Object.assign({ userId: 1, userRole: 'USER', groupType: 'SACCO', groupId: 5, capability: CAPABILITIES.READ }, p);

const d1 = await authorizeGroupContext(S({}));
eq('D1 active MEMBER allowed READ', d1.allowed, true);
eq('D1a membershipId', d1.membershipId, 201);
eq('D1b role', d1.role, 'MEMBER');
eq('D1c status', d1.status, 'ACTIVE');
eq('D1d groupStatus null (group lifecycle lives on saccos)', d1.groupStatus, null);
eq('D1e reason', d1.reason, 'member');

const d2 = await authorizeGroupContext(S({ userId: 2, capability: CAPABILITIES.GOVERN }));
eq('D2 active OWNER allowed GOVERN', d2.allowed, true);
eq('D2a reason is member, not override', d2.reason, 'member');

await throwsCode('D3 MEMBER denied GOVERN', () => authorizeGroupContext(S({ capability: CAPABILITIES.GOVERN })), 'SACCOS_RBAC');
const d4 = await authorizeGroupContext(S({ userId: 2, capability: CAPABILITIES.FINANCIAL }));
eq('D4 OWNER allowed FINANCIAL', d4.allowed, true);
await throwsCode('D5 MEMBER denied FINANCIAL', () => authorizeGroupContext(S({ capability: CAPABILITIES.FINANCIAL })), 'SACCOS_RBAC');
const d6 = await authorizeGroupContext(S({ capability: CAPABILITIES.VOTE }));
eq('D6 MEMBER allowed VOTE', d6.allowed, true);

// non-active memberships
await throwsCode('D7 INVITED membership not active', () => authorizeGroupContext(S({ groupId: 6 })), 'SACCOS_NOT_MEMBER');
await throwsCode('D8 SUSPENDED membership not active', () => authorizeGroupContext(S({ userId: 3, groupId: 7 })), 'SACCOS_NOT_MEMBER');
await throwsCode('D9 outsider gets 404, no enumeration', () => authorizeGroupContext(S({ userId: 3, groupId: 5 })), 'SACCOS_NOT_FOUND');

// platform ADMIN — one documented override only (GOVERN)
const SA = { userId: 99, userRole: 'ADMIN', groupId: 5 };
await throwsCode('D10 ADMIN not treated as SACCOS member (READ)', () => authorizeGroupContext(S(Object.assign({}, SA, { capability: CAPABILITIES.READ }))), 'SACCOS_NOT_MEMBER');
await throwsCode('D11 ADMIN never a voter (VOTE)', () => authorizeGroupContext(S(Object.assign({}, SA, { capability: CAPABILITIES.VOTE }))), 'SACCOS_NOT_MEMBER');
await throwsCode('D12 ADMIN no SACCOS financial authority', () => authorizeGroupContext(S(Object.assign({}, SA, { capability: CAPABILITIES.FINANCIAL }))), 'SACCOS_NOT_MEMBER');

const d13 = await authorizeGroupContext(S(Object.assign({}, SA, { capability: CAPABILITIES.GOVERN })));
eq('D13 ADMIN GOVERN override (the single documented one)', d13.allowed, true);
eq('D13a override is explicit in reason', d13.reason, 'platform_admin_override');
eq('D13b no fabricated membership id', d13.membershipId, null);
eq('D13c no fabricated role', d13.role, null);
eq('D13d isPlatformAdmin reported', d13.isPlatformAdmin, true);

eq('D14 override table holds exactly one entry', Object.keys(PLATFORM_ADMIN_OVERRIDES).length, 1);
eq('D14a and it is SACCOS:GOVERN', PLATFORM_ADMIN_OVERRIDES['SACCOS:GOVERN'], true);

// cross-group isolation: member of 5 knows nothing about 6/7 as a member
await throwsCode('D15 member of one SACCOS cannot act on another', () => authorizeGroupContext(S({ groupId: 6, capability: CAPABILITIES.READ })), 'SACCOS_NOT_MEMBER');

// ---------------------------------------------------------------------------
// Part E — requireGovernance middleware
// ---------------------------------------------------------------------------

section('E. requireGovernance middleware');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    sent: false,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.sent = true; return this; },
  };
}
function runMw(mw, req) {
  return new Promise((resolve) => {
    const res = fakeRes();
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; resolve({ res, next: err || null }); };
    try {
      const ret = mw(req, res, done);
      if (ret && typeof ret.then === 'function') ret.then(() => done(), done);
      else setTimeout(() => done(), 0);
    } catch (e) { done(e); }
  });
}

const e1 = await runMw(requireGovernance(CAPABILITIES.READ), { path: '/meetings', query: { group_id: 7 } });
eq('E1 no authenticated user -> 401', e1.res.statusCode, 401);
eq('E1a code', e1.res.body && e1.res.body.code, 'AUTH_REQUIRED');

const e2 = await runMw(requireGovernance(CAPABILITIES.READ), { path: '/meetings', user: { id: 1, role: 'USER' }, query: {} });
eq('E2 no group context -> 403', e2.res.statusCode, 403);
eq('E2a code', e2.res.body && e2.res.body.code, 'GOV_GROUP_REQUIRED');

const e3req = { path: '/meetings', user: { id: 1, role: 'USER' }, query: { group_id: 8 } };
const e3 = await runMw(requireGovernance(CAPABILITIES.READ), e3req);
eq('E3 non-member -> 403', e3.res.statusCode, 403);
eq('E3a code', e3.res.body && e3.res.body.code, 'GOV_NOT_A_MEMBER');
eq('E3b next() not called', e3.next, null);

const e4req = { path: '/meetings', user: { id: 1, role: 'USER' }, query: { group_id: 7 } };
const e4 = await runMw(requireGovernance(CAPABILITIES.READ), e4req);
eq('E4 member -> next()', e4.next, null);
eq('E4a response not sent', e4.res.sent, false);
eq('E4b req.governance populated', !!(e4req.governance && e4req.governance.allowed), true);
eq('E4c context carries membership', e4req.governance.membershipId, 101);

// A denial must never fall through to next(err) for an unexpected error shape
const e5req = { path: '/meetings', user: { id: 1, role: 'USER' }, query: { group_id: 'not-a-number' } };
const e5 = await runMw(requireGovernance(CAPABILITIES.READ), e5req);
eq('E5 malformed group id -> 403 not 500', e5.res.statusCode, 403);

// ---------------------------------------------------------------------------
// Part F — fail-closed request routing
// ---------------------------------------------------------------------------

section('F. request runner — full router stack (auth -> authz -> handler)');

function matchPath(pattern, path) {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg[0] === ':' || seg === b[i]);
}

async function runRequest({ method = 'GET', path, token, body = {}, query = {}, params = {} } = {}) {
  const req = {
    method,
    path,
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
    query,
    params,
  };
  const res = fakeRes();
  const state = { handler: false, error: null };

  async function step(i) {
    if (res.sent || state.error) return;
    if (i >= router.stack.length) return;
    const layer = router.stack[i];
    if (layer.route) {
      const methods = Object.keys(layer.route.methods);
      const routePath = Array.isArray(layer.route.path) ? layer.route.path[0] : layer.route.path;
      if (methods.includes(method.toLowerCase()) && matchPath(routePath, path)) state.handler = true;
      return step(i + 1);
    }
    await new Promise((resolve) => {
      let settled = false;
      const finish = (err) => { if (settled) return; settled = true; if (err) state.error = err; resolve(); };
      try {
        const ret = layer.handle(req, res, finish);
        if (ret && typeof ret.then === 'function') ret.then(() => finish(), finish);
        else if (res.sent) finish();
      } catch (e) { finish(e); }
    });
    return step(i + 1);
  }
  await step(0);
  return { status: res.statusCode, body: res.body, handler: state.handler, error: state.error, req };
}

const anon = await runRequest({ path: '/meetings', query: { group_id: 7 } });
eq('F1 anonymous -> 401', anon.status, 401);
eq('F1a handler never reached', anon.handler, false);

const anonPost = await runRequest({ method: 'POST', path: '/financial-executions', body: { group_id: 7, amount: 1000 } });
eq('F2 anonymous mutation -> 401 (no write)', anonPost.status, 401);
eq('F2a handler never reached', anonPost.handler, false);

const anonVec = [
  ['GET', '/meetings', { group_id: 7 }],
  ['GET', '/meetings/1', { group_id: 7 }],
  ['POST', '/meetings/1/status', { group_id: 7 }],
  ['POST', '/channels/1/messages', { group_id: 7 }],
  ['POST', '/proposals/1/vote', { group_id: 7 }],
  ['POST', '/constitution', { group_id: 7 }],
  ['POST', '/documents/1/access', { group_id: 7 }],
  ['POST', '/financial-executions/1/executed', { group_id: 7 }],
  ['DELETE', '/access-grants/1', { group_id: 7 }],
  ['POST', '/minutes/1/confirm', { group_id: 7 }],
  ['POST', '/resolutions/1/trigger-loan', { group_id: 7 }],
];
let anonAll = true;
for (const [method, path, q] of anonVec) {
  const r = await runRequest({ method, path, query: q });
  if (r.status !== 401 || r.handler) { anonAll = false; console.log(`        anon leak: ${method} ${path} -> ${r.status} handler=${r.handler}`); }
}
ok('F3 every sampled route rejects anonymous (11/11)', anonAll);

const userToken = signToken(FIX.users[1]);
const authed = await runRequest({ path: '/meetings', token: userToken, query: { group_id: 7 } });
eq('F4 authenticated member reaches handler', authed.handler, true);
eq('F4a no error', authed.error, null);

const outsider = await runRequest({ path: '/meetings', token: userToken, query: { group_id: 8 } });
eq('F5 authenticated non-member -> 403', outsider.status, 403);
eq('F5a handler never reached', outsider.handler, false);
eq('F5b code', outsider.body && outsider.body.code, 'GOV_NOT_A_MEMBER');

const noGroup = await runRequest({ path: '/proposals/1/vote', method: 'POST', token: userToken, body: { choice: 'YES' } });
eq('F6 resource-keyed route without group ctx -> 403', noGroup.status, 403);
eq('F6a handler never reached', noGroup.handler, false);
eq('F6b code', noGroup.body && noGroup.body.code, 'GOV_GROUP_REQUIRED');

const wrongCap = await runRequest({ path: '/constitution', method: 'POST', token: userToken, body: { group_id: 7, rules: {} } });
eq('F7 MJUMBE cannot amend constitution -> 403', wrongCap.status, 403);
eq('F7a code', wrongCap.body && wrongCap.body.code, 'GOV_ROLE_FORBIDDEN');
eq('F7b handler never reached', wrongCap.handler, false);

const finLeak = await runRequest({ path: '/financial-executions', method: 'POST', token: userToken, body: { group_id: 7, amount: 100 } });
eq('F8 MJUMBE cannot create financial execution -> 403', finLeak.status, 403);
eq('F8a handler never reached', finLeak.handler, false);

const unregistered = await runRequest({ method: 'PATCH', path: '/meetings', token: userToken, query: { group_id: 7 } });
eq('F9 unregistered method -> 403 (fail closed)', unregistered.status, 403);
eq('F9a code', unregistered.body && unregistered.body.code, 'GOV_AUTHZ_UNREGISTERED');
eq('F9b handler never reached', unregistered.handler, false);

const bogusPath = await runRequest({ path: '/does-not-exist', token: userToken, query: { group_id: 7 } });
eq('F10 unregistered path -> 403 (fail closed)', bogusPath.status, 403);
eq('F10a handler never reached', bogusPath.handler, false);

// Every declared route must be reachable through the matcher by a principal
// that is actually entitled to it — an officer of the group, so READ/WRITE/
// VOTE/GOVERN/FINANCIAL all resolve. A plain member reaching only 28 of 43 is
// the correct behaviour, not a wiring gap (see F7/F8).
const officerToken = signToken(FIX.users[2]);
let reachable = 0;
const unreachable = [];
for (const key of declared) {
  const [method, path] = key.split(' ');
  const concrete = path.replace(/:[^/]+/g, '1');
  const r = await runRequest({ method, path: concrete, token: officerToken, query: { group_id: 7 }, body: { group_id: 7 } });
  if (r.handler) reachable += 1;
  else unreachable.push(`${key} -> ${r.status} ${r.body && r.body.code}`);
}
eq('F11 all 43 routes reachable for an authorised officer', reachable, 43);
if (unreachable.length) unreachable.forEach((u) => console.log(`        ${u}`));

// And the same principal still cannot touch a group it does not belong to.
let crossGroupBlocked = 0;
for (const key of declared) {
  const [method, path] = key.split(' ');
  const concrete = path.replace(/:[^/]+/g, '1');
  const r = await runRequest({ method, path: concrete, token: officerToken, query: { group_id: 8 }, body: { group_id: 8 } });
  if (!r.handler) crossGroupBlocked += 1;
}
eq('F12 all 43 routes blocked on a group the officer does not belong to', crossGroupBlocked, 43);

// ---------------------------------------------------------------------------
// Part G — negative controls (these guards must not be vacuous)
// ---------------------------------------------------------------------------

section('G. negative controls');

ok('G1 denial actually queries membership (not a constant deny)',
  queryLog.some((q) => /vicoba_members/.test(q.sql)));
ok('G2 authorization consults group lifecycle',
  queryLog.some((q) => /vicoba_groups/.test(q.sql)));
ok('G3 SACCOS path consulted saccos_members',
  queryLog.some((q) => /saccos_members/.test(q.sql)));
ok('G4 platform role is read for isPlatformAdmin',
  queryLog.some((q) => /FROM users WHERE id/.test(q.sql)));

const g5 = await authorizeGroupContext(V({ userId: 2, groupType: 'VICOBA', groupId: 7, capability: CAPABILITIES.FINANCIAL }));
ok('G5 positive control: officer CAN pass financial gate (suite is not all-denies)', g5.allowed === true);

const g6 = await authorizeGroupContext(V({ userId: 1, groupId: 7, capability: CAPABILITIES.VOTE }));
ok('G6 positive control: plain member CAN vote', g6.allowed === true);

eq('G7 exactly one platform-admin override exists', Object.keys(PLATFORM_ADMIN_OVERRIDES).length, 1);

// ---------------------------------------------------------------------------
// Part H — real Express mount
//
// Part F faked `req.path`. The matrix matcher depends on Express stripping the
// mount prefix (/api/governance) before the router's middleware runs; if it
// did not, `req.path` would be '/api/governance/meetings', nothing would
// match, and every request would fail closed with GOV_AUTHZ_UNREGISTERED.
// This part proves that assumption against a real HTTP stack.
// ---------------------------------------------------------------------------

section('H. real Express mount (validates mount-prefix stripping)');

const express = require('express');
const supertest = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/governance', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({
  success: false, code: err.code || 'INTERNAL_ERROR', message: err.message,
}));

const h1 = await supertest(app).get('/api/governance/meetings?group_id=7');
eq('H1 anonymous behind real mount -> 401', h1.status, 401);
ok('H1a handler not reached', !(h1.body && h1.body.code === 'INTERNAL_ERROR'));

const h2 = await supertest(app)
  .get('/api/governance/meetings?group_id=7')
  .set('Authorization', `Bearer ${officerToken}`);
ok('H2 authorized member passes the matrix (req.path is mount-stripped)',
  !(h2.status === 403 && h2.body && h2.body.code === 'GOV_AUTHZ_UNREGISTERED'),
  `status=${h2.status} code=${h2.body && h2.body.code}`);

const h3 = await supertest(app)
  .get('/api/governance/meetings?group_id=8')
  .set('Authorization', `Bearer ${officerToken}`);
eq('H3 non-member behind real mount -> 403', h3.status, 403);
eq('H3a code', h3.body.code, 'GOV_NOT_A_MEMBER');

const h4 = await supertest(app)
  .post('/api/governance/proposals/1/vote')
  .set('Authorization', `Bearer ${userToken}`)
  .send({ choice: 'YES' });
eq('H4 resource-keyed route without group context -> 403', h4.status, 403);
eq('H4a code', h4.body.code, 'GOV_GROUP_REQUIRED');
eq('H4b vote never cast', h4.body.success, false);

const h5 = await supertest(app)
  .post('/api/governance/financial-executions')
  .set('Authorization', `Bearer ${userToken}`)
  .send({ group_id: 7, amount: 1000, financial_action_type: 'GENERAL' });
eq('H5 member without officer role cannot create execution -> 403', h5.status, 403);
eq('H5a code', h5.body.code, 'GOV_ROLE_FORBIDDEN');

const h6 = await supertest(app)
  .patch('/api/governance/meetings')
  .set('Authorization', `Bearer ${officerToken}`)
  .send({ group_id: 7 });
eq('H6 unregistered method -> 403 fail-closed', h6.status, 403);
eq('H6a code', h6.body.code, 'GOV_AUTHZ_UNREGISTERED');

// F1 — a capability the middleware does not recognise cannot be enforced, so
// it must fail closed with a clean 403 here. Before F1 this line threw a
// TypeError, Express converted it to 500, and the matrix guard was only as
// strong as test A8.
const f1Index = router.ROUTE_AUTHZ.findIndex(([m, p]) => m === 'GET' && p === '/meetings');
const savedCapability = router.ROUTE_AUTHZ[f1Index][2];
router.ROUTE_AUTHZ[f1Index][2] = 'NOT_A_REAL_CAPABILITY';

const h7 = await supertest(app)
  .get('/api/governance/meetings?group_id=7')
  .set('Authorization', `Bearer ${officerToken}`);
eq('H7 unknown capability -> 403 (F1, not a 500)', h7.status, 403);
eq('H7a code', h7.body.code, 'GOV_AUTHZ_UNREGISTERED');
ok('H7b no server error leaked', !(h7.body && /internal/i.test(h7.body.code || '')), `got ${h7.status} ${h7.body && h7.body.code}`);

router.ROUTE_AUTHZ[f1Index][2] = savedCapability;
eq('H7c matrix restored', router.ROUTE_AUTHZ[f1Index][2], savedCapability);

const h8 = await supertest(app)
  .get('/api/governance/meetings?group_id=7')
  .set('Authorization', `Bearer ${officerToken}`);
ok('H8 authorized request works again after restore',
  !(h8.status === 403 && h8.body && h8.body.code === 'GOV_AUTHZ_UNREGISTERED'),
  `status=${h8.status} code=${h8.body && h8.body.code}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`G1 governance authz: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.log(`  FAILED: ${f}`));
}
console.log(`${'-'.repeat(60)}`);
process.exit(failures.length ? 1 : 0);

}

main().catch((err) => {
  console.error('G1 test runner crashed:', err);
  process.exit(1);
});
