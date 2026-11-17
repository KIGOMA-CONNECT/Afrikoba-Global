'use strict';

/**
 * MTC-28 / G1 — migration fail-closed guard tests.
 *
 * These are deterministic unit/integration tests driven by controlled fixtures and
 * an in-memory mock `pg` client. They do NOT connect to PostgreSQL and do NOT execute
 * any real migration. The mock records every query so we can prove that blocked
 * migrations never reach a write transaction, the ledger, or the migration body.
 */

const assert = require('assert');
const path = require('path');

const guard = require(path.join(__dirname, '..', 'scripts', 'runMigrations'));
const {
  classifyMigrations,
  resolveAuthorization,
  loadAuthorization,
  listMigrationFiles,
  runGuardedMigrations,
  executePlan,
  main,
  HARD_BLOCKED,
  GuardRefusal,
} = guard;

const M155 = '155_social_fund_institution_binding.sql';

const WRITE_RE = /^\s*(BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i;

function makeMockClient({ recorded = [], recordedTableExists = true, failWhen = null } = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params) {
      const s = String(sql);
      calls.push({ sql: s, params });
      if (failWhen && failWhen(s)) throw new Error('mock failure: ' + s.slice(0, 48));
      if (s.includes("to_regclass('public.schema_migrations')")) {
        return { rows: [{ o: recordedTableExists ? 'schema_migrations' : null }] };
      }
      if (/^\s*SELECT\s+version\s+FROM\s+schema_migrations\s*$/i.test(s)) {
        return { rows: recorded.map((v) => ({ version: v })) };
      }
      return { rows: [] };
    },
    async end() {},
  };
  return client;
}

function writes(calls) {
  return calls.filter((c) => WRITE_RE.test(c.sql));
}

function manifestWith(overrides) {
  return {
    version: 1,
    defaultState: 'PENDING_UNAUTHORIZED',
    decisions: { 'OD-10': 'OPEN' },
    migrations: overrides || {},
  };
}

function findings(plan) {
  const map = {};
  for (const item of plan) map[item.version] = item;
  return map;
}

