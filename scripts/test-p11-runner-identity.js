/* ============================================================
 * AFRIKOBA GLOBAL - P1.1 MIGRATION RUNNER IDENTITY ASSURANCE
 * Exercises scripts/runMigrations.js through a pg preload stub. Proves:
 *  - maintenance identity mismatch refuses before CREATE DATABASE
 *  - target identity mismatch refuses before schema or migration SQL, and is not retried
 *  - target is created with a quoted, validated identifier before target identity checks
 *  - target identity is verified before schema.sql and migrations
 *  - invalid and denylisted targets refuse before any connection
 *  - credential fallback is used only after auth failure and passes the same identity checks
 *  - identity refusals are not retried across credential candidates
 * The stub performs no real writes. Ordering is verified from the recorded SQL log.
 * ============================================================ */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'test-p11-pg-identity-stub.js');
const RUNNER = 'scripts/runMigrations.js';
const TARGET = 'phase68_amount_guard_test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11run-'));

let passed = 0;
let failed = 0;
const failures = [];
function expect(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
}

function runCase(name, overrides) {
  const log = path.join(dir, name.replace(/[^a-z0-9]+/gi, '_') + '.log');
  const env = {
    ...process.env,
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'primaryuser',
    DB_PASSWORD: 'secret',
    DB_NAME: TARGET,
    PHASE68_TEST_DB: TARGET,
    P11_STUB_LOG: log,
    P11_HALT_ON_MIGRATIONS: '1',
    P11_TARGET_EXISTS: '1',
    P11_FAIL_TARGET_CONNECTS: '0',
    P11_FAKE_CURRENT_DB: '',
    P11_FAKE_ON: 'any',
    ...overrides,
  };
  const r = spawnSync(process.execPath, ['-r', STUB, RUNNER], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, lines };
}

const idx = (lines, pred, from = 0) => {
  for (let i = from; i < lines.length; i++) if (pred(lines[i])) return i;
  return -1;
};
const isCreate = (l) => l.startsWith('SQL CREATE DATABASE');
const isTargetConnect = (l) => l === `CONNECT ${TARGET} user=primaryuser` || l.startsWith(`CONNECT ${TARGET} `);
const isWriteDdl = (l) => /^SQL (CREATE TABLE|INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)/.test(l) && !/CREATE DATABASE/.test(l);

console.log('== R1 maintenance identity mismatch ==');
{
  const r = runCase('R1 maintenance mismatch', { P11_FAKE_CURRENT_DB: 'afrikoba_global', P11_FAKE_ON: 'postgres', P11_TARGET_EXISTS: '0' });
  expect(r.status !== 0 && /REFUSING/.test(r.out) && /maintenance/.test(r.out), 'refuses with maintenance-identity message, non-zero exit', { status: r.status, out: r.out.slice(0, 200) });
  expect(idx(r.lines, isCreate) === -1, 'no CREATE DATABASE issued', r.lines.filter(isCreate));
  expect(idx(r.lines, isTargetConnect) === -1, 'no connection to target attempted', r.lines.slice(0, 5));
}

console.log('\n== R2 target identity mismatch (after CREATE) ==');
{
  const r = runCase('R2 target mismatch', { P11_FAKE_CURRENT_DB: 'afrikoba_global', P11_FAKE_ON: TARGET, P11_TARGET_EXISTS: '0' });
  const createIdx = idx(r.lines, isCreate);
  const createSql = createIdx >= 0 ? r.lines[createIdx] : '';
  expect(createIdx >= 0 && createSql === `SQL CREATE DATABASE "${TARGET}"`, 'CREATE DATABASE issued with quoted validated identifier', createSql);
  expect(r.status !== 0 && /REFUSING/.test(r.out) && /target/.test(r.out), 'refuses with target-identity message, non-zero exit', { status: r.status, out: r.out.slice(0, 200) });
  const targetConnects = r.lines.filter(isTargetConnect).length;
  expect(targetConnects === 1, 'identity refusal is not retried (exactly one target connection)', targetConnects);
  expect(idx(r.lines, (l) => /to_regclass|schema_migrations/.test(l)) === -1, 'no schema.sql check or migration DDL after target mismatch', r.lines.filter((l) => /to_regclass|schema_migrations/.test(l)));
  expect(!r.lines.some(isWriteDdl), 'no write statements on the mismatched target', r.lines.filter(isWriteDdl).slice(0, 3));
}

