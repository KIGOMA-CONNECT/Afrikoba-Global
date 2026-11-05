/* P1.1 test support: preloaded with `node -r` to simulate a connected database whose
 * current_database() differs from the configured one. Records every SQL statement so the
 * test can prove no write was issued before the identity refusal. Never used by app code. */
const path = require('path');
const fs = require('fs');

const pg = require(require.resolve('pg', { paths: [path.join(__dirname, '..')] }));
const LOG = process.env.P11_STUB_LOG;
const FAKE_DB = process.env.P11_FAKE_CURRENT_DB || 'afrikoba_global';

function record(line) {
  if (LOG) fs.appendFileSync(LOG, String(line).split('\n')[0] + '\n');
}

function respond(sql) {
  if (/current_database/i.test(sql)) return { rows: [{ db: FAKE_DB, current_database: FAKE_DB }], rowCount: 1 };
  if (/pg_database/i.test(sql)) return { rows: [{ x: 1 }], rowCount: 1 };
  if (/to_regclass/i.test(sql)) return { rows: [{ to_regclass: 'present' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

class FakeClient {
  constructor(cfg) { this.cfg = cfg || {}; }
  async connect() { record('CONNECT ' + (this.cfg.database || '')); }
  async query(sql) {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    record('SQL ' + text.trim());
    return respond(text);
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