async function run() {
  let passed = 0;
  let failed = 0;
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  // -------------------------------------------------------------------------
  // Pure classification
  // -------------------------------------------------------------------------

  test('1. recorded migration is skipped (existing behavior preserved)', () => {
    const plan = classifyMigrations({
      files: ['001_init.sql'],
      recorded: ['001_init.sql'],
      manifest: manifestWith({}),
      effects: {},
    });
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].decision, 'SKIP');
    assert.strictEqual(plan[0].code, 'APPLIED_TRACKED');
  });

  test('2. Migration 155 pending + OD-10 OPEN is BLOCKED', () => {
    const plan = classifyMigrations({
      files: [M155],
      recorded: [],
      manifest: manifestWith({ [M155]: { state: 'BLOCKED', decision: 'OD-10' } }),
      effects: {},
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'MIGRATION_BLOCKED');
    assert.strictEqual(plan[0].decisionId, 'OD-10');
  });

  test('3. hard block beats a forged PENDING_AUTHORIZED + valid token while OD-10 OPEN', () => {
    const plan = classifyMigrations({
      files: [M155],
      recorded: [],
      manifest: manifestWith({
        [M155]: { state: 'PENDING_AUTHORIZED', executionAuthorization: 'FORGED', decision: 'OD-10' },
      }),
      effects: {},
      authorization: { id: 'FORGED' },
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'MIGRATION_BLOCKED');
  });

  test('4. hard block applies even when the manifest has no entry for 155', () => {
    const plan = classifyMigrations({
      files: [M155],
      recorded: [],
      manifest: manifestWith({}),
      effects: {},
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'MIGRATION_BLOCKED');
    assert.strictEqual(plan[0].decisionId, 'OD-10');
  });

  test('5. applied-but-unrecorded with all effects present is BLOCKED (never auto-recorded)', () => {
    const plan = classifyMigrations({
      files: ['152_social_fund_case_permissions.sql'],
      recorded: [],
      manifest: manifestWith({ '152_social_fund_case_permissions.sql': { state: 'APPLIED_UNRECORDED' } }),
      effects: { '152_social_fund_case_permissions.sql': [{ type: 'table', name: 'x', present: true }] },
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'APPLIED_UNRECORDED');
  });

  test('6. applied-but-unrecorded with missing/ambiguous evidence is BLOCKED', () => {
    const plan = classifyMigrations({
      files: ['152_social_fund_case_permissions.sql'],
      recorded: [],
      manifest: manifestWith({ '152_social_fund_case_permissions.sql': { state: 'APPLIED_UNRECORDED' } }),
      effects: { '152_social_fund_case_permissions.sql': [{ type: 'table', name: 'x', present: false }] },
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'APPLIED_EVIDENCE_MISSING');
  });

  test('7. pending authorized with no token is BLOCKED', () => {
    const plan = classifyMigrations({
      files: ['156_new.sql'],
      recorded: [],
      manifest: manifestWith({ '156_new.sql': { state: 'PENDING_AUTHORIZED', executionAuthorization: 'AUTH-1' } }),
      effects: {},
      authorization: { id: null },
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'MIGRATION_NOT_AUTHORIZED');
  });

  test('8. pending authorized with a mismatched token is BLOCKED', () => {
    const plan = classifyMigrations({
      files: ['156_new.sql'],
      recorded: [],
      manifest: manifestWith({ '156_new.sql': { state: 'PENDING_AUTHORIZED', executionAuthorization: 'AUTH-1' } }),
      effects: {},
      authorization: { id: 'AUTH-WRONG' },
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'MIGRATION_NOT_AUTHORIZED');
  });

  test('9. pending authorized with matching token passes the authorization boundary', () => {
    const plan = classifyMigrations({
      files: ['156_new.sql'],
      recorded: [],
      manifest: manifestWith({ '156_new.sql': { state: 'PENDING_AUTHORIZED', executionAuthorization: 'AUTH-1', nonce: 'n-1', expiresAt: '2099-01-01T00:00:00Z' } }),
      effects: {},
      authorization: { id: 'AUTH-1', nonce: 'n-1' },
    });
    assert.strictEqual(plan[0].decision, 'EXECUTE');
    assert.strictEqual(plan[0].code, 'AUTHORIZED');
  });

  test('10. unknown manifest state is BLOCKED (fail closed)', () => {
    const plan = classifyMigrations({
      files: ['156_new.sql'],
      recorded: [],
      manifest: manifestWith({ '156_new.sql': { state: 'SOMETHING_ELSE' } }),
      effects: {},
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'UNKNOWN_MIGRATION_STATE');
  });

  test('11. unrecorded file with no manifest entry is BLOCKED (deny by default)', () => {
    const plan = classifyMigrations({
      files: ['999_unknown.sql'],
      recorded: [],
      manifest: manifestWith({}),
      effects: {},
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'UNKNOWN_MIGRATION');
  });

  test('12. classification and file ordering are deterministic and preserved', () => {
    const files = ['002_b.sql', '001_a.sql', '003_c.sql'];
    const plan = classifyMigrations({ files, recorded: [], manifest: manifestWith({}), effects: {} });
    assert.deepStrictEqual(plan.map((p) => p.version), files);
    const onDisk = listMigrationFiles();
    assert.ok(onDisk.length >= 160, 'expected at least 160 migration files');
    assert.deepStrictEqual(onDisk, onDisk.slice().sort(), 'migration files must be deterministically sorted');
    assert.ok(onDisk.includes(M155), 'migration 155 must remain present on disk (not moved/deleted)');
  });

  test('13. blocked migration whose effects are present is reported as drift', () => {
    const plan = classifyMigrations({
      files: [M155],
      recorded: [],
      manifest: manifestWith({ [M155]: { state: 'BLOCKED', decision: 'OD-10' } }),
      effects: { [M155]: [{ type: 'column', table: 'social_fund_cases', column: 'institution_id', present: true }] },
    });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'BLOCKED_MIGRATION_EFFECT_PRESENT');
    assert.strictEqual(plan[0].classification, 'BLOCKED_DRIFT');
  });

  // -------------------------------------------------------------------------
  // Authorization token resolution
  // -------------------------------------------------------------------------

  test('14. resolves authorization token from argv and environment', () => {
    assert.deepStrictEqual(resolveAuthorization(['--authorize=OD-X'], {}), { id: 'OD-X' });
    assert.deepStrictEqual(resolveAuthorization([], { MIGRATION_AUTHORIZATION: 'ENV-X' }), { id: 'ENV-X' });
    assert.deepStrictEqual(resolveAuthorization([], {}), { id: null });
  });

  test('15. the committed manifest keeps OD-10 OPEN and 155 BLOCKED', () => {
    const manifest = loadAuthorization();
    assert.strictEqual(manifest.decisions['OD-10'], 'OPEN');
    assert.strictEqual(manifest.migrations[M155].state, 'BLOCKED');
    assert.ok(HARD_BLOCKED[M155], '155 must be hard-blocked in code');
  });

  // -------------------------------------------------------------------------
  // Guarded execution (mock client, no real DB)
  // -------------------------------------------------------------------------

  test('16. blocked 155 never reads/executes the migration body and performs no writes', async () => {
    const client = makeMockClient({ recorded: [] });
    let bodyReads = 0;
    let thrown = null;
    try {
      await runGuardedMigrations({
        client,
        files: [M155],
        manifest: manifestWith({ [M155]: { state: 'BLOCKED', decision: 'OD-10' } }),
        effects: {},
        readFile: () => { bodyReads++; return 'ALTER TABLE should_not_run;'; },
        log: () => {},
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof GuardRefusal, 'expected a GuardRefusal');
    assert.strictEqual(thrown.code, 'MIGRATION_BLOCKED');
    assert.strictEqual(bodyReads, 0, 'migration body must never be read');
    assert.strictEqual(writes(client.calls).length, 0, 'no BEGIN/INSERT/CREATE may occur');
  });

  test('17. blocked 155 leaves schema_migrations untouched (no INSERT/UPDATE/DELETE/CREATE)', async () => {
    const client = makeMockClient({ recorded: [] });
    await assert.rejects(
      () => runGuardedMigrations({
        client,
        files: [M155],
        manifest: manifestWith({ [M155]: { state: 'BLOCKED', decision: 'OD-10' } }),
        effects: {},
        log: () => {},
      }),
      (err) => err instanceof GuardRefusal
    );
    const ledgerWrites = client.calls.filter((c) =>
      /^\s*(INSERT\s+INTO\s+schema_migrations|UPDATE\s+schema_migrations|DELETE\s+FROM\s+schema_migrations|CREATE\s+TABLE[^;]*schema_migrations)/i.test(c.sql)
    );
    assert.strictEqual(ledgerWrites.length, 0);
  });

  test('18. applied-but-unrecorded 152 is blocked with no writes', async () => {
    const client = makeMockClient({ recorded: [] });
    await assert.rejects(
      () => runGuardedMigrations({
        client,
        files: ['152_social_fund_case_permissions.sql'],
        manifest: manifestWith({ '152_social_fund_case_permissions.sql': { state: 'APPLIED_UNRECORDED' } }),
        effects: { '152_social_fund_case_permissions.sql': [{ type: 'table', name: 'x', present: true }] },
        log: () => {},
      }),
      (err) => err instanceof GuardRefusal && err.code === 'APPLIED_UNRECORDED'
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('19. explicit authorized migration passes and executes in order', async () => {
    const client = makeMockClient({ recorded: [] });
    const file = '156_authorized_test.sql';
    let reads = 0;
    const result = await runGuardedMigrations({
      client,
      files: [file],
      manifest: manifestWith({ [file]: { state: 'PENDING_AUTHORIZED', executionAuthorization: 'AUTH-1', nonce: 'n-1', expiresAt: '2099-01-01T00:00:00Z' } }),
      authorization: { id: 'AUTH-1', nonce: 'n-1' },
      effects: {},
      readFile: () => { reads++; return 'SELECT 1;'; },
      log: () => {},
    });
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(reads, 1);
    const seq = client.calls.map((c) => c.sql.trim());
    const iBegin = seq.indexOf('BEGIN');
    const iCreate = seq.findIndex((s) => /^CREATE TABLE/i.test(s));
    const iInsert = seq.findIndex((s) => /^INSERT INTO schema_migrations/i.test(s));
    const iCommit = seq.indexOf('COMMIT');
    assert.ok(iCreate >= 0 && iBegin >= 0 && iInsert >= 0 && iCommit >= 0, 'expected full transaction sequence');
    assert.ok(iCreate < iBegin, 'ledger table created before the migration transaction');
    assert.ok(iBegin < iInsert && iInsert < iCommit, 'BEGIN → body/INSERT → COMMIT');
    assert.ok(seq.includes('SELECT 1;'), 'authorized body executed');
  });

  test('20. guard decision precedes migration DDL/DML (no write before classification)', async () => {
    const client = makeMockClient({ recorded: [] });
    await assert.rejects(
      () => runGuardedMigrations({
        client,
        files: [M155],
        manifest: manifestWith({ [M155]: { state: 'BLOCKED', decision: 'OD-10' } }),
        effects: {},
        log: () => {},
      }),
      (err) => err instanceof GuardRefusal
    );
    const firstWrite = client.calls.findIndex((c) => WRITE_RE.test(c.sql));
    assert.strictEqual(firstWrite, -1, 'blocked run must perform zero writes (guard runs first)');
  });

  test('21. fully recorded state performs no ledger creation and applies nothing', async () => {
    const client = makeMockClient({ recorded: ['001_init.sql'] });
    const result = await runGuardedMigrations({
      client,
      files: ['001_init.sql'],
      manifest: manifestWith({}),
      effects: {},
      log: () => {},
    });
    assert.strictEqual(result.applied, 0);
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('22. assess path issues no write statements', async () => {
    const client = makeMockClient({ recorded: [] });
    const result = await runGuardedMigrations({
      client,
      files: [M155],
      manifest: manifestWith({ [M155]: { state: 'BLOCKED', decision: 'OD-10' } }),
      effects: {},
      assess: true,
      log: () => {},
    });
    assert.strictEqual(result.assess, true);
    assert.strictEqual(result.plan[0].decision, 'BLOCK');
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('23. migration failure rolls back and does not commit', async () => {
    const client = makeMockClient({ recorded: [], failWhen: (s) => s === 'SELECT 1;' });
    await assert.rejects(
      () => runGuardedMigrations({
        client,
        files: ['156_authorized_test.sql'],
        manifest: manifestWith({ '156_authorized_test.sql': { state: 'PENDING_AUTHORIZED', executionAuthorization: 'AUTH-1', nonce: 'n-1', expiresAt: '2099-01-01T00:00:00Z' } }),
        authorization: { id: 'AUTH-1', nonce: 'n-1' },
        effects: {},
        readFile: () => 'SELECT 1;',
        log: () => {},
      }),
      /mock failure/
    );
    const seq = client.calls.map((c) => c.sql.trim());
    assert.ok(seq.includes('ROLLBACK'), 'failed migration must roll back');
    assert.ok(!seq.includes('COMMIT'), 'failed migration must not commit');
  });

  test('24. unqualified main() invocation with real manifest/files cannot execute 155', async () => {
    const files = listMigrationFiles();
    // Simulate every migration except 155 already recorded, so 155 is the only pending file.
    const recorded = files.filter((f) => f !== M155);
    const client = makeMockClient({ recorded });
    let bodyReads = 0;
    await assert.rejects(
      () => main({
        argv: [], // unqualified: no --authorize, no --assess
        manifest: loadAuthorization(),
        files,
        effects: {},
        clientFactory: async () => client,
        readFile: () => { bodyReads++; return 'ALTER TABLE should_not_run;'; },
        log: () => {},
      }),
      (err) => err instanceof GuardRefusal && err.code === 'MIGRATION_BLOCKED'
    );
    assert.strictEqual(bodyReads, 0, '155 body must never be read');
    assert.strictEqual(writes(client.calls).length, 0, 'no writes may occur');
  });

  test('25. unqualified main() invocation blocks when reconciled 152 has no ledger row (no auto-record)', async () => {
    const files = listMigrationFiles();
    // Everything except 152-155 recorded: 152 is the first unrecorded migration.
    const recorded = files.filter((f) => !/^15[2-5]_/.test(f));
    const client = makeMockClient({ recorded });
    let bodyReads = 0;
    await assert.rejects(
      () => main({
        argv: [],
        manifest: loadAuthorization(),
        files,
        effects: {}, // probe override: no verifiable effects -> ambiguous
        clientFactory: async () => client,
        readFile: () => { bodyReads++; return 'SELECT 1;'; },
        log: () => {},
      }),
      (err) => err instanceof GuardRefusal && err.code === 'RECONCILIATION_LEDGER_MISSING'
    );
    assert.strictEqual(bodyReads, 0);
    assert.strictEqual(writes(client.calls).length, 0, 'no ledger/migration write may occur for unrecorded migrations');
  });

  test('26. executePlan refuses before creating the ledger table when any block exists', async () => {
    const client = makeMockClient({ recorded: [] });
    const plan = [
      { version: 'ok.sql', decision: 'EXECUTE', classification: 'PENDING_AUTHORIZED', code: 'AUTHORIZED' },
      { version: M155, decision: 'BLOCK', classification: 'BLOCKED', code: 'MIGRATION_BLOCKED' },
    ];
    await assert.rejects(
      () => executePlan({ client, plan, readFile: () => 'SELECT 1;', log: () => {} }),
      (err) => err instanceof GuardRefusal
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  for (const t of tests) {
    try {
      await t.fn();
      console.log('\u2713 ' + t.name);
      passed++;
    } catch (e) {
      console.log('\u2717 ' + t.name);
      console.log('  ' + (e && e.message));
      failed++;
    }
  }

  console.log('\nMTC-28 MIGRATION GUARD TESTS: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
