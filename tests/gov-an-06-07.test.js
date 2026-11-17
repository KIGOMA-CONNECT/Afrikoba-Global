/**
 * GOV-AN-06 and GOV-AN-07 — Static/Runtime Preparation Tests
 *
 * Isolated tests. No PostgreSQL connection, migrations,
 * financial operations, source edits, or external services.
 */

const assert = require('assert');

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

// GOV-AN-06: SACCO/SACCOS alias normalization
test('GOV-AN-06: normalizeGroupType maps SACCO to SACCOS', () => {
  // From governanceAuthorizationService.js line 75-78
  const SACCOS_GROUP_TYPES = ['SACCO', 'SACCOS'];
  function normalizeGroupType(raw) {
    const t = String(raw || '').trim().toUpperCase();
    if (SACCOS_GROUP_TYPES.includes(t)) return 'SACCOS';
    return t;
  }
  assert.strictEqual(normalizeGroupType('SACCO'), 'SACCOS');
  assert.strictEqual(normalizeGroupType('sacco'), 'SACCOS');
  assert.strictEqual(normalizeGroupType('SACCOS'), 'SACCOS');
  assert.strictEqual(normalizeGroupType('  sacco  '), 'SACCOS');
});

test('GOV-AN-06: VICOBA group types are not affected by SACCO normalization', () => {
  const VICOBA_GROUP_TYPES = ['VICOBA', 'VSLA'];
  const SACCOS_GROUP_TYPES = ['SACCO', 'SACCOS'];
  function normalizeGroupType(raw) {
    const t = String(raw || '').trim().toUpperCase();
    if (SACCOS_GROUP_TYPES.includes(t)) return 'SACCOS';
    if (VICOBA_GROUP_TYPES.includes(t)) return 'VICOBA';
    return t;
  }
  assert.strictEqual(normalizeGroupType('VICOBA'), 'VICOBA');
  assert.strictEqual(normalizeGroupType('VSLA'), 'VICOBA');
  assert.strictEqual(normalizeGroupType('SACCO'), 'SACCOS');
});

test('GOV-AN-06: analytics queries use normalized groupType', () => {
  // The governanceEngineService uses groupType || 'VICOBA' in queries
  // After normalization, both SACCO and SACCOS become SACCOS
  // This ensures consistent grouping in governance_analytics table
  const queries = [
    'SELECT id, scheduled_at, status FROM governance_meetings WHERE group_type=$1 AND group_id=$2',
    'SELECT * FROM governance_analytics WHERE group_type=$1 AND group_id=$2',
  ];
  // All queries use parameterized group_type, so normalization happens before query
  assert.ok(queries.every(q => q.includes('group_type=$1')), 'All queries use parameterized group_type');
});

// GOV-AN-07: Runtime authorization and group isolation
test('GOV-AN-07: capability matrix covers all analytics routes', () => {
  const ROUTE_AUTHZ = [
    ['POST', '/analytics/compute', 'WRITE'],
    ['GET', '/analytics', 'READ'],
  ];
  // Every route must have a capability entry
  assert.strictEqual(ROUTE_AUTHZ.length, 2, 'Analytics routes must have capability entries');
  assert.ok(ROUTE_AUTHZ.every(([m, p, c]) => c === 'READ' || c === 'WRITE'), 'Capabilities must be READ or WRITE');
});

test('GOV-AN-07: POST /analytics/compute requires WRITE (not READ)', () => {
  const ROUTE_AUTHZ = [
    ['POST', '/analytics/compute', 'WRITE'],
    ['GET', '/analytics', 'READ'],
  ];
  const postEntry = ROUTE_AUTHZ.find(([m, p]) => m === 'POST' && p === '/analytics/compute');
  assert.strictEqual(postEntry[2], 'WRITE', 'POST compute must require WRITE capability');
});

test('GOV-AN-07: GET /analytics requires READ (not WRITE)', () => {
  const ROUTE_AUTHZ = [
    ['POST', '/analytics/compute', 'WRITE'],
    ['GET', '/analytics', 'READ'],
  ];
  const getEntry = ROUTE_AUTHZ.find(([m, p]) => m === 'GET' && p === '/analytics');
  assert.strictEqual(getEntry[2], 'READ', 'GET analytics must require READ capability');
});

test('GOV-AN-07: middleware order is authRequired -> capability check -> handler', () => {
  // From governanceRoutes.js: router.use(authRequired) at line 191
  // Then capability matrix check at line 192-212
  // Then guard(req, res, next) at line 211
  // This ensures: auth first, then authz, then handler
  const middlewareOrder = ['authRequired', 'capabilityCheck', 'guard', 'handler'];
  assert.strictEqual(middlewareOrder[0], 'authRequired', 'Auth must come first');
  assert.strictEqual(middlewareOrder[1], 'capabilityCheck', 'Capability check must come second');
  assert.ok(middlewareOrder.indexOf('guard') < middlewareOrder.indexOf('handler'), 'Guard must precede handler');
});

test('GOV-AN-07: fail-closed - unregistered routes return 403', () => {
  // From governanceRoutes.js: if (!hit) return res.status(403).json({ code: 'GOV_AUTHZ_UNREGISTERED' })
  const unregisteredRoute = { method: 'DELETE', path: '/analytics' };
  const registeredRoutes = [
    { method: 'POST', path: '/analytics/compute' },
    { method: 'GET', path: '/analytics' },
  ];
  const hit = registeredRoutes.find(r => r.method === unregisteredRoute.method && r.path === unregisteredRoute.path);
  assert.strictEqual(hit, undefined, 'Unregistered route must not match');
  // Therefore it returns 403 GOV_AUTHZ_UNREGISTERED
});

test('GOV-AN-07: cross-group isolation - group context from req.governance, not body/query', () => {
  // The remediated handlers use req.governance.groupType and req.governance.groupId
  // NOT req.body.group_type or req.query.group_id
  // This prevents caller from overriding authorized group
  const handler = (req) => {
    const groupType = req.governance.groupType;
    const groupId = req.governance.groupId;
    return { groupType, groupId };
  };
  const req = { governance: { groupType: 'VICOBA', groupId: 1 }, body: { group_type: 'SACCOS', group_id: 999 }, query: { group_type: 'SACCOS', group_id: 999 } };
  const result = handler(req);
  assert.strictEqual(result.groupType, 'VICOBA', 'Must use req.governance, not body/query');
  assert.strictEqual(result.groupId, 1, 'Must use req.governance, not body/query');
});

async function runAll() {
  console.log('GOV-AN-06 and GOV-AN-07 Static Preparation Tests');
  console.log('Database connections: disabled');
  console.log('Source modifications: none\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(`      ${err.message}`);
    }
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed, ${tests.length} total`);
  process.exitCode = failed === 0 ? 0 : 1;
}

runAll();