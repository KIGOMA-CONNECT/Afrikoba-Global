'use strict';

/**
 * MTC-29 / G2 — Controlled ledger reconciliation tests.
 *
 * Deterministic unit/integration tests with an in-memory mock ledger client.
 * No PostgreSQL connection is made and no migration body is read or executed.
 * The mock records every query so writes can be asserted exactly.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const guard = require(path.join(__dirname, '..', 'scripts', 'runMigrations'));
const recon = require(path.join(__dirname, '..', 'scripts', 'reconcileMigrations'));

const {
  RECONCILIATION_ALLOWLIST,
  RECONCILIATION_SET,
  RECONCILIATION_AUTHORIZATION,
  M155,
  EVIDENCE_SPEC,
  QUARANTINE_CHECKS,
  ReconciliationRefusal,
  evaluateEvidence,
  validateTargets,
  reconcileLedger,
  resolveReconciliationAuthorization,
} = recon;

const WRITE_RE = /^\s*(BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i;

function evidenceFor(files, overrides = {}) {
  const evidence = {
    quarantine: QUARANTINE_CHECKS.map((c) => ({ id: c.id, ok: true, detail: 'ok' })),
    files: {},
  };
  for (const file of files) {
    evidence.files[file] = EVIDENCE_SPEC[file].map((c) => {
      const forced = overrides[file] && overrides[file][c.id];
      return { id: c.id, ok: forced === undefined ? true : forced, detail: forced === undefined ? 'ok' : 'forced failure' };
    });
  }
  return evidence;
}

function makeLedgerClient({ versions = [], tableExists = true, failOn = null, injectOnInsert = null } = {}) {
  const calls = [];
  const state = new Set(versions);
  let committed = new Set(versions);
  const client = {
    calls,
    getCommitted() {
      return [...committed].sort();
    },
    async query(sql, params) {
      const raw = String(sql);
      const s = raw.replace(/\s+/g, ' ').trim();
      calls.push({ sql: raw, params });
      if (failOn && failOn(s, params)) throw new Error('mock failure: ' + s.slice(0, 48));

      if (/to_regclass\('public\.schema_migrations'\)/i.test(s)) {
        return { rows: [{ o: tableExists ? 'schema_migrations' : null }] };
      }
      if (/^SELECT version FROM schema_migrations$/i.test(s)) {
        return { rows: [...state].sort().map((version) => ({ version })) };
      }
      if (/^BEGIN$/i.test(s)) return { rows: [] };
      if (/^COMMIT$/i.test(s)) {
        committed = new Set(state);
        return { rows: [] };
      }
      if (/^ROLLBACK$/i.test(s)) {
        state.clear();
        for (const v of committed) state.add(v);
        return { rows: [] };
      }
      if (/^INSERT INTO schema_migrations \(version\) VALUES \(\$1\)$/i.test(s)) {
        if (state.has(params[0])) throw new Error('duplicate key value violates unique constraint');
        state.add(params[0]);
        if (injectOnInsert) {
          state.add(injectOnInsert);
          injectOnInsert = null;
        }
        return { rows: [] };
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

function inserts(calls) {
  return calls.filter((c) => /^\s*INSERT\s+INTO\s+schema_migrations/i.test(c.sql));
}

function baseVersions() {
  return ['001_init.sql', '150_social_fund_idempotency.sql', '151_gov_an_immutable_analytics_snapshots.sql'];
}

async function run() {
  let passed = 0;
  let failed = 0;
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  // -------------------------------------------------------------------------
  // Allowlist and target validation
  // -------------------------------------------------------------------------

  test('1. allowlist is exactly 152, 153 and 154 and excludes 155', () => {
    assert.deepStrictEqual(RECONCILIATION_SET, [
      '152_social_fund_case_permissions.sql',
      '153_social_fund_clearing_account.sql',
      '154_journal_posting_registry.sql',
    ]);
    assert.ok(!RECONCILIATION_SET.includes(M155));
  });

  test('2. validateTargets accepts the authorized set', () => {
    assert.doesNotThrow(() => validateTargets(RECONCILIATION_SET));
  });

  test('3. reconciliation of 155 is refused before any write', async () => {
    const client = makeLedgerClient({ versions: baseVersions() });
    await assert.rejects(
      () => reconcileLedger({ client, files: [M155], evidence: evidenceFor(RECONCILIATION_SET), apply: true, authorization: { id: RECONCILIATION_AUTHORIZATION }, log: () => {} }),
      (err) => err instanceof ReconciliationRefusal && err.code === 'RECONCILIATION_155_FORBIDDEN'
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('4. a mixed set containing 155 is refused entirely', async () => {
    const client = makeLedgerClient({ versions: baseVersions() });
    await assert.rejects(
      () => reconcileLedger({ client, files: [...RECONCILIATION_SET, M155], evidence: evidenceFor(RECONCILIATION_SET), apply: true, authorization: { id: RECONCILIATION_AUTHORIZATION }, log: () => {} }),
      (err) => err instanceof ReconciliationRefusal && err.code === 'RECONCILIATION_155_FORBIDDEN'
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('5. any non-allowlisted migration is refused', () => {
    assert.throws(
      () => validateTargets(['156_not_authorized.sql']),
      (err) => err.code === 'RECONCILIATION_FILE_NOT_ALLOWED'
    );
    assert.throws(
      () => validateTargets(['151_gov_an_immutable_analytics_snapshots.sql']),
      (err) => err.code === 'RECONCILIATION_FILE_NOT_ALLOWED'
    );
  });

  test('6. empty and duplicate target sets are refused', () => {
    assert.throws(() => validateTargets([]), (err) => err.code === 'RECONCILIATION_NO_TARGETS');
    assert.throws(
      () => validateTargets([RECONCILIATION_SET[0], RECONCILIATION_SET[0]]),
      (err) => err.code === 'RECONCILIATION_DUPLICATE_TARGET'
    );
  });

  // -------------------------------------------------------------------------
  // Evidence gate
  // -------------------------------------------------------------------------

  test('7. complete evidence passes the gate', () => {
    const verdict = evaluateEvidence(evidenceFor(RECONCILIATION_SET), RECONCILIATION_SET);
    assert.strictEqual(verdict.complete, true);
    assert.deepStrictEqual(verdict.missing, []);
  });

  test('8. any failed check blocks the gate', () => {
    const evidence = evidenceFor(RECONCILIATION_SET, {
      '154_journal_posting_registry.sql': { 'trigger:partitions': false },
    });
    const verdict = evaluateEvidence(evidence, RECONCILIATION_SET);
    assert.strictEqual(verdict.complete, false);
    assert.ok(verdict.missing.some((m) => m.check === 'trigger:partitions'));
  });

  test('9. partial evidence (missing check) blocks the gate', () => {
    const evidence = evidenceFor(RECONCILIATION_SET);
    evidence.files['152_social_fund_case_permissions.sql'] =
      evidence.files['152_social_fund_case_permissions.sql'].slice(0, 2);
    const verdict = evaluateEvidence(evidence, RECONCILIATION_SET);
    assert.strictEqual(verdict.complete, false);
    assert.ok(verdict.missing.some((m) => m.detail === 'check missing'));
  });

  test('10. 155 quarantine drift blocks the gate', () => {
    const evidence = evidenceFor(RECONCILIATION_SET);
    evidence.quarantine = evidence.quarantine.map((c) => ({ ...c, ok: false, detail: 'institution_id present' }));
    const verdict = evaluateEvidence(evidence, RECONCILIATION_SET);
    assert.strictEqual(verdict.complete, false);
    assert.ok(verdict.missing.some((m) => m.file === '__quarantine__'));
  });

  test('11. insufficient evidence refuses reconciliation with zero writes', async () => {
    const client = makeLedgerClient({ versions: baseVersions() });
    const evidence = evidenceFor(RECONCILIATION_SET, {
      '153_social_fund_clearing_account.sql': { 'seed:social_fund_clearing': false },
    });
    await assert.rejects(
      () => reconcileLedger({ client, files: RECONCILIATION_SET, evidence, apply: true, authorization: { id: RECONCILIATION_AUTHORIZATION }, log: () => {} }),
      (err) => err instanceof ReconciliationRefusal && err.code === 'RECONCILIATION_EVIDENCE_INSUFFICIENT'
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  // -------------------------------------------------------------------------
  // Dry run / authorization
  // -------------------------------------------------------------------------

  test('12. dry run performs no writes and reports the three targets', async () => {
    const client = makeLedgerClient({ versions: baseVersions() });
    const result = await reconcileLedger({ client, files: RECONCILIATION_SET, evidence: evidenceFor(RECONCILIATION_SET), apply: false, log: () => {} });
    assert.strictEqual(result.mode, 'assess');
    assert.strictEqual(result.applied, 0);
    assert.deepStrictEqual(result.targets, RECONCILIATION_SET);
    assert.deepStrictEqual(result.skipped, []);
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('13. apply without a token is refused before any write', async () => {
    const client = makeLedgerClient({ versions: baseVersions() });
    await assert.rejects(
      () => reconcileLedger({ client, files: RECONCILIATION_SET, evidence: evidenceFor(RECONCILIATION_SET), apply: true, authorization: { id: null }, log: () => {} }),
      (err) => err.code === 'RECONCILIATION_NOT_AUTHORIZED'
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('14. apply with a wrong token is refused', async () => {
    const client = makeLedgerClient({ versions: baseVersions() });
    await assert.rejects(
      () => reconcileLedger({ client, files: RECONCILIATION_SET, evidence: evidenceFor(RECONCILIATION_SET), apply: true, authorization: { id: 'MTC-28-G1' }, log: () => {} }),
      (err) => err.code === 'RECONCILIATION_NOT_AUTHORIZED'
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('15. token resolution reads argv, env and defaults to none', () => {
    assert.deepStrictEqual(resolveReconciliationAuthorization([`--authorization=${RECONCILIATION_AUTHORIZATION}`], {}), { id: RECONCILIATION_AUTHORIZATION });
    assert.deepStrictEqual(resolveReconciliationAuthorization([], { MTC29_AUTHORIZATION: RECONCILIATION_AUTHORIZATION }), { id: RECONCILIATION_AUTHORIZATION });
    assert.deepStrictEqual(resolveReconciliationAuthorization([], {}), { id: null });
  });

  // -------------------------------------------------------------------------
  // Apply semantics
  // -------------------------------------------------------------------------

  test('16. authorized apply inserts exactly the three rows in one transaction', async () => {
    const client = makeLedgerClient({ versions: baseVersions() });
    const result = await reconcileLedger({
      client,
      files: RECONCILIATION_SET,
      evidence: evidenceFor(RECONCILIATION_SET),
      apply: true,
      authorization: { id: RECONCILIATION_AUTHORIZATION },
      log: () => {},
    });
    assert.strictEqual(result.mode, 'apply');
    assert.strictEqual(result.applied, 3);
    assert.strictEqual(result.recordedBefore.length, 3);
    assert.strictEqual(result.recordedAfter.length, 6);
    assert.deepStrictEqual(inserts(client.calls).map((c) => c.params[0]), RECONCILIATION_SET);
    const seq = client.calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    const iBegin = seq.indexOf('BEGIN');
    const iCommit = seq.indexOf('COMMIT');
    assert.ok(iBegin >= 0 && iCommit > iBegin, 'BEGIN before COMMIT');
    assert.ok(seq.indexOf('ROLLBACK') === -1, 'no rollback on success');
    assert.deepStrictEqual(client.getCommitted(), [...baseVersions(), ...RECONCILIATION_SET].sort());
    assert.ok(!client.getCommitted().includes(M155));
  });

  test('17. fully reconciled state is idempotent and performs no writes', async () => {
    const versions = [...baseVersions(), ...RECONCILIATION_SET];
    const client = makeLedgerClient({ versions });
    const result = await reconcileLedger({
      client,
      files: RECONCILIATION_SET,
      evidence: evidenceFor(RECONCILIATION_SET),
      apply: true,
      authorization: { id: RECONCILIATION_AUTHORIZATION },
      log: () => {},
    });
    assert.strictEqual(result.applied, 0);
    assert.deepStrictEqual(result.targets, []);
    assert.deepStrictEqual(result.skipped, RECONCILIATION_SET);
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('18. already-recorded targets are skipped; only missing rows are inserted', async () => {
    const versions = [...baseVersions(), '152_social_fund_case_permissions.sql'];
    const client = makeLedgerClient({ versions });
    const result = await reconcileLedger({
      client,
      files: RECONCILIATION_SET,
      evidence: evidenceFor(RECONCILIATION_SET),
      apply: true,
      authorization: { id: RECONCILIATION_AUTHORIZATION },
      log: () => {},
    });
    assert.strictEqual(result.applied, 2);
    assert.deepStrictEqual(result.skipped, ['152_social_fund_case_permissions.sql']);
    assert.deepStrictEqual(inserts(client.calls).map((c) => c.params[0]), [
      '153_social_fund_clearing_account.sql',
      '154_journal_posting_registry.sql',
    ]);
  });

  test('19. a 155 ledger row is treated as quarantine drift and refused', async () => {
    const client = makeLedgerClient({ versions: [...baseVersions(), M155] });
    await assert.rejects(
      () => reconcileLedger({ client, files: RECONCILIATION_SET, evidence: evidenceFor(RECONCILIATION_SET), apply: true, authorization: { id: RECONCILIATION_AUTHORIZATION }, log: () => {} }),
      (err) => err.code === 'RECONCILIATION_155_RECORDED'
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('20. missing schema_migrations is refused (G2 creates nothing)', async () => {
    const client = makeLedgerClient({ versions: [], tableExists: false });
    await assert.rejects(
      () => reconcileLedger({ client, files: RECONCILIATION_SET, evidence: evidenceFor(RECONCILIATION_SET), apply: false, log: () => {} }),
      (err) => err.code === 'RECONCILIATION_LEDGER_MISSING'
    );
    assert.strictEqual(writes(client.calls).length, 0);
  });

  test('21. insert failure rolls back and does not commit', async () => {
    const client = makeLedgerClient({
      versions: baseVersions(),
      failOn: (s) => /^INSERT INTO schema_migrations/i.test(s),
    });
    await assert.rejects(
      () => reconcileLedger({ client, files: RECONCILIATION_SET, evidence: evidenceFor(RECONCILIATION_SET), apply: true, authorization: { id: RECONCILIATION_AUTHORIZATION }, log: () => {} }),
      /mock failure/
    );
    const seq = client.calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    assert.ok(seq.includes('ROLLBACK'), 'must roll back');
    assert.ok(!seq.includes('COMMIT'), 'must not commit');
    assert.deepStrictEqual(client.getCommitted(), baseVersions().sort());
  });

  test('22. an unrelated ledger change during apply triggers drift rollback', async () => {
    const client = makeLedgerClient({ versions: baseVersions(), injectOnInsert: '999_unrelated.sql' });
    await assert.rejects(
      () => reconcileLedger({ client, files: RECONCILIATION_SET, evidence: evidenceFor(RECONCILIATION_SET), apply: true, authorization: { id: RECONCILIATION_AUTHORIZATION }, log: () => {} }),
      (err) => err.code === 'RECONCILIATION_LEDGER_DRIFT'
    );
    const seq = client.calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    assert.ok(seq.includes('ROLLBACK'), 'drift must roll back');
    assert.ok(!seq.includes('COMMIT'), 'drift must not commit');
    assert.deepStrictEqual(client.getCommitted(), baseVersions().sort());
  });

  test('23. reconciliation never reads or executes a migration body', async () => {
    const original = fs.readFileSync;
    const hits = [];
    fs.readFileSync = function (target, ...args) {
      if (String(target).endsWith('.sql') || String(target).includes(path.join('db', 'migrations'))) {
        hits.push(String(target));
        throw new Error('migration body access is forbidden under G2');
      }
      return original.apply(fs, [target, ...args]);
    };
    try {
      const client = makeLedgerClient({ versions: baseVersions() });
      const result = await reconcileLedger({
        client,
        files: RECONCILIATION_SET,
        evidence: evidenceFor(RECONCILIATION_SET),
        apply: true,
        authorization: { id: RECONCILIATION_AUTHORIZATION },
        log: () => {},
      });
      assert.strictEqual(result.applied, 3);
    } finally {
      fs.readFileSync = original;
    }
    assert.deepStrictEqual(hits, []);
  });

  // -------------------------------------------------------------------------
  // Interaction with the G1 guard
  // -------------------------------------------------------------------------

  test('24. after reconciliation the guard skips 152-154 and still blocks 155', () => {
    const files = [...RECONCILIATION_SET, M155];
    const manifest = {
      version: 1,
      defaultState: 'PENDING_UNAUTHORIZED',
      decisions: { 'OD-10': 'OPEN' },
      migrations: {
        '152_social_fund_case_permissions.sql': { state: 'RECONCILED' },
        '153_social_fund_clearing_account.sql': { state: 'RECONCILED' },
        '154_journal_posting_registry.sql': { state: 'RECONCILED' },
        [M155]: { state: 'BLOCKED', decision: 'OD-10' },
      },
    };
    const plan = guard.classifyMigrations({ files, recorded: [...baseVersions(), ...RECONCILIATION_SET], manifest, effects: {} });
    const byVersion = Object.fromEntries(plan.map((p) => [p.version, p]));
    for (const file of RECONCILIATION_SET) {
      assert.strictEqual(byVersion[file].decision, 'SKIP', file + ' must be skipped');
      assert.strictEqual(byVersion[file].code, 'APPLIED_TRACKED');
    }
    assert.strictEqual(byVersion[M155].decision, 'BLOCK');
    assert.strictEqual(byVersion[M155].code, 'MIGRATION_BLOCKED');
    assert.strictEqual(byVersion[M155].decisionId, 'OD-10');
  });

  test('25. RECONCILED without a ledger row blocks as ambiguous (never re-executes)', () => {
    const manifest = {
      version: 1,
      defaultState: 'PENDING_UNAUTHORIZED',
      decisions: { 'OD-10': 'OPEN' },
      migrations: { '152_social_fund_case_permissions.sql': { state: 'RECONCILED' } },
    };
    const plan = guard.classifyMigrations({ files: ['152_social_fund_case_permissions.sql'], recorded: [], manifest, effects: {} });
    assert.strictEqual(plan[0].decision, 'BLOCK');
    assert.strictEqual(plan[0].code, 'RECONCILIATION_LEDGER_MISSING');
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

  console.log('\nMTC-29 LEDGER RECONCILIATION TESTS: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
