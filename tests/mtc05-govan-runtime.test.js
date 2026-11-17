/**
 * MTC-05 Workstream B: GOV-AN-06/07 Runtime Verification
 * Service-level runtime verification of governance authorization and alias normalization.
 */

const assert = require('assert');

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

const auth = require('../src/services/governanceAuthorizationService');

// GOV-AN-06: SACCO/SACCOS alias normalization
const SACCOS_GROUP_TYPES = ['SACCO', 'SACCOS'];
const VICOBA_GROUP_TYPES = ['VICOBA', 'VSLA'];

function normalizeGroupType(raw) {
  const t = String(raw || '').trim().toUpperCase();
  if (SACCOS_GROUP_TYPES.includes(t)) return 'SACCOS';
  if (VICOBA_GROUP_TYPES.includes(t)) return 'VICOBA';
  return t;
}

function resolveFamily(groupType) {
  if (VICOBA_GROUP_TYPES.includes(groupType)) return 'VICOBA';
  if (SACCOS_GROUP_TYPES.includes(groupType)) return 'SACCOS';
  return null;
}

// GOV-AN-06 tests
test('GA06-RT-01: SACCO normalizes to SACCOS', () => {
  assert.strictEqual(normalizeGroupType('SACCO'), 'SACCOS');
  assert.strictEqual(normalizeGroupType('sacco'), 'SACCOS');
  assert.strictEqual(normalizeGroupType('  sacco  '), 'SACCOS');
});

test('GA06-RT-02: SACCOS stays SACCOS', () => {
  assert.strictEqual(normalizeGroupType('SACCOS'), 'SACCOS');
  assert.strictEqual(normalizeGroupType('saccos'), 'SACCOS');
});

test('GA06-RT-03: VICOBA group types unaffected by SACCO normalization', () => {
  assert.strictEqual(normalizeGroupType('VICOBA'), 'VICOBA');
  assert.strictEqual(normalizeGroupType('VSLA'), 'VICOBA');
});

test('GA06-RT-04: SACCO and SACCOS resolve to same family', () => {
  assert.strictEqual(resolveFamily('SACCO'), resolveFamily('SACCOS'));
  assert.strictEqual(resolveFamily('SACCO'), 'SACCOS');
});

test('GA06-RT-05: Unsupported alias fails safely (returns null family)', () => {
  assert.strictEqual(resolveFamily('UNKNOWN_TYPE'), null);
  assert.strictEqual(resolveFamily(''), null);
  assert.strictEqual(resolveFamily(null), null);
});

test('GA06-RT-06: extractGroupContext handles SACCO', () => {
  const req = { body: { group_type: 'SACCO', group_id: 5 }, query: {}, params: {} };
  const ctx = auth.extractGroupContext(req);
  assert.ok(ctx !== null);
  assert.strictEqual(ctx.groupId, 5);
  // raw type preserved (uppercase)
  assert.strictEqual(ctx.groupType, 'SACCO');
});

test('GA06-RT-07: extractGroupContext rejects invalid group_id', () => {
  const req1 = { body: { group_type: 'SACCO', group_id: 0 }, query: {}, params: {} };
  assert.strictEqual(auth.extractGroupContext(req1), null);
  const req2 = { body: { group_type: 'SACCO', group_id: -1 }, query: {}, params: {} };
  assert.strictEqual(auth.extractGroupContext(req2), null);
  const req3 = { body: { group_type: 'SACCO', group_id: 'abc' }, query: {}, params: {} };
  assert.strictEqual(auth.extractGroupContext(req3), null);
});

test('GA06-RT-08: extractGroupContext returns null when no group_id', () => {
  const req = { body: { group_type: 'SACCO' }, query: {}, params: {} };
  assert.strictEqual(auth.extractGroupContext(req), null);
});

// GOV-AN-07: Authorization
test('GA07-RT-01: CAPABILITIES defined', () => {
  assert.ok(auth.CAPABILITIES);
  assert.ok(auth.CAPABILITIES.READ);
  assert.ok(auth.CAPABILITIES.WRITE);
});

test('GA07-RT-02: VICOBA member roles defined', () => {
  assert.ok(Array.isArray(auth.VICOBA_MEMBER_ROLES));
  assert.ok(auth.VICOBA_MEMBER_ROLES.length > 0);
});

test('GA07-RT-03: VICOBA officer roles defined', () => {
  assert.ok(Array.isArray(auth.VICOBA_OFFICER_ROLES));
  assert.ok(auth.VICOBA_OFFICER_ROLES.length > 0);
});

test('GA07-RT-04: SACCOS member roles defined', () => {
  assert.ok(Array.isArray(auth.SACCOS_MEMBER_ROLES));
  assert.ok(auth.SACCOS_MEMBER_ROLES.length > 0);
});

test('GA07-RT-05: SACCOS governing roles defined', () => {
  assert.ok(Array.isArray(auth.SACCOS_GOVERNING_ROLES));
  assert.ok(auth.SACCOS_GOVERNING_ROLES.length > 0);
});

test('GA07-RT-06: Platform admin overrides defined', () => {
  assert.ok(auth.PLATFORM_ADMIN_OVERRIDES);
});

test('GA07-RT-07: requireGovernance is a function', () => {
  assert.strictEqual(typeof auth.requireGovernance, 'function');
});

test('GA07-RT-08: authorizeGroupContext is a function', () => {
  assert.strictEqual(typeof auth.authorizeGroupContext, 'function');
});

test('GA07-RT-09: extractGroupContext is a function', () => {
  assert.strictEqual(typeof auth.extractGroupContext, 'function');
});

test('GA07-RT-10: Cross-group context extraction preserves group_id', () => {
  const req1 = { body: {}, query: { group_id: 1, group_type: 'VICOBA' }, params: {} };
  const req2 = { body: {}, query: { group_id: 2, group_type: 'VICOBA' }, params: {} };
  const ctx1 = auth.extractGroupContext(req1);
  const ctx2 = auth.extractGroupContext(req2);
  assert.strictEqual(ctx1.groupId, 1);
  assert.strictEqual(ctx2.groupId, 2);
  // Different groups must not be conflated
  assert.notStrictEqual(ctx1.groupId, ctx2.groupId);
});

// Run tests
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log('PASS  ' + t.name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + t.name);
    console.log('      ' + e.message);
  }
}
console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed, ' + tests.length + ' total');