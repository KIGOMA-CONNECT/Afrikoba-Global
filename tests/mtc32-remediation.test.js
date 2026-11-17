'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'C:/tmp/r37-remediation';
const guard = require(path.join(REPO, 'scripts', 'runMigrations'));
const integrity = require(path.join(REPO, 'scripts', 'migrationIntegrity'));
const audit = require(path.join(REPO, 'scripts', 'migrationAudit'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('✓ ' + name); passed++; }
  catch (e) { console.log('✗ ' + name + ' — ' + (e && e.message)); failed++; }
}
async function atest(name, fn) {
  try { await fn(); console.log('✓ ' + name); passed++; }
  catch (e) { console.log('✗ ' + name + ' — ' + (e && e.message)); failed++; }
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mtc32-')); }

// F-01: coordinated tamper detected with anchor
test('F-01 coordinated migration+manifest rewrite detected with anchor', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '001.sql'), 'SELECT 1;\n');
  const m = integrity.buildManifest({ dir });
  fs.writeFileSync(path.join(dir, 'integrity.json'), JSON.stringify(m, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, '001.sql'), 'SELECT 1; -- tampered\n');
  integrity.writeManifest({ dir, manifestPath: path.join(dir, 'integrity.json'), authorization: 'MTC-30-G3' });
  const r = integrity.verifyIntegrity({ dir, manifestPath: path.join(dir, 'integrity.json'), expectedRootHash: m.rootHash });
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'INTEGRITY_ANCHOR_MISMATCH'));
});

// F-02: authorization.json tampering detected
test('F-02 tampered authorization.json refused by hash anchor', () => {
  const p = path.join(tmp(), 'authorization.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, defaultState: 'PENDING_UNAUTHORIZED', decisions: { 'OD-10': 'APPROVED' }, migrations: {} }));
  assert.throws(() => guard.loadAuthorization(p), (e) => e.code === 'AUTHORIZATION_TAMPERED');
});

// F-02: 155 unconditionally blocked
test('F-02 155 blocked even if OD-10 marked APPROVED in manifest', () => {
  const manifest = { version: 1, defaultState: 'PENDING_UNAUTHORIZED', decisions: { 'OD-10': 'APPROVED' }, migrations: { '155_social_fund_institution_binding.sql': { state: 'PENDING_AUTHORIZED', executionAuthorization: 'T' } } };
  const plan = guard.classifyMigrations({ files: ['155_social_fund_institution_binding.sql'], recorded: [], manifest, effects: {}, authorization: { id: 'T' } });
  assert.strictEqual(plan[0].decision, 'BLOCK');
});

// F-03: tail truncation detected with anchor
test('F-03 tail truncation detected with expectedCount', () => {
  const p = path.join(tmp(), 'audit.jsonl');
  const w = audit.createAuditWriter({ file: p, authorization: { fingerprint: null, source: 'none' } });
  w.write('run.started', {});
  w.write('run.completed', {});
  const fs2 = require('fs');
  const lines = fs2.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  fs2.writeFileSync(p, lines.slice(0, -1).join('\n') + '\n');
  const v = audit.verifyAuditLog(p, { expectedCount: 2 });
  assert.strictEqual(v.ok, false);
  assert.ok(v.violations.some((x) => x.code === 'AUDIT_TRUNCATED'));
});

// F-04: concurrent writers no longer fork
test('F-04 concurrent writers keep a valid chain', () => {
  const p = path.join(tmp(), 'audit.jsonl');
  const w1 = audit.createAuditWriter({ file: p, authorization: { fingerprint: null, source: 'none' } });
  const w2 = audit.createAuditWriter({ file: p, authorization: { fingerprint: null, source: 'none' } });
  w1.write('run.started', { w: 1 });
  w2.write('run.started', { w: 2 });
  const v = audit.verifyAuditLog(p);
  assert.strictEqual(v.ok, true);
});

// F-05: env audit path ignored by default (source check)
test('F-05 main ignores MIGRATION_AUDIT_LOG env by default (source inspection)', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'runMigrations.js'), 'utf8');
  assert.ok(!src.includes("env.MIGRATION_AUDIT_LOG || DEFAULT_AUDIT_PATH"));
});

// F-08: token not leaked
test('F-08 token not leaked in plan output', () => {
  const token = 'SECRET-TOKEN-XYZ';
  const manifest = { version: 1, defaultState: 'PENDING_UNAUTHORIZED', decisions: {}, migrations: { 'a.sql': { state: 'PENDING_AUTHORIZED', executionAuthorization: token } } };
  const plan = guard.classifyMigrations({ files: ['a.sql'], recorded: [], manifest, effects: {}, authorization: { id: token } });
  assert.ok(!guard.formatPlan(plan).includes(token));
  assert.ok(!guard.formatPreview(plan, { integrity: { checked: 0, fileCount: 0, rootHash: 'x', manifest: { files: {} } } }).includes(token));
});

// async remediation tests follow

(async () => {
  await atest('F-06 migration.applied audit failure propagates', async () => {
    const client = { calls: [], async query(s) { this.calls.push(String(s)); return { rows: [] }; }, async end() {} };
    const stub = { write(e) { if (e === 'migration.applied') { throw new Error('audit fail'); } return {}; } };
    let err = null;
    try {
      await guard.executePlan({ client, plan: [{ version: '001_a.sql', decision: 'EXECUTE', code: 'AUTHORIZED' }], readFile: () => 'SELECT 1;', audit: stub, auditRequired: true, integrity: { files: { '001_a.sql': { sha256: 'a'.repeat(64) } } } });
    } catch (e) { err = e; }
    assert.ok(err, 'expected error to propagate');
    assert.ok(client.calls.some((s) => String(s).trim() === 'COMMIT'), 'commit occurred');
  });

  await atest('F-09 executePlan refuses 155 even when marked EXECUTE', async () => {
    const client = { calls: [], async query(s) { this.calls.push(String(s)); return { rows: [] }; }, async end() {} };
    let err = null;
    try {
      await guard.executePlan({ client, plan: [{ version: '155_social_fund_institution_binding.sql', decision: 'EXECUTE', code: 'AUTHORIZED' }], readFile: () => 'SELECT 1;' });
    } catch (e) { err = e; }
    assert.ok(err, 'expected refusal');
    assert.strictEqual(client.calls.length, 0);
  });

  console.log('\\nMTC-32 REMEDIATION TESTS: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
