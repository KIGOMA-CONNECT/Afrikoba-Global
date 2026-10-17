#!/usr/bin/env node
/**
 * G2 — Resource-to-Group Binding tests.
 *
 * DB-free by design: `src/config/db`, `src/utils/logger` and
 * `src/services/vicobaService` are replaced in the module cache before
 * anything under src/ is loaded, so this suite runs anywhere — no PostgreSQL,
 * no server.
 *
 * Two kinds of assertion are made:
 *   * status / code over a real Express + supertest stack, which proves the
 *     binding layer runs before the handler; and
 *   * the query log, which proves the stronger claim — that a denial performed
 *     no write at all, and that the financial service refuses on its own when
 *     it is called directly (defense in depth, decision D4).
 *
 *   node scripts/test-governance-resource-binding.js
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

const OWN = 'VICOBA';   // group the acting officers below belong to
const OTHER = 'VICOBA'; // group used as the foreign resource owner

const FIX = {
  users: {
    1: { id: 1, role: 'USER', is_active: true, auth_version: 0, full_name: 'Mjumbe', phone_number: '255713100001', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    2: { id: 2, role: 'USER', is_active: true, auth_version: 0, full_name: 'Mwenyekiti wa 7', phone_number: '255713100002', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
    4: { id: 4, role: 'USER', is_active: true, auth_version: 0, full_name: 'Mwenyekiti wa 8', phone_number: '255713100004', email: null, kyc_level: 1, wallet_balance: 0, locked_balance: 0, trust_score: 0, nida_number: null, currency_code: 'TZS', device_policy: null },
  },
  vicobaGroups: {
    7: { id: 7, status: 'ACTIVE' },
    8: { id: 8, status: 'ACTIVE' },
  },
  vicobaMembers: [
    { id: 101, group_id: 7, user_id: 1, role_in_group: 'MJUMBE' },
    { id: 102, group_id: 7, user_id: 2, role_in_group: 'MWENYEKITI' },
    { id: 108, group_id: 8, user_id: 4, role_in_group: 'MWENYEKITI' },
  ],
  // Every governance resource exists twice: id 1 owned by group 7 (ours) and
  // id 2 owned by group 8 (theirs). The whole suite turns on that contrast.
  governance: {
    meetings: {
      1: { id: 1, group_type: OWN, group_id: 7 },
      2: { id: 2, group_type: OTHER, group_id: 8 },
    },
    channels: {
      1: { id: 1, group_type: OWN, group_id: 7 },
      2: { id: 2, group_type: OTHER, group_id: 8 },
    },
    documents: {
      1: { id: 1, group_type: OWN, group_id: 7 },
      2: { id: 2, group_type: OTHER, group_id: 8 },
    },
    proposals: {
      1: { id: 1, group_type: OWN, group_id: 7 },
      2: { id: 2, group_type: OTHER, group_id: 8 },
    },
    resolutions: {
      1: { id: 1, group_type: OWN, group_id: 7, financial_action_type: 'GENERAL' },
      2: { id: 2, group_type: OTHER, group_id: 8, financial_action_type: 'LOAN_APPROVAL' },
    },
    actionItems: {
      1: { id: 1, group_type: OWN, group_id: 7 },
      2: { id: 2, group_type: OTHER, group_id: 8 },
    },
    // minutes / transcripts carry no group columns: ownership is inherited
    // from the meeting they hang off.
    minutes: {
      1: { id: 1, meeting_id: 1, group_type: OWN, group_id: 7 },
      2: { id: 2, meeting_id: 2, group_type: OTHER, group_id: 8 },
    },
    transcripts: {
      1: { id: 1, meeting_id: 1, group_type: OWN, group_id: 7 },
      2: { id: 2, meeting_id: 2, group_type: OTHER, group_id: 8 },
    },
    // Execution 1 agrees with its resolution (group 7 / group 7).
    // Execution 2 does NOT: it claims group 7 but its resolution is group 8.
    executions: {
      1: { id: 1, group_id: 7, resolution_id: 1 },
      2: { id: 2, group_id: 7, resolution_id: 2 },
    },
    // Grant 1 points at a foreign document, grant 2 at our own.
    accessGrants: {
      1: { id: 1, record_type: 'DOCUMENT', record_id: 2 },
      2: { id: 2, record_type: 'DOCUMENT', record_id: 1 },
    },
  },
};

const queryLog = [];
const writeLog = [];
const logRecords = [];
const vicobaCalls = [];

function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ');
  queryLog.push({ sql: s, params });
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(s)) writeLog.push({ sql: s, params });

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

  // --- governance ownership lookups (G2) -----------------------------------
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

  // --- financial writes ----------------------------------------------------
  if (/INSERT INTO governance_financial_executions/.test(s)) {
    return { rows: [{ id: 501, resolution_id: params[0], group_id: params[1], status: 'PENDING' }] };
  }
  if (/UPDATE governance_financial_executions SET status='EXECUTED'/.test(s)) {
    return { rows: [{ id: params[0], status: 'EXECUTED' }] };
  }
  if (/UPDATE governance_financial_executions SET status='FAILED'/.test(s)) {
    return { rows: [{ id: params[0], status: 'FAILED' }] };
  }
  if (/UPDATE governance_meetings/.test(s)) {
    return { rows: [{ id: params[1] !== undefined ? params[1] : params[0], status: params[0] }] };
  }
  if (/INSERT INTO governance_access_grants/.test(s)) {
    return { rows: [{ id: 701 }] };
  }
  if (/DELETE FROM governance_access_grants/.test(s)) {
    return { rows: [{ id: params[0] }] };
  }
  if (/INSERT INTO governance_votes/.test(s)) {
    return { rows: [{ id: 801 }] };
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
  connect: async () => {},
  end: () => {},
  on: () => {},
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
});
stubModule(require.resolve('../src/utils/logger'), loggerStub);
stubModule(require.resolve('../src/services/vicobaService'), {
  requestLoan: async (...args) => { vicobaCalls.push(['requestLoan', ...args]); return { id: 9001 }; },
  approveLoan: async (...args) => { vicobaCalls.push(['approveLoan', ...args]); return { ok: true }; },
});

const express = require('express');
const supertest = require('supertest');
const router = require('../src/routes/governanceRoutes');
const binding = require('../src/services/governanceResourceBindingService');
const gfl = require('../src/services/governanceFinancialLinkageService');
const { ERROR_CODES } = require('../src/utils/errorCodes');
const { signToken } = require('../src/middleware/auth');

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

function snap() { return { q: queryLog.length, w: writeLog.length, v: vicobaCalls.length }; }
function writtenSince(s) { return writeLog.slice(s.w); }
function queriesSince(s) { return queryLog.slice(s.q); }
function ranQuery(s, pattern) { return queriesSince(s).some((q) => pattern.test(q.sql)); }

async function main() {

// ---------------------------------------------------------------------------
// Part A — structural: the two matrices must be the same 43 routes
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
const authzKeys = router.ROUTE_AUTHZ.map(([m, p]) => `${m} ${p}`);
const resourceKeys = router.ROUTE_RESOURCES.map(([m, p]) => `${m} ${p}`);

eq('A1 routes declared in router', declared.length, 43);
eq('A2 entries in resource matrix', resourceKeys.length, 43);
eq('A3 every declared route has a resource entry',
  declared.filter((k) => !resourceKeys.includes(k)).length, 0);
eq('A4 every resource entry has a declared route',
  resourceKeys.filter((k) => !declared.includes(k)).length, 0);
eq('A5 resource matrix mirrors the capability matrix in the same order',
  JSON.stringify(resourceKeys), JSON.stringify(authzKeys));

ok('A6 binding layer is mounted immediately after the capability layer',
  router.stack.length > 2 && !router.stack[2].route && router.stack[2].handle.name === 'resourceBindingLayer',
  `got ${router.stack.map((l) => l.handle && l.handle.name).join(',')}`);
ok('A7 both guards sit before every route handler',
  router.stack.slice(0, 3).every((l) => !l.route));

eq('A8 GOV_RESOURCE_NOT_FOUND is 404', ERROR_CODES.GOV_RESOURCE_NOT_FOUND.status, 404);
eq('A9 GOV_RESOURCE_UNREGISTERED is 403', ERROR_CODES.GOV_RESOURCE_UNREGISTERED.status, 403);
eq('A10 GOV_EXECUTION_RESOLUTION_MISMATCH is 403', ERROR_CODES.GOV_EXECUTION_RESOLUTION_MISMATCH.status, 403);
ok('A11 wrong-group reason has no public error code (it cannot leak through the response body)',
  ERROR_CODES.GOV_RESOURCE_GROUP_MISMATCH === undefined);

// ---------------------------------------------------------------------------
// Part B — group family comparison (pure, no DB)
// ---------------------------------------------------------------------------

section('B. family + id comparison (strict, fail closed)');

const c = (groupType, groupId) => ({ groupType, groupId });
eq('B1 same family and id -> equal',
  binding.sameGroup(c('VICOBA', 7), c('VICOBA', 7)), true);
eq('B2 same family, different id -> not equal',
  binding.sameGroup(c('VICOBA', 7), c('VICOBA', 8)), false);
eq('B3 same id, different family -> not equal (VICOBA 8 vs SACCO 8)',
  binding.sameGroup(c('VICOBA', 8), c('SACCO', 8)), false);
eq('B4 SACCO / SACCOS are one family',
  binding.sameGroup(c('SACCOS', 5), c('SACCO', 5)), true);
eq('B5 lowercase storage normalises',
  binding.sameGroup(c('vicoba', 7), c('VICOBA', 7)), true);
eq('B6 unsupported family never equals a supported one',
  binding.sameGroup(c('COOPERATIVE', 7), c('VICOBA', 7)), false);
eq('B7 two unsupported families never equal each other (fail closed, not a wildcard)',
  binding.sameGroup(c('COOPERATIVE', 7), c('COOPERATIVE', 7)), false);
eq('B8 ALUMNI is unsupported',
  binding.familyOf('ALUMNI'), null);
eq('B9 aliases resolve', JSON.stringify(binding.familyAliases('SACCOS')), JSON.stringify(['SACCO', 'SACCOS']));
eq('B10 unsupported family has no SQL alias set (scope cannot be built)',
  binding.familyAliases('COOPERATIVE'), null);

// ---------------------------------------------------------------------------
// Part C — canonical ownership resolution
// ---------------------------------------------------------------------------

section('C. resolveResourceGroup / assertResourceInContext');

const CTX7 = { userId: 2, groupType: 'VICOBA', groupId: 7, capability: 'FINANCIAL', role: 'MWENYEKITI', allowed: true };
const CTX8 = { userId: 4, groupType: 'VICOBA', groupId: 8, capability: 'FINANCIAL', role: 'MWENYEKITI', allowed: true };

let err = await catchError(() => binding.assertResourceInContext('MEETING', 1, CTX7));
eq('C1 resource owned by the context -> allowed', err, null);

err = await catchError(() => binding.assertResourceInContext('MEETING', 2, CTX7));
eq('C2 resource owned by another group -> denied', err && err.code, 'GOV_RESOURCE_NOT_FOUND');
eq('C2a reason is recorded internally only', err && err.internalCode, 'GOV_RESOURCE_GROUP_MISMATCH');
eq('C2b status', err && err.statusCode, 404);

const missing = await catchError(() => binding.assertResourceInContext('MEETING', 9999, CTX7));
eq('C3 missing resource -> denied', missing && missing.code, 'GOV_RESOURCE_NOT_FOUND');
eq('C3a no internal reason for a plain miss', missing && missing.internalCode, undefined);
eq('C3b status', missing && missing.statusCode, 404);

eq('C4 missing and wrong-group are externally indistinguishable',
  JSON.stringify({ code: missing.code, status: missing.statusCode, message: missing.message }),
  JSON.stringify({ code: err.code, status: err.statusCode, message: err.message }));

err = await catchError(() => binding.assertResourceInContext('MEETING', 1, null));
eq('C5 no group context -> GOV_GROUP_REQUIRED', err && err.code, 'GOV_GROUP_REQUIRED');

const minutesOwn = await catchError(() => binding.assertResourceInContext('MINUTES', 1, CTX7));
eq('C6 minutes inherit ownership from their meeting (own)', minutesOwn, null);
const minutesForeign = await catchError(() => binding.assertResourceInContext('MINUTES', 2, CTX7));
eq('C6a minutes inherit ownership from their meeting (foreign)',
  minutesForeign && minutesForeign.code, 'GOV_RESOURCE_NOT_FOUND');

const transcriptForeign = await catchError(() => binding.assertResourceInContext('TRANSCRIPT', 2, CTX7));
eq('C7 transcripts inherit ownership too', transcriptForeign && transcriptForeign.code, 'GOV_RESOURCE_NOT_FOUND');

err = await catchError(() => binding.assertResourceInContext('WIDGET', 1, CTX7));
eq('C8 unknown resource type -> GOV_RESOURCE_UNREGISTERED (fail closed)',
  err && err.code, 'GOV_RESOURCE_UNREGISTERED');
eq('C8a status', err && err.statusCode, 403);

const docViaGrant = await catchError(() => binding.assertResourceInContext('RECORD', 2, CTX7, { recordType: 'DOCUMENT' }));
eq('C9 RECORD dispatch resolves the named record type (foreign doc)',
  docViaGrant && docViaGrant.code, 'GOV_RESOURCE_NOT_FOUND');
const docViaGrantOwn = await catchError(() => binding.assertResourceInContext('RECORD', 1, CTX7, { recordType: 'DOCUMENT' }));
eq('C9a own document binds', docViaGrantOwn, null);

err = await catchError(() => binding.assertResourceInContext('RECORD', 1, CTX7, { recordType: 'NOT_A_TYPE' }));
eq('C10 unknown record type resolves to nothing, not to a default',
  err && err.code, 'GOV_RESOURCE_NOT_FOUND');

const grantForeign = await catchError(() => binding.assertResourceInContext('ACCESS_GRANT', 1, CTX7));
eq('C11 access grant resolves through the record it points at',
  grantForeign && grantForeign.code, 'GOV_RESOURCE_NOT_FOUND');
const grantOwn = await catchError(() => binding.assertResourceInContext('ACCESS_GRANT', 2, CTX7));
eq('C11a grant pointing at our own record binds', grantOwn, null);

err = await catchError(() => binding.assertResourceInContext('EXECUTION', 1, CTX7));
eq('C12 execution whose group agrees with its resolution binds', err, null);
err = await catchError(() => binding.assertResourceInContext('EXECUTION', 2, CTX8));
eq('C13 execution disagreeing with its resolution -> integrity denial',
  err && err.code, 'GOV_EXECUTION_RESOLUTION_MISMATCH');
eq('C13a status', err && err.statusCode, 403);
eq('C13b reason recorded internally', err && err.internalCode, 'GOV_EXECUTION_RESOLUTION_MISMATCH');
err = await catchError(() => binding.assertResourceInContext('EXECUTION', 2, CTX7));
eq('C14 the same broken execution is a 404 for the wrong group, not a 403',
  err && err.code, 'GOV_RESOURCE_NOT_FOUND');

// ---------------------------------------------------------------------------
// Part D — one request, one group context
// ---------------------------------------------------------------------------

section('D. client group context cannot override the validated context');

eq('D1 consistent claims pass', (() => {
  binding.assertRequestGroupConsistent(CTX7, { body: { group_id: 7 }, query: { group_id: 7 } });
  return null;
})(), null);

err = await catchError(() => binding.assertRequestGroupConsistent(CTX7, { body: { group_id: 7 }, query: { group_id: 8 } }));
eq('D2 a second, different group id in the same request -> denied',
  err && err.code, 'GOV_RESOURCE_NOT_FOUND');
eq('D2a reason recorded internally', err && err.internalCode, 'GOV_CONTEXT_GROUP_MISMATCH');
eq('D2b status (indistinguishable from a missing resource)', err && err.statusCode, 404);

err = await catchError(() => binding.assertRequestGroupConsistent(CTX7, { body: { group_id: 7, group_type: 'VICOBA' }, query: { group_id: 7, group_type: 'SACCO' } }));
eq('D3 a conflicting group family -> denied', err && err.internalCode, 'GOV_CONTEXT_GROUP_TYPE_MISMATCH');

err = await catchError(() => binding.assertRequestGroupConsistent(CTX7, { body: { group_id: 7, group_type: 'COOPERATIVE' } }));
eq('D4 an unsupported family claim -> denied', err && err.internalCode, 'GOV_CONTEXT_GROUP_TYPE_MISMATCH');

err = await catchError(() => binding.assertRequestGroupConsistent(null, { body: { group_id: 7 } }));
eq('D5 no validated context -> GOV_GROUP_REQUIRED', err && err.code, 'GOV_GROUP_REQUIRED');

// ---------------------------------------------------------------------------
// Part E — HTTP: denial happens before the handler, over a real stack
// ---------------------------------------------------------------------------

section('E. HTTP — binding runs before the handler (real Express + supertest)');

const app = express();
app.use(express.json());
app.use('/api/governance', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({
  success: false, code: err.code || 'INTERNAL_ERROR', message: err.message,
}));

const token7 = signToken(FIX.users[2]);
const token8 = signToken(FIX.users[4]);

async function call(method, url, { token, body } = {}) {
  let req = supertest(app)[method.toLowerCase()](url);
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body);
  return req;
}

// E1 — foreign meeting: denied, and the handler's own queries never ran.
let s = snap();
let r = await call('GET', '/api/governance/meetings/2?group_id=7', { token: token7 });
eq('E1 cross-group read -> 404', r.status, 404);
eq('E1a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');
ok('E1b handler never ran (no attendee query)', !ranQuery(s, /governance_attendees/));

// E2 — our own meeting: the same route, same shape, binds.
s = snap();
r = await call('GET', '/api/governance/meetings/1?group_id=7', { token: token7 });
ok('E2 own-group read is not rejected by binding',
  !(r.status === 404 && r.body.code === 'GOV_RESOURCE_NOT_FOUND'),
  `status=${r.status} code=${r.body.code} error=${r.body.error}`);
ok('E2a handler ran', ranQuery(s, /governance_attendees/));

// E3 — cross-group mutation: refused, and nothing was written.
s = snap();
r = await call('POST', '/api/governance/meetings/2/status?group_id=7', { token: token7, body: { status: 'COMPLETED' } });
eq('E3 cross-group mutation -> 404', r.status, 404);
eq('E3a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');
eq('E3b no write performed', writtenSince(s).length, 0);

// E4 — own-group mutation reaches the handler and does write.
s = snap();
r = await call('POST', '/api/governance/meetings/1/status?group_id=7', { token: token7, body: { status: 'COMPLETED' } });
ok('E4 own-group mutation reaches the handler', writtenSince(s).length > 0,
  `writes=${writtenSince(s).length} status=${r.status} code=${r.body.code}`);

// E5 — a grant pointing at a foreign record is refused through the grant.
s = snap();
r = await call('DELETE', '/api/governance/access-grants/1?group_id=7', { token: token7 });
eq('E5 delete grant over a foreign record -> 404', r.status, 404);
eq('E5a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');
eq('E5b no write performed', writtenSince(s).length, 0);

// E6 — a grant pointing at our own record proceeds.
s = snap();
r = await call('DELETE', '/api/governance/access-grants/2?group_id=7', { token: token7 });
ok('E6 delete grant over our own record proceeds', writtenSince(s).length > 0,
  `writes=${writtenSince(s).length} status=${r.status} code=${r.body.code}`);

// E7/E8 — voting on a foreign proposal.
s = snap();
r = await call('POST', '/api/governance/proposals/2/vote?group_id=7', { token: token7, body: { choice: 'YES' } });
eq('E7 cross-group vote -> 404', r.status, 404);
eq('E7a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');
ok('E7b no vote row written', !ranQuery(s, /INSERT INTO governance_votes/));

s = snap();
r = await call('POST', '/api/governance/proposals/1/vote?group_id=7', { token: token7, body: { choice: 'YES' } });
ok('E8 own-group vote passes binding',
  !(r.status === 404 && r.body.code === 'GOV_RESOURCE_NOT_FOUND'),
  `status=${r.status} code=${r.body.code}`);

// E9/E10 — can-view is a read of a named record, so it must bind too.
s = snap();
// canView's own role lookup (no spaces around `=`, unlike G1's member query),
// so only the handler reaching canView produces it.
const handlerRan = /role_in_group FROM vicoba_members WHERE group_id=\$1 AND user_id=\$2/;
r = await call('POST', '/api/governance/can-view', { token: token7, body: { group_id: 7, record_type: 'DOCUMENT', record_id: 2, confidential: true } });
eq('E9 can-view on a foreign record -> 404', r.status, 404);
eq('E9a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');
ok('E9b handler never ran', !ranQuery(s, handlerRan));

s = snap();
r = await call('POST', '/api/governance/can-view', { token: token7, body: { group_id: 7, record_type: 'DOCUMENT', record_id: 1, confidential: true } });
ok('E10 can-view on our own record passes binding', ranQuery(s, handlerRan),
  `status=${r.status} code=${r.body && r.body.code}`);

r = await call('POST', '/api/governance/can-view', { token: token7, body: { group_id: 7, record_id: 1 } });
eq('E11 id without the kind that says what it is -> denied', r.status, 404);
eq('E11a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');

// E12/E13 — financial execution creation, with a deliberately wrong client
// groupId on the matching case to prove the stored group is canonical.
s = snap();
r = await call('POST', '/api/governance/financial-executions', {
  token: token7, body: { group_id: 7, resolutionId: 2, financialActionType: 'GENERAL', amount: 500 },
});
eq('E12 execution against a foreign resolution -> 404', r.status, 404);
eq('E12a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');
eq('E12b no execution row written', writtenSince(s).length, 0);

s = snap();
// The route handler forwards the body straight to the service, which reads
// camelCase keys (the contract the frontend uses). The binding descriptor
// accepts either spelling, so a snake-only body would bind and then fail
// inside the service - the pre-existing contract, unchanged by G2.
r = await call('POST', '/api/governance/financial-executions', {
  token: token7, body: { group_id: 7, group_type: 'VICOBA', resolutionId: 1, financialActionType: 'GENERAL', amount: 500 },
});
const insert = writtenSince(s).find((q) => /INSERT INTO governance_financial_executions/.test(q.sql));
ok('E13 execution against our own resolution is written', !!insert,
  `status=${r.status} code=${r.body && r.body.code}`);
ok('E13a the stored group is the resolution canonical group, not a client value',
  !!insert && Number(insert.params[1]) === 7, insert ? JSON.stringify(insert.params) : 'no insert');

// E14/E15 — a conflicting group claim anywhere in the request.
s = snap();
r = await call('GET', '/api/governance/meetings?group_id=8', { token: token7, body: { group_id: 7 } });
eq('E14 a second group id in the query -> 404', r.status, 404);
eq('E14a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');
ok('E14b handler never ran', !ranQuery(s, /governance_meetings/));

r = await call('GET', '/api/governance/meetings?group_id=7&group_type=SACCO',
  { token: token7, body: { group_id: 7, group_type: 'VICOBA' } });
eq('E15 a second group family in the query -> 404', r.status, 404);
eq('E15a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');

// E16/E17 — both fail-closed arms of the binding table.
const entryIndex = router.ROUTE_RESOURCES.findIndex(([m, p]) => m === 'GET' && p === '/meetings/:id');
const savedEntry = router.ROUTE_RESOURCES[entryIndex];
router.ROUTE_RESOURCES.splice(entryIndex, 1);
r = await call('GET', '/api/governance/meetings/1?group_id=7', { token: token7 });
eq('E16 a route dropped from the binding table -> 403', r.status, 403);
eq('E16a code', r.body.code, 'GOV_RESOURCE_UNREGISTERED');
router.ROUTE_RESOURCES.splice(entryIndex, 0, savedEntry);

router.ROUTE_RESOURCES[entryIndex] = ['GET', '/meetings/:id', [{ from: 'path', keys: ['id'], type: 'WIDGET' }]];
r = await call('GET', '/api/governance/meetings/1?group_id=7', { token: token7 });
eq('E17 a descriptor naming an unknown resource kind -> 403', r.status, 403);
eq('E17a code', r.body.code, 'GOV_RESOURCE_UNREGISTERED');
router.ROUTE_RESOURCES[entryIndex] = savedEntry;
eq('E17b matrix restored', router.ROUTE_RESOURCES[entryIndex][1], '/meetings/:id');

// E18/E19 — execution integrity, both from the inside and from outside.
s = snap();
r = await call('POST', '/api/governance/financial-executions/2/executed?group_id=8',
  { token: token8, body: { ledger_reference: 'L-9' } });
eq('E18 execution that disagrees with its resolution -> 403', r.status, 403);
eq('E18a code', r.body.code, 'GOV_EXECUTION_RESOLUTION_MISMATCH');
eq('E18b no write performed', writtenSince(s).length, 0);

s = snap();
r = await call('POST', '/api/governance/financial-executions/2/executed?group_id=7',
  { token: token7, body: { ledger_reference: 'L-9' } });
eq('E19 the same execution from the wrong group -> 404, not 403', r.status, 404);
eq('E19a code', r.body.code, 'GOV_RESOURCE_NOT_FOUND');
eq('E19b no write performed', writtenSince(s).length, 0);

s = snap();
r = await call('POST', '/api/governance/financial-executions/1/executed?group_id=7',
  { token: token7, body: { ledger_reference: 'L-1' } });
ok('E20 a consistent execution is written', writtenSince(s).some((q) => /UPDATE governance_financial_executions SET status='EXECUTED'/.test(q.sql)),
  `status=${r.status} code=${r.body && r.body.code}`);

// E21/E22 — the two list reads that used to filter on group id alone.
s = snap();
await call('GET', '/api/governance/financial-executions?group_id=7', { token: token7 });
ok('E21 execution listing is scoped by group family as well as id',
  ranQuery(s, /UPPER\(TRIM\(r\.group_type\)\)=ANY/));

s = snap();
await call('GET', '/api/governance/financial/audit-trail?group_id=7', { token: token7 });
ok('E22 audit trail is scoped by group family as well as id',
  ranQuery(s, /UPPER\(TRIM\(r\.group_type\)\)=ANY/));

// ---------------------------------------------------------------------------
// Part F — defense in depth: the financial service refuses on its own
//
// These call the service directly, with no router in front of it, which is the
// case decision D4 exists for.
// ---------------------------------------------------------------------------

section('F. financial service defense in depth (no HTTP layer in front)');

s = snap();
err = await catchError(() => gfl.createExecution({
  resolutionId: 2, groupId: 7, financialActionType: 'GENERAL', amount: 100, governance: CTX7,
}));
eq('F1 createExecution on a foreign resolution -> denied', err && err.code, 'GOV_RESOURCE_NOT_FOUND');
eq('F1a no INSERT performed', writtenSince(s).length, 0);

s = snap();
err = await catchError(() => gfl.createExecution({
  resolutionId: 1, groupId: 999, financialActionType: 'GENERAL', amount: 100, governance: CTX7,
}));
eq('F2 createExecution on our own resolution succeeds', err, null);
const insert2 = writtenSince(s).find((q) => /INSERT INTO governance_financial_executions/.test(q.sql));
ok('F2a the client groupId was ignored in favour of the canonical one',
  !!insert2 && Number(insert2.params[1]) === 7, insert2 ? JSON.stringify(insert2.params) : 'no insert');

s = snap();
err = await catchError(() => gfl.createExecution({
  resolutionId: 1, financialActionType: 'GENERAL', amount: 100,
}));
eq('F3 createExecution with no group context -> GOV_GROUP_REQUIRED', err && err.code, 'GOV_GROUP_REQUIRED');
eq('F3a no INSERT performed', writtenSince(s).length, 0);

s = snap();
err = await catchError(() => gfl.markExecuted(2, { ledgerReference: 'L', governance: CTX8 }));
eq('F4 markExecuted on an execution that disagrees with its resolution -> 403',
  err && err.code, 'GOV_EXECUTION_RESOLUTION_MISMATCH');
eq('F4a no UPDATE performed', writtenSince(s).length, 0);

s = snap();
err = await catchError(() => gfl.markExecuted(2, { ledgerReference: 'L', governance: CTX7 }));
eq('F5 markExecuted from the wrong group -> 404', err && err.code, 'GOV_RESOURCE_NOT_FOUND');
eq('F5a no UPDATE performed', writtenSince(s).length, 0);

s = snap();
err = await catchError(() => gfl.markFailed(2, 'notes', CTX8));
eq('F6 markFailed on a broken execution -> 403', err && err.code, 'GOV_EXECUTION_RESOLUTION_MISMATCH');
eq('F6a no UPDATE performed', writtenSince(s).length, 0);

s = snap();
err = await catchError(() => gfl.markExecuted(1, { ledgerReference: 'L', governance: CTX7 }));
eq('F7 markExecuted on a consistent execution succeeds', err, null);
ok('F7a UPDATE performed', writtenSince(s).some((q) => /UPDATE governance_financial_executions/.test(q.sql)));

s = snap();
err = await catchError(() => gfl.triggerVicobaLoan({
  actorUserId: 2, resolutionId: 2, groupId: 7, applicantUserId: 1, amount: 1000, governance: CTX7,
}));
eq('F8 triggerVicobaLoan on a foreign resolution -> denied', err && err.code, 'GOV_RESOURCE_NOT_FOUND');
eq('F8a no execution row written', writtenSince(s).length, 0);
eq('F8b vicoba.requestLoan never called', vicobaCalls.filter((c2) => c2[0] === 'requestLoan').length, 0);
eq('F8c vicoba.approveLoan never called', vicobaCalls.filter((c2) => c2[0] === 'approveLoan').length, 0);

s = snap();
err = await catchError(() => gfl.triggerVicobaLoan({
  actorUserId: 2, resolutionId: 2, groupId: 7, applicantUserId: 1, amount: 1000,
}));
eq('F9 triggerVicobaLoan with no group context -> GOV_GROUP_REQUIRED', err && err.code, 'GOV_GROUP_REQUIRED');
eq('F9a no writes', writtenSince(s).length, 0);
eq('F9b vicoba never called', vicobaCalls.length, 0);

s = snap();
err = await catchError(() => gfl.listExecutions({ governance: null }));
eq('F10 listExecutions without a group context -> GOV_GROUP_REQUIRED', err && err.code, 'GOV_GROUP_REQUIRED');
err = await catchError(() => gfl.getGovernanceAuditTrail(null));
eq('F11 getGovernanceAuditTrail without a group context -> GOV_GROUP_REQUIRED', err && err.code, 'GOV_GROUP_REQUIRED');
err = await catchError(() => gfl.listExecutions({ governance: { groupType: 'COOPERATIVE', groupId: 7 } }));
eq('F12 an unsupported family cannot build a read scope', err && err.code, 'GOV_GROUP_TYPE_UNSUPPORTED');

// ---------------------------------------------------------------------------
// Part G — negative controls (none of these guards are vacuous)
// ---------------------------------------------------------------------------

section('G. negative controls');

ok('G1 binding actually looked resources up',
  queryLog.some((q) => /FROM governance_meetings WHERE id/.test(q.sql)));
ok('G2 binding resolved access grants through their record',
  queryLog.some((q) => /FROM governance_access_grants WHERE id/.test(q.sql)));
ok('G3 binding resolved executions through their resolution',
  queryLog.some((q) => /FROM governance_financial_executions WHERE id/.test(q.sql)));
ok('G4 minutes were resolved through their meeting',
  queryLog.some((q) => /FROM governance_minutes c JOIN/.test(q.sql)));
ok('G5 denials are logged with the real reason for operators',
  logRecords.some((l) => l[0] === 'warn' && l[1] === 'GOV_BIND_DENIED'));
ok('G6 no test accidentally reached an unbound write',
  writeLog.every((q) => !/UPDATE governance_resolutions SET group_id/.test(q.sql)));

const positive = await catchError(() => binding.assertResourceInContext('MEETING', 1, CTX7));
ok('G7 positive control: the suite is not all-denies', positive === null);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`G2 resource binding: ${pass} passed, ${failures.length} failed`);
if (failures.length) failures.forEach((f) => console.log(`  FAILED: ${f}`));
console.log(`${'-'.repeat(60)}`);
process.exit(failures.length ? 1 : 0);

}

main().catch((err) => {
  console.error('G2 test runner crashed:', err);
  process.exit(1);
});
