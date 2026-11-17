/* ============================================================
 * AFRIKOBA GLOBAL - P1.1 DATABASE IDENTITY NEGATIVE TESTS
 * Runs each write-capable entry point as a child process with unsafe
 * configuration and proves the refusal (exit code and message) happens
 * before any database connection or write. Connected-identity mismatch
 * is simulated with a pg preload stub that records every SQL statement.
 * No real database is written by this suite.
 * ============================================================ */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'test-p11-pg-identity-stub.js');
const ENTRIES = [
  { file: 'scripts/test-saccos-savings.js', suite: true },
  { file: 'scripts/test-saccos-funds.js', suite: true },
  { file: 'scripts/test-p12-withdrawal-idempotency.js', suite: true },
  { file: 'scripts/test-p14-loanloss-concurrency.js', suite: true },
  { file: 'scripts/runMigrations.js', suite: false },
];
const WRITE_SQL = /^\s*(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i;

let passed = 0;
let failed = 0;
const failures = [];
function expect(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

function baseEnv() {
  const env = { ...process.env };
  delete env.PHASE68_TEST_DB;
  delete env.DB_NAME;
  delete env.P11_STUB_LOG;
  delete env.P11_FAKE_CURRENT_DB;
  // Unreachable endpoint: if a guard ran late it would surface as ECONNREFUSED instead of REFUSING.
  env.DB_HOST = '127.0.0.1';
  env.DB_PORT = '1';
  env.DB_USER = 'postgres';
  env.DB_PASSWORD = 'secret';
  env.SACCOS_TEST_BASE = 'http://127.0.0.1:1';
  return env;
}

function run(file, env, preload) {
  const args = preload ? ['-r', preload, file] : [file];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const NEGATIVE_CASES = [
  { name: 'missing PHASE68_TEST_DB', env: { DB_NAME: 'phase68_amount_guard_test' } },
  { name: 'missing DB_NAME', env: { PHASE68_TEST_DB: 'phase68_amount_guard_test' } },
  { name: 'configured DB mismatch (PHASE68_TEST_DB != DB_NAME)', env: { PHASE68_TEST_DB: 'phase68_amount_guard_a', DB_NAME: 'phase68_amount_guard_b' } },
  { name: 'denylisted production name afrikoba_global', env: { PHASE68_TEST_DB: 'afrikoba_global', DB_NAME: 'afrikoba_global' } },
  { name: 'denylisted name postgres', env: { PHASE68_TEST_DB: 'postgres', DB_NAME: 'postgres' } },
  { name: 'non-disposable name phase68_guard', env: { PHASE68_TEST_DB: 'phase68_guard', DB_NAME: 'phase68_guard' } },
  { name: 'invalid identifier with SQL injection payload', env: { PHASE68_TEST_DB: 'phase68_amount_guard_x"; DROP DATABASE postgres; --', DB_NAME: 'phase68_amount_guard_x"; DROP DATABASE postgres; --' } },
];

async function main() {
  console.log('== Negative guard cases (unreachable DB endpoint; refusal must precede connection) ==');
  for (const c of NEGATIVE_CASES) {
    for (const e of ENTRIES) {
      const env = { ...baseEnv(), ...c.env };
      for (const k of Object.keys(c.env)) if (c.env[k] === undefined) delete env[k];
      const r = run(e.file, env);
      const refused = /REFUSING/.test(r.out);
      const noConnect = !/ECONNREFUSED|connect ECONN/.test(r.out);
      const exitOk = e.suite ? r.status === 2 : r.status !== 0;
      expect(refused && noConnect && exitOk, `${c.name} :: ${e.file} -> refused before connect (exit ${r.status})`, { refused, noConnect, exit: r.status });
    }
  }

  console.log('\n== Connected-identity mismatch (configured DB is correct, connection reports afrikoba_global) ==');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'p11-'));
  for (const e of ENTRIES) {
    const log = path.join(dir, path.basename(e.file) + '.sql.log');
    const env = { ...baseEnv(), PHASE68_TEST_DB: 'phase68_amount_guard_test', DB_NAME: 'phase68_amount_guard_test', P11_FAKE_CURRENT_DB: 'afrikoba_global', P11_STUB_LOG: log };
    env.DB_HOST = 'localhost';
    env.DB_PORT = '5432';
    env.SACCOS_TEST_BASE = 'http://127.0.0.1:1';
    const r = run(e.file, env, STUB);
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const writes = lines.filter((l) => l.startsWith('SQL ') && WRITE_SQL.test(l.slice(4)));
    const refused = /REFUSING/.test(r.out) && /afrikoba_global/.test(r.out);
    const exitOk = e.suite ? r.status === 2 : r.status !== 0;
    expect(refused && exitOk, `identity mismatch :: ${e.file} -> REFUSING, exit ${r.status}`, { out: r.out.slice(0, 200) });
    expect(writes.length === 0, `identity mismatch :: ${e.file} -> no write statements issued (${lines.length} statements recorded)`, writes.slice(0, 5));
  }

  console.log(`\nP1.1 DATABASE IDENTITY NEGATIVE TESTS: ${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(failed === 0 ? 0 : 1);
}

main();
