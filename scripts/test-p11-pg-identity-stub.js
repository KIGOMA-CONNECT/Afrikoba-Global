/* P1.1 test support, preloaded with `node -r`. Simulates PostgreSQL connections for the
 * migration runner and SACCOS suites without writing to any database. Every SQL statement
 * is recorded so tests can prove ordering and absence of writes. Never used by app code.
 *
 * Knobs (env):
 *  P11_STUB_LOG              file receiving CONNECT / SQL lines
 *  P11_FAKE_CURRENT_DB       value reported by current_database() on mismatched connections
 *  P11_FAKE_ON               'any' (default) or a database name whose connections mismatch
 *  P11_TARGET_EXISTS         '0' makes pg_database lookups return no row (forces CREATE DATABASE)
 *  P11_FAIL_TARGET_CONNECTS  number of initial connects to the configured target that fail auth (28P01)
 *  P11_HALT_ON_MIGRATIONS    '1' throws at the first schema_migrations DDL, marking the end of the test
 */
const path = require('path');
const fs = require('fs');

const pg = require(require.resolve('pg', { paths: [path.join(__dirname, '..')] }));
const LOG = process.env.P11_STUB_LOG;
const FAKE_DB = process.env.P11_FAKE_CURRENT_DB || '';
const FAKE_ON = process.env.P11_FAKE_ON || 'any';
const TARGET_EXISTS = process.env.P11_TARGET_EXISTS !== '0';
const HALT = process.env.P11_HALT_ON_MIGRATIONS === '1';
const TARGET = process.env.DB_NAME || '';
let failTargetConnects = Number(process.env.P11_FAIL_TARGET_CONNECTS || 0);

function record(line) {
  if (LOG) fs.appendFileSync(LOG, String(line).split('\n')[0] + '\n');
}

function reportedDb(database) {
  if (FAKE_DB && (FAKE_ON === 'any' || FAKE_ON === database)) return FAKE_DB;
  return database;
}

function respond(database, sql) {
  if (/current_database/i.test(sql)) {
    const db = reportedDb(database);
    return { rows: [{ db, current_database: db }], rowCount: 1 };
  }
  if (/pg_database/i.test(sql)) return TARGET_EXISTS ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (/to_regclass/i.test(sql)) return { rows: [{ to_regclass: 'present' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

class FakeClient {
  constructor(cfg) { this.cfg = cfg || {}; }
  async connect() {
    const database = this.cfg.database || '';
    if (database === TARGET && failTargetConnects > 0) {
      failTargetConnects--;
      record('CONNECT_FAILED ' + database + ' user=' + (this.cfg.user || ''));
      const err = new Error('password authentication failed (stub)');
      err.code = '28P01';
      throw err;
    }
    record('CONNECT ' + database + ' user=' + (this.cfg.user || ''));
  }
  async query(sql) {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    record('SQL ' + text.trim());
    if (HALT && /CREATE TABLE IF NOT EXISTS schema_migrations/i.test(text)) {
      throw new Error('P11_HALT: migrations reached');
    }
    return respond(this.cfg.database || '', text);
  }
  async end() {}
  release() {}
  on() { return this; }
}

class FakePool {
  constructor(cfg) { this.cfg = cfg || {}; }
  async connect() { return new FakeClient(this.cfg); }
  async query(sql) { return new FakeClient(this.cfg).query(sql); }
  on() { return this; }
  async end() {}
}

pg.Client = FakeClient;
pg.Pool = FakePool;
