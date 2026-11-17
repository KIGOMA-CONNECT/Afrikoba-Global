/**
 * GOV-AN Governance Analytics Remediation Tests
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
    // MTC-03: handle CURRENT_DATE capture query (date captured once per persist)
    if (/SELECT CURRENT_DATE/i.test(sql)) {
      return { rows: [{ snapshot_date: '2026-11-15' }], rowCount: 1 };
    }
    return queryHandler(sql, params);
  },
  connect: async () => {
    throw new Error('Unexpected database connection in isolated GOV-AN tests');
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
mockModule('../src/utils/logger', { error() {}, warn() {}, info() {}, debug() {} });

const gov = require('../src/services/governanceEngineService');

function resetQueries(handler) {
  queryLog.length = 0;
  queryHandler = handler;
}

// Test 1: computeGovernanceAnalytics is read-only (no INSERT/UPDATE)
test('GOV-AN-T01/T02: computeGovernanceAnalytics does not write to database', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('governance_meetings')) {
      return { rows: [{ id: 1, status: 'COMPLETED', att: 5, tot: 10 }] };
    }
    if (sql.includes('governance_resolutions')) {
      return { rows: [{ total: 2, passed: 1, avg_hours: 2.5 }] };
    }
    if (sql.includes('governance_action_items')) {
      return { rows: [{ total: 3, done: 1, open: 2, overdue: 0 }] };
    }
    return { rows: [] };
  });

  await gov.computeGovernanceAnalytics('VICOBA', 1);

  const hasWrite = queryLog.some(q => /^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql.trim()));
  assert.strictEqual(hasWrite, false, 'computeGovernanceAnalytics must not issue INSERT/UPDATE/DELETE');
});

// Test 2: persistAnalyticsSnapshot is separate and does write
test('GOV-AN: persistAnalyticsSnapshot writes snapshot', async () => {
  resetQueries(async (sql) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 5 }], rowCount: 1 };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 5, completed: 3, avgAttendancePercent: 60 },
    resolutions: { total: 2, passed: 1, avgDecisionHours: 2.5 },
    actionItems: { total: 3, completed: 1, open: 2, overdue: 0 },
  };

  await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);

  const hasInsert = queryLog.some(q => /INSERT INTO governance_analytics/i.test(q.sql));
  assert.strictEqual(hasInsert, true, 'persistAnalyticsSnapshot must issue INSERT');
});

// Test 3: Attendance denominator excludes meetings without attendees (R3)
test('GOV-AN-T06: meetings without attendance records excluded from denominator', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('governance_meetings')) {
      return {
        rows: [
          { id: 1, status: 'COMPLETED', att: 5, tot: 10 },
          { id: 2, status: 'COMPLETED', att: 0, tot: 0 },
          { id: 3, status: 'COMPLETED', att: 8, tot: 10 },
        ],
      };
    }
    if (sql.includes('governance_resolutions')) {
      return { rows: [{ total: 0, passed: 0, avg_hours: null }] };
    }
    if (sql.includes('governance_action_items')) {
      return { rows: [{ total: 0, done: 0, open: 0, overdue: 0 }] };
    }
    return { rows: [] };
  });

  const result = await gov.computeGovernanceAnalytics('VICOBA', 1);

  assert.strictEqual(result.meetings.avgAttendancePercent, 65,
    'Average should be (50+80)/2=65, not (50+0+80)/3=43.33');
  assert.strictEqual(result.meetings.total, 3, 'Total meetings should still be 3');
});

// Test 4: Meetings with 0% attendance (attendees exist but none attended) are included
test('GOV-AN-T06b: meetings with attendance records but 0% attendance are included in denominator', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('governance_meetings')) {
      return {
        rows: [
          { id: 1, status: 'COMPLETED', att: 5, tot: 10 },
          { id: 2, status: 'COMPLETED', att: 0, tot: 5 },
        ],
      };
    }
    if (sql.includes('governance_resolutions')) {
      return { rows: [{ total: 0, passed: 0, avg_hours: null }] };
    }
    if (sql.includes('governance_action_items')) {
      return { rows: [{ total: 0, done: 0, open: 0, overdue: 0 }] };
    }
    return { rows: [] };
  });

  const result = await gov.computeGovernanceAnalytics('VICOBA', 1);

  assert.strictEqual(result.meetings.avgAttendancePercent, 25,
    'Average should be (50+0)/2=25');
});

// Test 5: N+1 fix - single aggregation query
test('GOV-AN-T07: attendance uses single aggregation query (no N+1)', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('governance_meetings')) {
      return {
        rows: [
          { id: 1, status: 'COMPLETED', att: 5, tot: 10 },
          { id: 2, status: 'COMPLETED', att: 8, tot: 10 },
          { id: 3, status: 'COMPLETED', att: 3, tot: 10 },
        ],
      };
    }
    if (sql.includes('governance_resolutions')) {
      return { rows: [{ total: 0, passed: 0, avg_hours: null }] };
    }
    if (sql.includes('governance_action_items')) {
      return { rows: [{ total: 0, done: 0, open: 0, overdue: 0 }] };
    }
    return { rows: [] };
  });

  await gov.computeGovernanceAnalytics('VICOBA', 1);

  assert.strictEqual(queryLog.length, 3,
    'Should use 3 queries (meetings+attendance, resolutions, action_items), not N+1. Got: ' + queryLog.length);
});

// Test 6: R2 - canonical group context
test('GOV-AN-T05: computeGovernanceAnalytics uses provided groupType/groupId', async () => {
  resetQueries(async (sql, params) => {
    if (sql.includes('governance_meetings')) {
      assert.deepStrictEqual(params, ['SACCOS', 42], 'Must use provided groupType and groupId');
      return { rows: [] };
    }
    if (sql.includes('governance_resolutions')) {
      return { rows: [{ total: 0, passed: 0, avg_hours: null }] };
    }
    if (sql.includes('governance_action_items')) {
      return { rows: [{ total: 0, done: 0, open: 0, overdue: 0 }] };
    }
    return { rows: [] };
  });

  await gov.computeGovernanceAnalytics('SACCOS', 42);
});

// Test 7: Empty meetings
test('GOV-AN: empty meetings returns 0% attendance', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('governance_meetings')) {
      return { rows: [] };
    }
    if (sql.includes('governance_resolutions')) {
      return { rows: [{ total: 0, passed: 0, avg_hours: null }] };
    }
    if (sql.includes('governance_action_items')) {
      return { rows: [{ total: 0, done: 0, open: 0, overdue: 0 }] };
    }
    return { rows: [] };
  });

  const result = await gov.computeGovernanceAnalytics('VICOBA', 1);
  assert.strictEqual(result.meetings.avgAttendancePercent, 0);
  assert.strictEqual(result.meetings.total, 0);
});

// Test 8: persistAnalyticsSnapshot writes (separate from compute)
test('GOV-AN-T08: persistAnalyticsSnapshot writes snapshot independently', async () => {
  resetQueries(async (sql) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 5 }], rowCount: 1 };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 5, completed: 3, avgAttendancePercent: 60 },
    resolutions: { total: 2, passed: 1, avgDecisionHours: 2.5 },
    actionItems: { total: 3, completed: 1, open: 2, overdue: 0 },
  };

  await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);

  const hasInsert = queryLog.some(q => /INSERT INTO governance_analytics/i.test(q.sql));
  assert.strictEqual(hasInsert, true, 'persistAnalyticsSnapshot must issue INSERT');
});

// === R4 — Immutable Analytics Snapshot Tests ===

// R4-T01: First snapshot for a group/date → created
test('R4-T01: first snapshot returns created', async () => {
  resetQueries(async (sql, params) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 5 }], rowCount: 1 };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 5, completed: 3, avgAttendancePercent: 60 },
    resolutions: { total: 2, passed: 1, avgDecisionHours: 2.5 },
    actionItems: { total: 3, completed: 1, open: 2, overdue: 0 },
  };

  const result = await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);
  assert.strictEqual(result.status, 'created', 'First snapshot should return status=created');
  assert.ok(result.snapshot, 'Should return the inserted snapshot');
});

// R4-T02: Repeat insertion for same group/date → already_recorded
test('R4-T02: repeat insertion returns already_recorded', async () => {
  resetQueries(async (sql, params) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [], rowCount: 0 }; // conflict, no row returned
    }
    if (/SELECT \* FROM governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 5 }] };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 10, completed: 5, avgAttendancePercent: 80 },
    resolutions: { total: 3, passed: 2, avgDecisionHours: 1.5 },
    actionItems: { total: 4, completed: 2, open: 2, overdue: 0 },
  };

  const result = await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);
  assert.strictEqual(result.status, 'already_recorded', 'Repeat should return status=already_recorded');
  assert.strictEqual(result.snapshot.total_meetings, 5, 'Should return existing snapshot values, not new ones');
});

// R4-T03: Persisted values unchanged after repeat
test('R4-T03: persisted values identical before and after repeat', async () => {
  let firstSnapshot = null;

  // First call: insert succeeds
  resetQueries(async (sql) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      firstSnapshot = { group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 5, avg_attendance_percent: 60 };
      return { rows: [firstSnapshot], rowCount: 1 };
    }
    return { rows: [] };
  });

  const analytics1 = {
    meetings: { total: 5, completed: 3, avgAttendancePercent: 60 },
    resolutions: { total: 2, passed: 1, avgDecisionHours: 2.5 },
    actionItems: { total: 3, completed: 1, open: 2, overdue: 0 },
  };

  const r1 = await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics1);
  assert.strictEqual(r1.status, 'created');

  // Second call: conflict, return existing
  resetQueries(async (sql) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT \* FROM governance_analytics/i.test(sql)) {
      return { rows: [firstSnapshot] };
    }
    return { rows: [] };
  });

  const analytics2 = {
    meetings: { total: 99, completed: 99, avgAttendancePercent: 99 },
    resolutions: { total: 99, passed: 99, avgDecisionHours: 99 },
    actionItems: { total: 99, completed: 99, open: 99, overdue: 99 },
  };

  const r2 = await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics2);
  assert.strictEqual(r2.status, 'already_recorded');
  assert.strictEqual(r2.snapshot.total_meetings, 5, 'Existing snapshot values must not be overwritten');
  assert.strictEqual(r2.snapshot.avg_attendance_percent, 60, 'Existing snapshot values must not be overwritten');
});

// R4-T06: Same date, different group → independent snapshot
test('R4-T06: same date different group allows independent snapshot', async () => {
  resetQueries(async (sql, params) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      // params[1] is groupId
      if (params[1] === 2) {
        return { rows: [{ group_type: 'VICOBA', group_id: 2, snapshot_date: '2026-11-15', total_meetings: 3 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT \* FROM governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 2, snapshot_date: '2026-11-15', total_meetings: 3 }] };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 3, completed: 2, avgAttendancePercent: 70 },
    resolutions: { total: 1, passed: 1, avgDecisionHours: 1 },
    actionItems: { total: 2, completed: 1, open: 1, overdue: 0 },
  };

  const result = await gov.persistAnalyticsSnapshot('VICOBA', 2, analytics);
  assert.ok(result.status === 'created' || result.status === 'already_recorded', 'Should succeed for different group');
});

// R4-T07: Same group, different date → independent snapshot (handled by DB, mock returns created)
test('R4-T07: same group different date allows independent snapshot', async () => {
  resetQueries(async (sql) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-16', total_meetings: 7 }], rowCount: 1 };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 7, completed: 4, avgAttendancePercent: 55 },
    resolutions: { total: 1, passed: 1, avgDecisionHours: 2 },
    actionItems: { total: 2, completed: 1, open: 1, overdue: 0 },
  };

  const result = await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);
  assert.strictEqual(result.status, 'created', 'Different date should allow new snapshot');
});

// R4-T09: GET /analytics is read-only (compute only, no persist)
test('R4-T09: computeGovernanceAnalytics does not persist (read-only)', async () => {
  resetQueries(async (sql) => {
    if (sql.includes('governance_meetings')) {
      return { rows: [{ id: 1, status: 'COMPLETED', att: 5, tot: 10 }] };
    }
    if (sql.includes('governance_resolutions')) {
      return { rows: [{ total: 1, passed: 1, avg_hours: 2 }] };
    }
    if (sql.includes('governance_action_items')) {
      return { rows: [{ total: 2, done: 1, open: 1, overdue: 0 }] };
    }
    return { rows: [] };
  });

  await gov.computeGovernanceAnalytics('VICOBA', 1);

  const hasWrite = queryLog.some(q => /^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql.trim()));
  assert.strictEqual(hasWrite, false, 'compute must not write');
});

// R4-T11: Existing snapshot followed by changed source data → original remains
test('R4-T11: changed source data does not overwrite existing snapshot', async () => {
  const originalSnapshot = { group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 5 };

  resetQueries(async (sql) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [], rowCount: 0 }; // conflict
    }
    if (/SELECT \* FROM governance_analytics/i.test(sql)) {
      return { rows: [originalSnapshot] };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 999, completed: 999, avgAttendancePercent: 99 },
    resolutions: { total: 999, passed: 999, avgDecisionHours: 99 },
    actionItems: { total: 999, completed: 999, open: 999, overdue: 999 },
  };

  const result = await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);
  assert.strictEqual(result.status, 'already_recorded');
  assert.strictEqual(result.snapshot.total_meetings, 5, 'Original snapshot must be preserved');
});

// R4-T12: Insert conflict and subsequent read → correct existing snapshot returned
test('R4-T12: conflict returns correct existing snapshot', async () => {
  resetQueries(async (sql) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT \* FROM governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 7, avg_attendance_percent: 42 }] };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 1, completed: 1, avgAttendancePercent: 1 },
    resolutions: { total: 1, passed: 1, avgDecisionHours: 1 },
    actionItems: { total: 1, completed: 1, open: 0, overdue: 0 },
  };

  const result = await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);
  assert.strictEqual(result.status, 'already_recorded');
  assert.strictEqual(result.snapshot.total_meetings, 7);
  assert.strictEqual(result.snapshot.avg_attendance_percent, 42);
});

// R4-T13: Snapshot creation failure → no false success
test('R4-T13: insert failure propagates error (no false success)', async () => {
  resetQueries(async (sql) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      throw new Error('DB connection lost');
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 1, completed: 1, avgAttendancePercent: 50 },
    resolutions: { total: 1, passed: 1, avgDecisionHours: 1 },
    actionItems: { total: 1, completed: 1, open: 0, overdue: 0 },
  };

  let thrown = null;
  try {
    await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'Should throw on insert failure');
  assert.ok(thrown.message.includes('Snapshot persistence failed'), 'Error should be meaningful');
});

// R4-T14: Two different groups computing concurrently → no cross-group interference
test('R4-T14: different groups get independent snapshots', async () => {
  resetQueries(async (sql, params) => {
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      const groupId = params[1];
      return { rows: [{ group_type: 'VICOBA', group_id: groupId, snapshot_date: '2026-11-15', total_meetings: groupId * 10 }], rowCount: 1 };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 5, completed: 3, avgAttendancePercent: 60 },
    resolutions: { total: 2, passed: 1, avgDecisionHours: 2.5 },
    actionItems: { total: 3, completed: 1, open: 2, overdue: 0 },
  };

  const r1 = await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);
  const r2 = await gov.persistAnalyticsSnapshot('VICOBA', 2, analytics);

  assert.strictEqual(r1.status, 'created');
  assert.strictEqual(r2.status, 'created');
  assert.notStrictEqual(r1.snapshot.group_id, r2.snapshot.group_id, 'Different groups should have different snapshots');
});

// R4-T15: Date consistency - snapshot date captured once and reused
test('R4-T15: snapshot date captured once and reused in INSERT and SELECT', async () => {
  resetQueries(async (sql) => {
    if (/SELECT CURRENT_DATE/i.test(sql)) {
      return { rows: [{ snapshot_date: '2026-11-15' }], rowCount: 1 };
    }
    if (/INSERT INTO governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 5 }], rowCount: 1 };
    }
    if (/SELECT \* FROM governance_analytics/i.test(sql)) {
      return { rows: [{ group_type: 'VICOBA', group_id: 1, snapshot_date: '2026-11-15', total_meetings: 5 }] };
    }
    return { rows: [] };
  });

  const analytics = {
    meetings: { total: 5, completed: 3, avgAttendancePercent: 60 },
    resolutions: { total: 2, passed: 1, avgDecisionHours: 2.5 },
    actionItems: { total: 3, completed: 1, open: 2, overdue: 0 },
  };

  await gov.persistAnalyticsSnapshot('VICOBA', 1, analytics);

  // Verify: exactly one CURRENT_DATE capture query
  const dateQueries = queryLog.filter(q => /SELECT CURRENT_DATE/i.test(q.sql));
  assert.strictEqual(dateQueries.length, 1, 'Date should be captured exactly once');

  // Verify: INSERT uses parameterized date ($3), not CURRENT_DATE literal
  const insertQuery = queryLog.find(q => /INSERT INTO governance_analytics/i.test(q.sql));
  assert.ok(insertQuery, 'INSERT query should exist');
  assert.ok(!insertQuery.sql.includes('CURRENT_DATE'), 'INSERT should use parameterized date, not CURRENT_DATE literal');
  assert.strictEqual(insertQuery.params[2], '2026-11-15', 'INSERT should use captured date as $3');

  // Verify: SELECT uses parameterized date ($3), not CURRENT_DATE literal
  // (only present on conflict path; this test exercises the created path, so no SELECT)
  // The date consistency is verified by the single capture query above.
});

// R4-T04/T05: Database-level immutability (trigger) - PROPOSED, not testable in mock
test('R4-T04/R4-T05: database immutability trigger (PROPOSED - not testable in mock)', async () => {
  // This test documents that trigger-based immutability (migration 151)
  // cannot be verified with mock-based tests. It requires a real PostgreSQL
  // instance with the trigger installed.
  // Status: PROPOSED (not implemented, not tested)
  console.log('    (PROPOSED - requires real PostgreSQL with trigger installed)');
});

async function runAll() {
  console.log('GOV-AN Governance Analytics remediation tests');
  console.log('Database connections: disabled');
  console.log('Source modifications: none\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('PASS  ' + name);
    } catch (err) {
      failed++;
      console.error('FAIL  ' + name);
      console.error('      ' + err.message);
    }
  }

  console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed, ' + tests.length + ' total');
  process.exitCode = failed === 0 ? 0 : 1;
}

runAll();