console.log('\n== R3 positive ordering: CREATE -> target connect -> identity -> schema check -> migrations ==');
{
  const r = runCase('R3 positive ordering', { P11_TARGET_EXISTS: '0' });
  const cIdx = idx(r.lines, isCreate);
  const tIdx = idx(r.lines, isTargetConnect, cIdx + 1);
  const iIdx = idx(r.lines, (l) => l.startsWith('SQL SELECT current_database'), tIdx + 1);
  const sIdx = idx(r.lines, (l) => /to_regclass/.test(l), iIdx + 1);
  const mIdx = idx(r.lines, (l) => /CREATE TABLE IF NOT EXISTS schema_migrations/.test(l), sIdx + 1);
  expect(cIdx >= 0 && tIdx > cIdx && iIdx > tIdx && sIdx > iIdx && mIdx > sIdx, 'statement order is CREATE < target connect < identity check < schema check < migration DDL', { cIdx, tIdx, iIdx, sIdx, mIdx });
  expect(/Identity verified: phase68_amount_guard_test/.test(r.out), 'runner reports verified target identity');
  expect(/P11_HALT/.test(r.out), 'run halted at migration DDL marker (test end point), as designed');
  const maintIdentity = r.lines.findIndex((l) => l.startsWith('CONNECT postgres'));
  expect(maintIdentity >= 0 && maintIdentity < cIdx, 'maintenance connection to postgres precedes CREATE', { maintIdentity, cIdx });
}

console.log('\n== R4 invalid target identifiers refuse before any connection ==');
for (const bad of ['phase68_amount_guard_x";DROP DATABASE postgres;--', 'Phase68 Guard', 'phase68_amount_guard_x-y']) {
  const r = runCase('R4 invalid ' + bad, { DB_NAME: bad, PHASE68_TEST_DB: bad });
  expect(r.status !== 0 && /REFUSING/.test(r.out) && r.lines.length === 0, `invalid identifier "${bad}" refused with no connection`, { status: r.status, lines: r.lines.slice(0, 3) });
}

console.log('\n== R5 denylisted target refuses before any connection ==');
{
  const r = runCase('R5 denylisted', { DB_NAME: 'phase68_guard', PHASE68_TEST_DB: 'phase68_guard' });
  expect(r.status !== 0 && /REFUSING/.test(r.out) && r.lines.length === 0, 'phase68_guard refused with no connection', { status: r.status, lines: r.lines.slice(0, 3) });
}

console.log('\n== R6 credential fallback after auth failure: same identity check, migration proceeds to halt ==');
{
  const r = runCase('R6 fallback ok', { P11_FAIL_TARGET_CONNECTS: '1' });
  const failIdx = idx(r.lines, (l) => l.startsWith('CONNECT_FAILED ' + TARGET));
  const okIdx = idx(r.lines, (l) => l.startsWith('CONNECT ' + TARGET + ' user=afrikoba'), failIdx + 1);
  const iIdx = idx(r.lines, (l) => l.startsWith('SQL SELECT current_database'), okIdx + 1);
  expect(failIdx >= 0 && okIdx > failIdx, 'primary credential failed auth, fallback-app credential connected', { failIdx, okIdx });
  expect(iIdx > okIdx && /credential 'fallback-app'/.test(r.out), 'fallback connection passed identity check before schema/migrations', { iIdx });
  expect(/P11_HALT/.test(r.out), 'fallback path reached migration marker');
}

console.log('\n== R7 fallback credential connects to a mismatched database: refused, not migrated ==');
{
  const r = runCase('R7 fallback mismatch', { P11_FAIL_TARGET_CONNECTS: '1', P11_FAKE_CURRENT_DB: 'afrikoba_global', P11_FAKE_ON: TARGET });
  expect(r.status !== 0 && /REFUSING/.test(r.out) && /target/.test(r.out), 'fallback identity mismatch refused', { status: r.status, out: r.out.slice(0, 200) });
  expect(idx(r.lines, (l) => /to_regclass|schema_migrations/.test(l)) === -1, 'no schema or migration statements on refused fallback', r.lines.filter((l) => /to_regclass|schema_migrations/.test(l)));
  const furtherCandidates = r.lines.filter((l) => l.startsWith('CONNECT ' + TARGET + ' user=postgres'));
  expect(!/Credential 'fallback-app' not usable/.test(r.out) && furtherCandidates.length === 0, 'identity refusal on fallback-app is not followed by fallback-superuser retry', { furtherCandidates });
}

console.log('\n== R8 maintenance identity refusal is not retried with fallback credentials ==');
{
  const r = runCase('R8 maintenance no fallback', { P11_FAKE_CURRENT_DB: 'afrikoba_global', P11_FAKE_ON: 'postgres', P11_TARGET_EXISTS: '0' });
  const maintConnects = r.lines.filter((l) => l.startsWith('CONNECT postgres'));
  expect(r.status !== 0 && /REFUSING/.test(r.out) && maintConnects.length === 1 && maintConnects[0].includes('user=primaryuser'), 'refusal stops at first maintenance credential (exactly one maintenance connection, no fallback retry)', maintConnects);
}

console.log(`\nP1.1 MIGRATION RUNNER IDENTITY ASSURANCE: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(failed === 0 ? 0 : 1);
