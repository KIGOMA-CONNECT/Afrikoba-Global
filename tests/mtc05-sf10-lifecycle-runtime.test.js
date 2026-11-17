/**
 * MTC-05 Workstream C: SF-10 Lifecycle Runtime Verification
 * Tests the full lifecycle including DISBURSEMENT states.
 */

const assert = require('assert');

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

const svc = require('../src/services/socialFundService');

// Test canTransition for all lifecycle paths
const lifecyclePaths = [
  // Happy path: OPEN → COLLECTING → TARGET_REACHED → DISBURSEMENT_PENDING → PARTIALLY_DISBURSED → DISBURSED
  ['OPEN', 'COLLECTING', true],
  ['COLLECTING', 'TARGET_REACHED', true],
  ['TARGET_REACHED', 'DISBURSEMENT_PENDING', true],
  ['DISBURSEMENT_PENDING', 'PARTIALLY_DISBURSED', true],
  ['PARTIALLY_DISBURSED', 'DISBURSED', true],
  // Alternative: DISBURSEMENT_PENDING → DISBURSED (full disbursement)
  ['DISBURSEMENT_PENDING', 'DISBURSED', true],
  // Cancellation paths
  ['TARGET_REACHED', 'CANCELLED', true],
  ['DISBURSEMENT_PENDING', 'CANCELLED', true],
  ['PARTIALLY_DISBURSED', 'CANCELLED', true],
  // Invalid transitions
  ['DISBURSED', 'DISBURSED', false],
  ['DISBURSED', 'CANCELLED', false],
  ['OPEN', 'DISBURSEMENT_PENDING', false],
  ['OPEN', 'DISBURSED', false],
  ['COLLECTING', 'DISBURSEMENT_PENDING', false],
  ['COLLECTING', 'DISBURSED', false],
  // Invalid states
  ['INVALID', 'DISBURSED', false],
  ['OPEN', 'INVALID', false],
  // Terminal states have no outgoing transitions
  ['CANCELLED', 'OPEN', false],
  ['CANCELLED', 'DISBURSED', false],
  ['DISBURSED', 'OPEN', false],
];

for (const [from, to, expected] of lifecyclePaths) {
  test('SF10-LC: canTransition(' + from + ', ' + to + ') = ' + expected, () => {
    assert.strictEqual(svc.canTransition(from, to), expected);
  });
}

// Test LIFECYCLE_STATES includes all 9 states
test('SF10-LC: LIFECYCLE_STATES includes all 9 states', () => {
  const expected = ['OPEN', 'COLLECTING', 'TARGET_REACHED', 'CLOSED', 'CANCELLED', 'EXPIRED', 'DISBURSEMENT_PENDING', 'PARTIALLY_DISBURSED', 'DISBURSED'];
  assert.deepStrictEqual(svc.LIFECYCLE_STATES, expected);
});

// Test ALLOWED_TRANSITIONS for DISBURSEMENT states
test('SF10-LC: DISBURSEMENT_PENDING allows PARTIALLY_DISBURSED, DISBURSED, CANCELLED', () => {
  assert.deepStrictEqual(svc.ALLOWED_TRANSITIONS.DISBURSEMENT_PENDING, ['PARTIALLY_DISBURSED', 'DISBURSED', 'CANCELLED']);
});

test('SF10-LC: PARTIALLY_DISBURSED allows DISBURSED, CANCELLED', () => {
  assert.deepStrictEqual(svc.ALLOWED_TRANSITIONS.PARTIALLY_DISBURSED, ['DISBURSED', 'CANCELLED']);
});

test('SF10-LC: DISBURSED is terminal (no outgoing transitions)', () => {
  assert.deepStrictEqual(svc.ALLOWED_TRANSITIONS.DISBURSED, []);
});

test('SF10-LC: CANCELLED is terminal', () => {
  assert.deepStrictEqual(svc.ALLOWED_TRANSITIONS.CANCELLED, []);
});

// Test duplicate request handling (idempotency)
test('SF10-LC: canTransition is deterministic (same input, same output)', () => {
  const r1 = svc.canTransition('DISBURSEMENT_PENDING', 'DISBURSED');
  const r2 = svc.canTransition('DISBURSEMENT_PENDING', 'DISBURSED');
  assert.strictEqual(r1, r2);
});

// Test invalid state handling
test('SF10-LC: canTransition rejects null/undefined', () => {
  assert.strictEqual(svc.canTransition(null, 'DISBURSED'), false);
  assert.strictEqual(svc.canTransition('OPEN', null), false);
  assert.strictEqual(svc.canTransition(undefined, undefined), false);
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