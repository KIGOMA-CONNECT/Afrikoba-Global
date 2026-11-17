/**
 * GSF SF-10 Lifecycle Transition Tests
 *
 * Isolated service tests. No PostgreSQL connection, migrations,
 * financial operations, source edits, or external services.
 */

const assert = require('assert');

const tests = [];
let passed = 0;
let failed = 0;
let queryHandler = async () => ({ rows: [] });
const queryLog = [];

function test(name, fn) {
  tests.push({ name, fn });
}

const poolMock = {
  query: async (sql, params = []) => {
    queryLog.push({ sql, params });
    return queryHandler(sql, params);
  },
  connect: async () => ({
    query: async (sql, params = []) => {
      queryLog.push({ sql, params });
      return queryHandler(sql, params);
    },
    release: () => {},
  }),
};

function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

mockModule('../src/config/db', poolMock);
mockModule('../src/services/financialEngine', {});
mockModule('../src/utils/helpers', { generateReference: () => 'GSF-TEST-REF' });
mockModule('../src/utils/strictAmount', { strictAmount: (v) => Number(v) });
mockModule('../src/services/auditService', { writeAudit: async () => {}, logAction: async () => {} });

const socialFund = require('../src/services/socialFundService');

function resetQueries(handler) {
  queryLog.length = 0;
  queryHandler = handler;
}

// Test 1: changeCaseStatus validates lifecycle states
test('SF-10: changeCaseStatus rejects invalid status', async () => {
  resetQueries(async () => ({ rows: [] }));

  await assert.rejects(
    () => socialFund.changeCaseStatus(1, 7, 'INVALID_STATE'),
    (err) => err.code === 'INVALID_STATUS'
  );
});

// Test 2: changeCaseStatus requires initiator ownership
test('SF-10: changeCaseStatus rejects non-initiator', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT * FROM social_fund_cases WHERE id')) {
      return { rows: [{ id: 1, initiator_id: 7, status: 'OPEN' }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => socialFund.changeCaseStatus(1, 99, 'CLOSED'),
    (err) => err.code === 'ACCESS_DENIED' && err.statusCode === 403
  );
});

// Test 3: changeCaseStatus validates transitions
test('SF-10: changeCaseStatus rejects invalid transition (OPEN -> DISBURSED)', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT * FROM social_fund_cases WHERE id')) {
      return { rows: [{ id: 1, initiator_id: 7, status: 'OPEN' }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => socialFund.changeCaseStatus(1, 7, 'DISBURSED'),
    (err) => err.code === 'INVALID_TRANSITION'
  );
});

// Test 4: changeCaseStatus allows valid transition (OPEN -> CLOSED)
test('SF-10: changeCaseStatus allows valid transition (OPEN -> CLOSED)', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT * FROM social_fund_cases WHERE id')) {
      return { rows: [{ id: 1, initiator_id: 7, status: 'OPEN' }] };
    }
    if (sql.includes('UPDATE social_fund_cases')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_logs')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  });

  const result = await socialFund.changeCaseStatus(1, 7, 'CLOSED', 'Test closure');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.from, 'OPEN');
  assert.strictEqual(result.to, 'CLOSED');
});

// Test 5: changeCaseStatus returns 404 for missing case
test('SF-10: changeCaseStatus returns 404 for missing case', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT * FROM social_fund_cases WHERE id')) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => socialFund.changeCaseStatus(999, 7, 'CLOSED'),
    (err) => err.statusCode === 404 && err.code === 'NOT_FOUND'
  );
});

// Test 6: canTransition function works correctly
test('SF-10: canTransition validates allowed transitions', async () => {
  assert.strictEqual(socialFund.canTransition('OPEN', 'COLLECTING'), true);
  assert.strictEqual(socialFund.canTransition('OPEN', 'CLOSED'), true);
  assert.strictEqual(socialFund.canTransition('OPEN', 'CANCELLED'), true);
  assert.strictEqual(socialFund.canTransition('OPEN', 'EXPIRED'), true);
  assert.strictEqual(socialFund.canTransition('OPEN', 'DISBURSED'), false);
  assert.strictEqual(socialFund.canTransition('CANCELLED', 'OPEN'), false);
  assert.strictEqual(socialFund.canTransition('DISBURSED', 'OPEN'), false);
  assert.strictEqual(socialFund.canTransition('INVALID', 'OPEN'), false);
  assert.strictEqual(socialFund.canTransition('OPEN', 'INVALID'), false);
});

// Test 7: LIFECYCLE_STATES includes all required states
test('SF-10: LIFECYCLE_STATES includes all required states', async () => {
  const required = ['OPEN', 'COLLECTING', 'TARGET_REACHED', 'CLOSED', 'CANCELLED', 'EXPIRED', 'DISBURSEMENT_PENDING', 'PARTIALLY_DISBURSED', 'DISBURSED'];
  for (const state of required) {
    assert.ok(socialFund.LIFECYCLE_STATES.includes(state), `Missing state: ${state}`);
  }
});

// Test 8: contribute rejects when target reached
test('SF-10: contribute rejects when target reached', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT * FROM social_fund_cases WHERE id')) {
      return { rows: [{ id: 1, initiator_id: 7, status: 'COLLECTING', total_collected: 10000, target_amount: 10000, deadline: new Date(Date.now() + 86400000).toISOString() }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => socialFund.contribute(7, 1, 1000),
    (err) => err.code === 'TARGET_REACHED'
  );
});

// Test 9: contribute rejects after deadline
test('SF-10: contribute rejects after deadline', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT * FROM social_fund_cases WHERE id')) {
      return { rows: [{ id: 1, initiator_id: 7, status: 'OPEN', total_collected: 0, target_amount: 10000, deadline: new Date(Date.now() - 86400000).toISOString() }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => socialFund.contribute(7, 1, 1000),
    (err) => err.code === 'DEADLINE_EXPIRED'
  );
});

// Test 10: contribute rejects when case closed
test('SF-10: contribute rejects when case closed', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT * FROM social_fund_cases WHERE id')) {
      return { rows: [{ id: 1, initiator_id: 7, status: 'CLOSED', total_collected: 5000, target_amount: 10000, deadline: new Date(Date.now() + 86400000).toISOString() }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => socialFund.contribute(7, 1, 1000),
    (err) => err.code === 'CASE_CLOSED'
  );
});

async function runAll() {
  console.log('GSF SF-10 Lifecycle Transition Tests');
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