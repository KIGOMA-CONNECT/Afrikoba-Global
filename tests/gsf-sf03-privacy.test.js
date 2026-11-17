/**
 * GSF SF-03 Privacy Tests
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
  connect: async () => {
    throw new Error('Unexpected database connection in isolated SF-03 tests');
  },
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
mockModule('../src/utils/helpers', {
  generateReference: () => 'GSF-SF03-TEST-REFERENCE',
});
mockModule('../src/utils/strictAmount', {
  strictAmount: (value) => Number(value),
});
mockModule('../src/services/auditService', {
  writeAudit: async () => {},
});

const socialFund = require('../src/services/socialFundService');

function resetQueries(handler) {
  queryLog.length = 0;
  queryHandler = handler;
}

function configureDetails({
  caseRow,
  contributor = false,
  contributions = [],
}) {
  resetQueries(async (sql) => {
    if (sql.includes('FROM social_fund_cases')) {
      return { rows: [{ ...caseRow }] };
    }

    if (sql.includes('SELECT 1 FROM social_fund_contributions')) {
      return { rows: contributor ? [{ exists: 1 }] : [] };
    }

    if (sql.includes('SELECT sc.id, sc.user_id')) {
      return { rows: contributions.map((row) => ({ ...row })) };
    }

    throw new Error(`Unexpected SQL in test: ${sql}`);
  });
}

function standardCase(overrides = {}) {
  return {
    id: 101,
    initiator_id: 7,
    privacy_mode: 'ANONYMOUS_AMOUNTS',
    total_collected: 50000,
    status: 'OPEN',
    ...overrides,
  };
}

// 1. Listing: MEMBERS_ONLY filtering must be in SQL before pagination.
test('listing applies membership privacy predicate before LIMIT/OFFSET', async () => {
  resetQueries(async () => ({ rows: [] }));

  await socialFund.listCases('OPEN', {
    page: 2,
    limit: 10,
    currentUserId: 99,
  });

  assert.strictEqual(queryLog.length, 1);

  const sql = queryLog[0].sql;
  const whereIndex = sql.indexOf('WHERE');
  const limitIndex = sql.indexOf('LIMIT');

  assert.ok(whereIndex >= 0, 'Listing SQL must contain WHERE');
  assert.ok(limitIndex > whereIndex, 'Privacy filtering must precede pagination');
  assert.ok(sql.includes("c.privacy_mode = 'PUBLIC'"));
  assert.ok(sql.includes("c.privacy_mode = 'ANONYMOUS_AMOUNTS'"));
  assert.ok(sql.includes('c.initiator_id = $2'));
  assert.ok(sql.includes('EXISTS (SELECT 1 FROM social_fund_contributions'));
  assert.deepStrictEqual(queryLog[0].params, ['OPEN', 99, 10, 10]);
});

// 2. Listing: unauthenticated/missing identity must not expose private cases.
test('listing without currentUserId restricts results to PUBLIC campaigns', async () => {
  resetQueries(async () => ({ rows: [] }));

  await socialFund.listCases('OPEN', { currentUserId: null });

  const sql = queryLog[0].sql;
  assert.ok(sql.includes("c.privacy_mode = 'PUBLIC'"));
  assert.ok(!sql.includes("c.privacy_mode = 'ANONYMOUS_AMOUNTS'"));
});

// 3. Listing: outsiders must not see aggregate amounts.
test('ANONYMOUS_AMOUNTS listing hides total_collected from outsiders', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT c.*')) {
      return {
        rows: [{
          id: 101,
          initiator_id: 7,
          privacy_mode: 'ANONYMOUS_AMOUNTS',
          total_collected: 50000,
        }],
      };
    }
    if (sql.includes('SELECT 1 FROM social_fund_contributions')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const rows = await socialFund.listCases('OPEN', { currentUserId: 99 });

  assert.strictEqual(rows[0].total_collected, null);
});

// 4. Listing: contributors may see the aggregate.
test('ANONYMOUS_AMOUNTS listing preserves aggregate for contributors', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT c.*')) {
      return {
        rows: [{
          id: 101,
          initiator_id: 7,
          privacy_mode: 'ANONYMOUS_AMOUNTS',
          total_collected: 50000,
        }],
      };
    }
    if (sql.includes('SELECT 1 FROM social_fund_contributions')) {
      return { rows: [{ exists: 1 }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const rows = await socialFund.listCases('OPEN', { currentUserId: 12 });

  assert.strictEqual(rows[0].total_collected, 50000);
});

// 5. Listing: numeric/string identity mismatch must not hide initiator data.
test('listing recognizes initiator when database ID and request ID types differ', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('SELECT c.*')) {
      return {
        rows: [{
          id: 101,
          initiator_id: 25,
          privacy_mode: 'ANONYMOUS_AMOUNTS',
          total_collected: 50000,
        }],
      };
    }
    if (sql.includes('SELECT 1 FROM social_fund_contributions')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const rows = await socialFund.listCases('OPEN', { currentUserId: '25' });

  assert.strictEqual(rows[0].total_collected, 50000);
});

// 6. Details: outsider must not see contribution amounts or aggregate.
test('ANONYMOUS_AMOUNTS details hide amounts and aggregate from outsiders', async () => {
  configureDetails({
    caseRow: standardCase(),
    contributor: false,
    contributions: [{
      id: 1,
      user_id: 12,
      amount: 10000,
      is_anonymous: false,
      full_name: 'Contributor One',
    }],
  });

  const result = await socialFund.getCaseDetails(101, 99);

  assert.strictEqual(result.case.total_collected, null);
  assert.strictEqual(result.contributions[0].amount, null);
});

// 7. Details: contributor retains access to amounts.
test('ANONYMOUS_AMOUNTS details preserve amounts for contributors', async () => {
  configureDetails({
    caseRow: standardCase(),
    contributor: true,
    contributions: [{
      id: 1,
      user_id: 12,
      amount: 10000,
      is_anonymous: false,
      full_name: 'Contributor One',
    }],
  });

  const result = await socialFund.getCaseDetails(101, 12);

  assert.strictEqual(result.case.total_collected, 50000);
  assert.strictEqual(result.contributions[0].amount, 10000);
});

// 8. Details: initiator must retain access to MEMBERS_ONLY campaign.
test('MEMBERS_ONLY details permit the initiator despite numeric/string ID mismatch', async () => {
  configureDetails({
    caseRow: standardCase({
      initiator_id: 25,
      privacy_mode: 'MEMBERS_ONLY',
    }),
    contributor: false,
    contributions: [],
  });

  const result = await socialFund.getCaseDetails(101, '25');

  assert.strictEqual(result.case.id, 101);
});

// 9. Details: outsiders must be denied MEMBERS_ONLY campaigns.
test('MEMBERS_ONLY details reject outsiders', async () => {
  configureDetails({
    caseRow: standardCase({ privacy_mode: 'MEMBERS_ONLY' }),
    contributor: false,
    contributions: [],
  });

  await assert.rejects(
    () => socialFund.getCaseDetails(101, 99),
    (err) => err.statusCode === 403 && err.code === 'ACCESS_DENIED'
  );
});

// 10. Details: unknown privacy mode must fail closed for outsiders.
test('NULL privacy mode fails closed for outsiders', async () => {
  configureDetails({
    caseRow: standardCase({ privacy_mode: null }),
    contributor: false,
    contributions: [],
  });

  await assert.rejects(
    () => socialFund.getCaseDetails(101, 99),
    (err) => err.statusCode === 404 && err.code === 'NOT_FOUND'
  );
});

// 11. Details: unknown non-NULL privacy mode must fail closed.
test('unknown privacy mode fails closed for outsiders', async () => {
  configureDetails({
    caseRow: standardCase({ privacy_mode: 'UNRECOGNIZED_MODE' }),
    contributor: false,
    contributions: [],
  });

  await assert.rejects(
    () => socialFund.getCaseDetails(101, 99),
    (err) => err.statusCode === 404 && err.code === 'NOT_FOUND'
  );
});

// 12. Details: anonymous contributor identity is masked for other users.
test('anonymous contributor identity is hidden from other users', async () => {
  configureDetails({
    caseRow: standardCase({ privacy_mode: 'PUBLIC' }),
    contributor: false,
    contributions: [{
      id: 1,
      user_id: 12,
      amount: 10000,
      is_anonymous: true,
      full_name: 'Private Contributor',
    }],
  });

  const result = await socialFund.getCaseDetails(101, 99);

  assert.strictEqual(
    result.contributions[0].full_name,
    'Mwanachama (Anonymous)'
  );
});

// 13. Details: contributor should see their own anonymous identity.
test('anonymous contributor can see their own identity despite ID type mismatch', async () => {
  configureDetails({
    caseRow: standardCase({ privacy_mode: 'PUBLIC' }),
    contributor: true,
    contributions: [{
      id: 1,
      user_id: 12,
      amount: 10000,
      is_anonymous: true,
      full_name: 'Private Contributor',
    }],
  });

  const result = await socialFund.getCaseDetails(101, '12');

  assert.strictEqual(
    result.contributions[0].full_name,
    'Private Contributor'
  );
});

async function runAll() {
  console.log('GSF SF-03 isolated privacy tests');
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
