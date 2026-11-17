/**
 * MTC-30 / G3 — Migration governance controls acceptance, security and
 * regression tests.
 *
 * Covers:
 *   A. SHA-256 migration content integrity and tamper detection
 *   B. Genuinely non-mutating preview / dry-run
 *   C. Execution audit metadata and authorization traceability
 *
 * No PostgreSQL connection is made. No migration body is executed. Audit and
 * integrity fixtures are written to an isolated temporary directory only.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require(path.join(__dirname, '..', 'scripts', 'runMigrations'));
const integrity = require(path.join(__dirname, '..', 'scripts', 'migrationIntegrity'));
const audit = require(path.join(__dirname, '..', 'scripts', 'migrationAudit'));

const {
  GuardRefusal,
  executePlan,
  main,
  formatPreview,
  hashPlan,
  authorizationSource,
  MIGRATIONS_DIR,
  INTEGRITY_PATH,
  DEFAULT_AUDIT_PATH,
} = guard;

const {
  IntegrityRefusal,
  canonicalize,
  canonicalBytes,
  hashContent,
  buildManifest,
  verifyIntegrity,
  verifyManifestText,
  writeManifest,
  loadManifest,
  parseManifest,
  rootHashFor,
  listMigrationFiles,
} = integrity;

const {
  AuditError,
  authorizationFingerprint,
  createAuditWriter,
  verifyAuditLog,
  readAuditLog,
  hashRecord,
} = audit;

const WRITE_RE = /^\s*(BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i;
const M155 = '155_social_fund_institution_binding.sql';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMockClient({ recorded = [], failOn = null } = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params) {
      const raw = String(sql);
      const s = raw.replace(/\s+/g, ' ').trim();
      calls.push({ sql: raw, params });
      if (failOn && failOn(s, params)) throw new Error('mock failure: ' + s.slice(0, 40));
      if (/to_regclass\('public\.schema_migrations'\)/i.test(s)) {
        return { rows: [{ o: recorded.length ? 'schema_migrations' : null }] };
      }
      if (/^SELECT version FROM schema_migrations$/i.test(s)) {
        return { rows: recorded.map((version) => ({ version })) };
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

function events(calls) {
  return calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
}

async function run() {
  let passed = 0;
  let failed = 0;
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  // -------------------------------------------------------------------------
  // A. Content integrity and tamper detection
  // -------------------------------------------------------------------------

  test('1. canonicalization strips BOM and normalizes CRLF/CR to LF', () => {
    const withBomCrlf = Buffer.from('\ufeffSELECT 1;\r\nSELECT 2;\rSELECT 3;\n', 'utf8');
    assert.strictEqual(canonicalize(withBomCrlf), 'SELECT 1;\nSELECT 2;\nSELECT 3;\n');
    assert.strictEqual(canonicalBytes(withBomCrlf), Buffer.byteLength('SELECT 1;\nSELECT 2;\nSELECT 3;\n'));
  });

  test('2. canonical hash is identical for CRLF, LF and BOM variants', () => {
    const a = hashContent('CREATE TABLE t (id int);\n');
    const b = hashContent('\ufeffCREATE TABLE t (id int);\r\n');
    const c = hashContent(Buffer.from('CREATE TABLE t (id int);\r', 'utf8'));
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
    assert.strictEqual(a.length, 64);
  });

  test('3. manifest is deterministic in content and rootHash across builds', () => {
    const dir = tempDir('mtc30-det-');
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id int);\n');
    fs.writeFileSync(path.join(dir, '002_b.sql'), 'CREATE TABLE b (id int);\r\n');
    const m1 = buildManifest({ dir, now: () => new Date('2020-01-01T00:00:00Z') });
    const m2 = buildManifest({ dir, now: () => new Date('2030-12-31T23:59:59Z') });
    assert.strictEqual(m1.rootHash, m2.rootHash);
    assert.deepStrictEqual(m1.files, m2.files);
    assert.strictEqual(m1.fileCount, 2);
    assert.strictEqual(m1.algorithm, 'sha256');
    assert.strictEqual(m1.canonicalization, 'utf8-lf-no-bom');
  });

  test('4. unmodified files verify clean', () => {
    const dir = tempDir('mtc30-clean-');
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;\n');
    const manifest = buildManifest({ dir });
    const result = verifyIntegrity({ dir, manifest });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.violations, []);
    assert.strictEqual(result.checked, 1);
  });

  test('5. a modified migration is detected as MODIFIED', () => {
    const dir = tempDir('mtc30-mod-');
    const file = path.join(dir, '001_a.sql');
    fs.writeFileSync(file, 'SELECT 1;\n');
    const manifest = buildManifest({ dir });
    fs.writeFileSync(file, 'SELECT 1; -- tampered\n');
    const result = verifyIntegrity({ dir, manifest });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.violations.length, 1);
    assert.strictEqual(result.violations[0].code, 'MODIFIED');
    assert.strictEqual(result.violations[0].file, '001_a.sql');
  });

  test('6. a deleted migration is detected as MISSING', () => {
    const dir = tempDir('mtc30-missing-');
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;\n');
    const manifest = buildManifest({ dir });
    fs.unlinkSync(path.join(dir, '001_a.sql'));
    const result = verifyIntegrity({ dir, manifest });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'MISSING' && v.file === '001_a.sql'));
  });

  test('7. an unexpected added migration is detected as UNEXPECTED', () => {
    const dir = tempDir('mtc30-extra-');
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;\n');
    const manifest = buildManifest({ dir });
    fs.writeFileSync(path.join(dir, '002_rogue.sql'), 'DROP TABLE users;\n');
    const result = verifyIntegrity({ dir, manifest });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'UNEXPECTED' && v.file === '002_rogue.sql'));
  });

  test('8. an edited manifest entry without a new rootHash is detected as tampering', () => {
    const dir = tempDir('mtc30-tamper-');
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;\n');
    const manifest = buildManifest({ dir });
    manifest.files['001_a.sql'].sha256 = '0'.repeat(64);
    const result = verifyIntegrity({ dir, manifest });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'MANIFEST_TAMPERED'));
    assert.ok(result.violations.some((v) => v.code === 'MODIFIED'));
  });

  test('9. an edited fileCount is detected as manifest tampering', () => {
    const dir = tempDir('mtc30-count-');
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;\n');
    const manifest = buildManifest({ dir });
    manifest.fileCount = 2;
    const result = verifyIntegrity({ dir, manifest });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'MANIFEST_TAMPERED'));
  });

  test('10. malformed, unsupported and shape-invalid manifests are refused', () => {
    assert.throws(
      () => parseManifest('{not json', 'inline'),
      (err) => err instanceof IntegrityRefusal && err.code === 'INTEGRITY_MANIFEST_INVALID'
    );
    assert.throws(
      () => parseManifest(JSON.stringify({ schemaVersion: 99, algorithm: 'sha256', canonicalization: 'utf8-lf-no-bom', files: {} }), 'inline'),
      (err) => err.code === 'INTEGRITY_MANIFEST_INVALID'
    );
    assert.throws(
      () => parseManifest(JSON.stringify({ schemaVersion: 1, algorithm: 'md5', canonicalization: 'utf8-lf-no-bom', files: {} }), 'inline'),
      (err) => err.code === 'INTEGRITY_MANIFEST_INVALID'
    );
  });

  test('11. writing the manifest requires the explicit G3 token', () => {
    const dir = tempDir('mtc30-auth-');
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;\n');
    const target = path.join(dir, 'integrity.json');
    assert.throws(
      () => writeManifest({ dir, manifestPath: target, authorization: null }),
      (err) => err instanceof IntegrityRefusal && err.code === 'INTEGRITY_UPDATE_NOT_AUTHORIZED'
    );
    assert.throws(
      () => writeManifest({ dir, manifestPath: target, authorization: 'MTC-29-G2' }),
      (err) => err.code === 'INTEGRITY_UPDATE_NOT_AUTHORIZED'
    );
    assert.ok(!fs.existsSync(target));
  });

  test('12. authorized manifest write round-trips and verifies', () => {
    const dir = tempDir('mtc30-write-');
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;\n');
    const target = path.join(dir, 'integrity.json');
    const written = writeManifest({ dir, manifestPath: target, authorization: 'MTC-30-G3' });
    const loaded = loadManifest(target);
    assert.deepStrictEqual(loaded.files, written.files);
    assert.strictEqual(verifyIntegrity({ dir, manifestPath: target }).ok, true);
  });

  test('13. real repository manifest covers every migration and verifies', () => {
    const result = verifyIntegrity({ manifestPath: INTEGRITY_PATH });
    assert.strictEqual(result.ok, true, JSON.stringify(result.violations));
    const files = listMigrationFiles(MIGRATIONS_DIR);
    assert.strictEqual(result.fileCount, files.length);
    assert.strictEqual(result.fileCount, 163);
    assert.strictEqual(result.manifest.fileCount, files.length);
  });

  test('14. quarantined migration 155 is integrity-pinned and still BLOCKED under open OD-10', () => {
    const result = verifyIntegrity({ manifestPath: INTEGRITY_PATH });
    const entry = result.manifest.files[M155];
    assert.ok(entry, '155 must be covered by the manifest');
    assert.strictEqual(entry.sha256, '1ae142c6fb279717da3ab6129a2d295a5db6115855a33ba6a2d36a626fc13c6a');
    assert.strictEqual(entry.bytes, 1697);
    const auth = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'authorization.json'), 'utf8'));
    assert.strictEqual(auth.decisions['OD-10'], 'OPEN');
    assert.strictEqual(auth.migrations[M155].state, 'BLOCKED');
  });

  // -------------------------------------------------------------------------
  // B. Non-mutating preview / dry-run
  // -------------------------------------------------------------------------

  test('15. preview aliases are all treated as read-only and return without executing', async () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const recorded = files.filter((f) => f !== M155);
    for (const flag of ['--preview', '--dry-run', '--assess']) {
      const client = makeMockClient({ recorded });
      const result = await main({
        argv: [flag],
        files,
        manifest: guard.loadAuthorization(),
        effects: {},
        clientFactory: async () => client,
        log: () => {},
      });
      assert.strictEqual(result.preview, true, flag);
      assert.strictEqual(result.applied, 0, flag);
      assert.strictEqual(writes(client.calls).length, 0, flag + ' must not write');
    }
  });

  test('16. preview does not request database creation or schema bootstrap', async () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const recorded = files.filter((f) => f !== M155);
    let factoryArg = null;
    await main({
      argv: ['--preview'],
      files,
      manifest: guard.loadAuthorization(),
      effects: {},
      clientFactory: async (arg) => {
        factoryArg = arg;
        return makeMockClient({ recorded });
      },
      log: () => {},
    });
    assert.strictEqual(factoryArg.assess, true);
    assert.strictEqual(writes([]).length, 0);
  });

  test('17. preview returns success even when the plan contains a hard block', async () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const recorded = files.filter((f) => f !== M155);
    const result = await main({
      argv: ['--dry-run'],
      files,
      manifest: guard.loadAuthorization(),
      effects: {},
      clientFactory: async () => makeMockClient({ recorded }),
      log: () => {},
    });
    const blocked = result.plan.filter((p) => p.decision === guard.DECISION_BLOCK);
    assert.strictEqual(blocked.length, 1);
    assert.strictEqual(blocked[0].version, M155);
    assert.strictEqual(result.applied, 0);
  });

  test('18. preview output is explicit, includes would-execute hashes and states no changes', () => {
    const plan = [
      { version: '900_pending.sql', decision: guard.DECISION_EXECUTE, code: 'AUTHORIZED', decisionId: 'OD-99' },
      { version: M155, decision: guard.DECISION_BLOCK, code: 'MIGRATION_BLOCKED', decisionId: 'OD-10' },
    ];
    const text = formatPreview(plan, {
      integrity: {
        checked: 160,
        fileCount: 160,
        rootHash: 'root',
        manifest: { files: { '900_pending.sql': { sha256: 'a'.repeat(64) } } },
      },
      recorded: { versions: ['001_init.sql'] },
    });
    assert.ok(/READ-ONLY/.test(text));
    assert.ok(/No migration body is executed/.test(text));
    assert.ok(/would execute 900_pending\.sql sha256=a{64} decision=OD-99/.test(text));
    assert.ok(/No changes were made/.test(text));
    assert.ok(/rootHash=root/.test(text));
  });

  test('19. an integrity violation blocks before any client is created', async () => {
    let created = 0;
    await assert.rejects(
      () => main({
        argv: ['--preview'],
        integrity: { ok: false, violations: [{ code: 'MODIFIED', file: '155_x.sql', detail: 'hash mismatch' }] },
        clientFactory: async () => {
          created++;
          return makeMockClient();
        },
        log: () => {},
      }),
      (err) => err instanceof GuardRefusal && err.code === 'MIGRATION_INTEGRITY_VIOLATION'
    );
    assert.strictEqual(created, 0, 'no DB connection may be attempted');
  });

  test('20. a real manifest mismatch (injected path) is fail-closed', async () => {
    const dir = tempDir('mtc30-badmanifest-');
    const target = path.join(dir, 'integrity.json');
    const manifest = buildManifest({ dir }); // empty: covers zero files
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2));
    let created = 0;
    await assert.rejects(
      () => main({
        argv: ['--preview'],
        integrityPath: target,
        clientFactory: async () => {
          created++;
          return makeMockClient();
        },
        log: () => {},
      }),
      (err) => err.code === 'MIGRATION_INTEGRITY_VIOLATION'
    );
    assert.strictEqual(created, 0);
  });

  test('21. preview against the real manifest creates no audit log', async () => {
    const dir = tempDir('mtc30-noaudit-');
    const auditPath = path.join(dir, 'migration-audit.jsonl');
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const recorded = files.filter((f) => f !== M155);
    await main({
      argv: ['--preview'],
      files,
      manifest: guard.loadAuthorization(),
      effects: {},
      auditPath,
      clientFactory: async () => makeMockClient({ recorded }),
      log: () => {},
    });
    assert.ok(!fs.existsSync(auditPath), 'preview must not create the audit log');
  });

  // -------------------------------------------------------------------------
  // C. Execution audit metadata and traceability
  // -------------------------------------------------------------------------

  test('22. authorization fingerprint is a sha256 and never the raw token', () => {
    const token = 'MTC-SECRET-TOKEN-123';
    const fp = authorizationFingerprint(token);
    assert.strictEqual(fp.length, 64);
    assert.strictEqual(fp, crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(!fp.includes(token));
    assert.strictEqual(authorizationFingerprint(null), null);
  });

  test('23. authorization source is classified without exposing the token', () => {
    assert.strictEqual(authorizationSource(['--authorize=MTC-30-G3'], {}), 'argv');
    assert.strictEqual(authorizationSource([], { MIGRATION_AUTHORIZATION: 'MTC-30-G3' }), 'env');
    assert.strictEqual(authorizationSource([], {}), 'none');
  });

  test('24. audit records form a valid sha256 hash chain', () => {
    const dir = tempDir('mtc30-chain-');
    const file = path.join(dir, 'audit.jsonl');
    const writer = createAuditWriter({
      file,
      authorization: { fingerprint: authorizationFingerprint('TOKEN'), source: 'argv' },
    });
    writer.write('run.started', { mode: 'apply', planSha256: hashPlan([]) });
    writer.write('migration.started', { version: '001_a.sql', sha256: 'a'.repeat(64), decisionId: 'OD-1' });
    writer.write('migration.applied', { version: '001_a.sql', sha256: 'a'.repeat(64), decisionId: 'OD-1', durationMs: 1 });
    writer.write('run.completed', { applied: 1, failed: 0 });
    const verdict = verifyAuditLog(file);
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict.violations));
    assert.strictEqual(verdict.count, 4);
    const records = readAuditLog(file);
    assert.deepStrictEqual(records.map((r) => r.event), [
      'run.started',
      'migration.started',
      'migration.applied',
      'run.completed',
    ]);
    assert.strictEqual(records[0].prev, null);
    assert.strictEqual(records[1].prev, records[0].hash);
    assert.strictEqual(records[3].hash, verdict.lastHash);
    assert.ok(records.every((r) => r.runner && r.runner.name === 'runMigrations'));
    assert.ok(records.every((r) => r.authorization.fingerprint === authorizationFingerprint('TOKEN')));
  });

  test('25. tampering with an audit record is detected by hash and chain check', () => {
    const dir = tempDir('mtc30-audittamper-');
    const file = path.join(dir, 'audit.jsonl');
    const writer = createAuditWriter({ file, authorization: { fingerprint: null, source: 'none' } });
    writer.write('run.started', { mode: 'apply' });
    writer.write('run.completed', { applied: 0, failed: 0 });
    const records = readAuditLog(file);
    records[0].mode = 'tampered';
    records[0].hash = 'f'.repeat(64);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const verdict = verifyAuditLog(file);
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.violations.some((v) => v.code === 'AUDIT_HASH_MISMATCH'));
    assert.ok(verdict.violations.some((v) => v.code === 'AUDIT_CHAIN_BROKEN'));
  });

  test('26. removing a record from the middle breaks the chain', () => {
    const dir = tempDir('mtc30-auditdelete-');
    const file = path.join(dir, 'audit.jsonl');
    const writer = createAuditWriter({ file, authorization: { fingerprint: null, source: 'none' } });
    writer.write('run.started', {});
    writer.write('migration.started', { version: '001_a.sql' });
    writer.write('run.completed', {});
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
    const verdict = verifyAuditLog(file);
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.violations.some((v) => v.code === 'AUDIT_SEQUENCE_BROKEN'));
    assert.ok(verdict.violations.some((v) => v.code === 'AUDIT_CHAIN_BROKEN'));
  });

  test('27. the raw authorization token never appears in the audit log', () => {
    const dir = tempDir('mtc30-secret-');
    const file = path.join(dir, 'audit.jsonl');
    const token = 'MTC-30-G3-SECRET-VALUE';
    const writer = createAuditWriter({
      file,
      authorization: { fingerprint: authorizationFingerprint(token), source: 'argv' },
    });
    writer.write('run.started', { mode: 'apply' });
    writer.write('run.completed', { applied: 0, failed: 0 });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(token), 'raw token must not be persisted');
    assert.ok(text.includes(authorizationFingerprint(token)));
  });

  test('28. audit writer creates the file lazily on first write', () => {
    const dir = tempDir('mtc30-lazy-');
    const file = path.join(dir, 'nested', 'audit.jsonl');
    const writer = createAuditWriter({ file, authorization: { fingerprint: null, source: 'none' } });
    assert.ok(!fs.existsSync(file), 'writer creation must not create the log');
    writer.write('run.started', {});
    assert.ok(fs.existsSync(file));
  });

  test('29. a corrupt existing audit log refuses new writes', () => {
    const dir = tempDir('mtc30-corrupt-');
    const file = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(file, '{"seq":1,"broken":true}\n');
    assert.throws(
      () => createAuditWriter({ file, authorization: { fingerprint: null, source: 'none' } }),
      (err) => err instanceof AuditError && err.code === 'AUDIT_CHAIN_INVALID'
    );
  });

  test('30. execution refuses without an audit writer when audit is required', async () => {
    const client = makeMockClient();
    const plan = [{ version: '001_a.sql', decision: guard.DECISION_EXECUTE, code: 'AUTHORIZED', decisionId: 'OD-1' }];
    await assert.rejects(
      () => executePlan({ client, plan, readFile: () => 'SELECT 1;', log: () => {}, auditRequired: true }),
      (err) => err instanceof GuardRefusal && err.code === 'MIGRATION_AUDIT_UNAVAILABLE'
    );
    assert.strictEqual(writes(client.calls).length, 0, 'no ledger or migration write may occur');
  });

  test('31. audit is written before the ledger table is created and around each migration', async () => {
    const sequence = [];
    const client = {
      async query(sql) {
        sequence.push('sql:' + String(sql).replace(/\s+/g, ' ').trim().slice(0, 40));
        return { rows: [] };
      },
    };
    const auditStub = {
      write(event, payload) {
        sequence.push('audit:' + event);
        return { event, ...payload };
      },
    };
    const plan = [
      { version: '001_a.sql', decision: guard.DECISION_EXECUTE, code: 'AUTHORIZED', decisionId: 'OD-1' },
    ];
    await executePlan({
      client,
      plan,
      readFile: () => 'SELECT 1;',
      log: () => {},
      audit: auditStub,
      auditRequired: true,
      integrity: { files: { '001_a.sql': { sha256: 'b'.repeat(64) } } },
    });
    const iRunStarted = sequence.indexOf('audit:run.started');
    const iCreate = sequence.findIndex((s) => s.startsWith('sql:CREATE TABLE'));
    const iMigStarted = sequence.indexOf('audit:migration.started');
    const iBegin = sequence.indexOf('sql:BEGIN');
    const iCommit = sequence.indexOf('sql:COMMIT');
    const iApplied = sequence.indexOf('audit:migration.applied');
    assert.strictEqual(sequence[0], 'audit:run.started');
    assert.ok(iCreate > iRunStarted, `run.started must precede ledger creation (${sequence.join(' | ')})`);
    assert.ok(iMigStarted < iBegin, 'migration.started must precede BEGIN');
    assert.ok(iApplied > iCommit, 'migration.applied must follow COMMIT');
    assert.strictEqual(sequence[sequence.length - 1], 'audit:run.completed');
  });

  test('32. audit metadata carries version, sha256, decision id and plan hash', async () => {
    const seen = [];
    const client = { async query() { return { rows: [] }; } };
    const auditStub = { write(event, payload) { seen.push({ event, payload }); return {}; } };
    const plan = [
      { version: '001_a.sql', decision: guard.DECISION_EXECUTE, code: 'AUTHORIZED', decisionId: 'OD-1' },
    ];
    await executePlan({
      client,
      plan,
      readFile: () => 'SELECT 1;',
      log: () => {},
      audit: auditStub,
      auditRequired: true,
      integrity: { files: { '001_a.sql': { sha256: 'c'.repeat(64) } } },
    });
    const started = seen.find((s) => s.event === 'migration.started');
    assert.strictEqual(started.payload.version, '001_a.sql');
    assert.strictEqual(started.payload.sha256, 'c'.repeat(64));
    assert.strictEqual(started.payload.decisionId, 'OD-1');
    const runStarted = seen.find((s) => s.event === 'run.started');
    assert.strictEqual(runStarted.payload.planSha256, hashPlan(plan));
  });

  test('33. a failed migration writes migration.failed and no run.completed', async () => {
    const seen = [];
    const client = {
      async query(sql) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^SELECT explode/.test(s)) {
          const err = new Error('syntax error');
          err.code = '42601';
          throw err;
        }
        return { rows: [] };
      },
    };
    const auditStub = { write(event, payload) { seen.push({ event, payload }); return {}; } };
    const plan = [{ version: '001_bad.sql', decision: guard.DECISION_EXECUTE, code: 'AUTHORIZED', decisionId: 'OD-1' }];
    await assert.rejects(
      () => executePlan({
        client,
        plan,
        readFile: () => 'SELECT explode;',
        log: () => {},
        audit: auditStub,
        auditRequired: true,
      }),
      /syntax error/
    );
    assert.ok(seen.some((s) => s.event === 'migration.failed' && s.payload.errorCode === '42601'));
    assert.ok(!seen.some((s) => s.event === 'run.completed'));
  });

  test('34. hashPlan is deterministic and sensitive to decision changes', () => {
    const a = [{ version: '001_a.sql', decision: 'EXECUTE', code: 'AUTHORIZED', decisionId: 'OD-1' }];
    const b = [{ version: '001_a.sql', decision: 'EXECUTE', code: 'AUTHORIZED', decisionId: 'OD-1' }];
    const c = [{ version: '001_a.sql', decision: 'BLOCK', code: 'MIGRATION_BLOCKED', decisionId: 'OD-10' }];
    assert.strictEqual(hashPlan(a), hashPlan(b));
    assert.notStrictEqual(hashPlan(a), hashPlan(c));
    assert.strictEqual(hashPlan(a).length, 64);
  });

  test('35. audit verification of an empty or absent log is clean', () => {
    const dir = tempDir('mtc30-empty-');
    const verdict = verifyAuditLog(path.join(dir, 'absent.jsonl'));
    assert.deepStrictEqual(verdict, { ok: true, count: 0, lastHash: null, violations: [] });
  });

  test('36. record hash is independent of key order but sensitive to value changes', () => {
    const base = { a: 1, b: 'x', nested: { y: 2, z: 3 } };
    const reordered = { nested: { z: 3, y: 2 }, b: 'x', a: 1 };
    assert.strictEqual(hashRecord(base), hashRecord(reordered));
    assert.notStrictEqual(hashRecord(base), hashRecord({ ...base, a: 2 }));
    assert.notStrictEqual(hashRecord(base), hashRecord({ ...base, nested: { y: 2, z: 4 } }));
  });

  // -------------------------------------------------------------------------
  // Regression / acceptance guards
  // -------------------------------------------------------------------------

  test('37. default audit path is local and gitignored', () => {
    assert.strictEqual(path.basename(DEFAULT_AUDIT_PATH), 'migration-audit.jsonl');
    assert.ok(DEFAULT_AUDIT_PATH.includes(path.join('logs')));
    const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert.ok(/^logs\/$/m.test(ignore), 'logs/ must be gitignored');
  });

  test('38. integrity verification never executes or mutates a migration file', () => {
    const dir = tempDir('mtc30-readonly-');
    const file = path.join(dir, '001_a.sql');
    fs.writeFileSync(file, 'CREATE TABLE t (id int);\n');
    const manifest = buildManifest({ dir });
    const statBefore = fs.statSync(file);
    const bytesBefore = fs.readFileSync(file);
    verifyIntegrity({ dir, manifest });
    const statAfter = fs.statSync(file);
    assert.deepStrictEqual(fs.readFileSync(file), bytesBefore);
    assert.strictEqual(statAfter.size, statBefore.size);
    assert.strictEqual(statAfter.mtimeMs, statBefore.mtimeMs);
    assert.ok(!fs.existsSync(path.join(dir, 'schema_migrations')));
  });

  test('39. preview does not create schema_migrations even when the mock has no ledger', async () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const client = makeMockClient({ recorded: [] });
    const result = await main({
      argv: ['--preview'],
      files,
      manifest: guard.loadAuthorization(),
      effects: {},
      clientFactory: async () => client,
      log: () => {},
    });
    assert.strictEqual(result.applied, 0);
    assert.strictEqual(writes(client.calls).length, 0);
    assert.ok(!events(client.calls).some((s) => /CREATE TABLE/i.test(s)));
  });

  test('40. MTC-30 controls introduce no migration execution in the test path', () => {
    const dir = tempDir('mtc30-noexec-');
    const file = path.join(dir, '001_a.sql');
    fs.writeFileSync(file, 'DROP TABLE users;\n');
    const manifest = buildManifest({ dir });
    const result = verifyIntegrity({ dir, manifest });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(file), 'verification must not remove the file');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'DROP TABLE users;\n');
  });

  test('41. a missing integrity manifest is refused before any client creation', async () => {
    const dir = tempDir('mtc30-nomanifest-');
    let created = 0;
    await assert.rejects(
      () => main({
        argv: ['--preview'],
        integrityPath: path.join(dir, 'does-not-exist.json'),
        clientFactory: async () => {
          created++;
          return makeMockClient();
        },
        log: () => {},
      }),
      (err) => err instanceof IntegrityRefusal && err.code === 'INTEGRITY_MANIFEST_MISSING'
    );
    assert.strictEqual(created, 0);
  });

  for (const t of tests) {
    try {
      await t.fn();
      console.log('\u2713 ' + t.name);
      passed++;
    } catch (e) {
      console.log('\u2717 ' + t.name);
      console.log('  ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n  ') : e));
      failed++;
    }
  }

  console.log('\nMTC-30 MIGRATION GOVERNANCE TESTS: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
