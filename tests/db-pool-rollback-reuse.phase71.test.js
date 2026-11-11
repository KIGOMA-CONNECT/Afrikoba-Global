#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R25: src/config/db.js connection-reuse rollback
 *
 *  R24-N4  db.js installs auto-ROLLBACK-on-release in safeConnect(). pg-pool
 *          (3.14.0, index.js:342) assigns a fresh client.release on EVERY
 *          checkout. If the wrapper is installed only on a physical client's
 *          first checkout, a later checkout that releases inside a
 *          transaction returns an open (or aborted) transaction to the pool,
 *          and the next user's COMMIT persists the earlier partial work.
 *
 *  This suite uses a dedicated pg Pool (max:1, so the same physical backend
 *  is reused deterministically) injected via db._setPool().
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix> on
 * 127.0.0.1:55471.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55471') {
  console.error('REFUSING: DB_HOST/DB_PORT must be the disposable p71-ci-db (127.0.0.1:55471).');
  process.exit(2);
}

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Pool } = require(path.join(ROOT, 'node_modules/pg'));
const db = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
const loggedErrors = [];
logger.error = (...a) => { loggedErrors.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
logger.warn = () => {}; logger.info = () => {};

let passed = 0; let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkPool = (max) => new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME, max, idleTimeoutMillis: 30000,
});
const T = 'r25_pool_reuse';
const rows = async () => (await db.query(`SELECT tag FROM ${T} ORDER BY tag`)).rows.map((r) => r.tag);
// let any deferred release/ROLLBACK chains settle
const settle = () => sleep(150);
async function section(fn) {
  try { await fn(); } catch (e) {
    failed++; console.log(`  ✗ section aborted — ${e.message}`);
    // a leaked/aborted pooled connection is exactly the defect under test; clear it so later sections run
    try { const c = await db.connect(); await c.query('ROLLBACK').catch(() => {}); c.release(true); } catch (_) { /* ignore */ }
    await settle();
  }
}

(async () => {
  const original = db._getPool();
  const p1 = mkPool(1);
  db._setPool(p1);
  const id = (await db.query('SELECT current_database() db, inet_server_addr() addr, inet_server_port() port')).rows[0];
  console.log(`DB identity: database=${id.db} server_addr=${id.addr} server_port=${id.port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  await db.query(`CREATE TABLE IF NOT EXISTS ${T} (tag text)`);

  // ---------------------------------------------------------------- [1]
  console.log('\n[1] first checkout: uncommitted work rolled back on release');
  await section(async () => {
    await db.query(`TRUNCATE ${T}`);
    const c = await db.connect();
    await c.query('BEGIN'); await c.query(`INSERT INTO ${T} VALUES ('first')`);
    c.release(); await settle();
    check('first-checkout work not persisted', !(await rows()).includes('first'), await rows());
  });

  // ---------------------------------------------------------------- [2]
  console.log('\n[2] repeated reuse of the SAME backend: 25 uncommitted releases never leak');
  await section(async () => {
    await db.query(`TRUNCATE ${T}`);
    const pids = new Set();
    let leakedIntoNext = 0;
    for (let i = 0; i < 25; i++) {
      const c = await db.connect();
      pids.add((await c.query('SELECT pg_backend_pid() p')).rows[0].p);
      await c.query('BEGIN'); await c.query(`INSERT INTO ${T} VALUES ($1)`, [`leak-${i}`]);
      c.release(); await settle();
      const n = await db.connect();
      const st = (await n.query('SELECT txid_current_if_assigned() t, now() = statement_timestamp() fresh')).rows[0];
      if (st.t !== null || st.fresh !== true) leakedIntoNext++;
      await n.query('BEGIN'); await n.query(`INSERT INTO ${T} VALUES ($1)`, [`ok-${i}`]); await n.query('COMMIT');
      n.release(); await settle();
    }
    const r = await rows();
    check('same physical backend reused (max:1)', pids.size === 1, [...pids]);
    check('next checkout starts outside any transaction (25/25)', leakedIntoNext === 0, { leakedIntoNext });
    check('no uncommitted row persisted by the next user COMMIT', r.filter((x) => x.startsWith('leak-')).length === 0, r.filter((x) => x.startsWith('leak-')).slice(0, 5));
    check('all 25 committed rows persisted', r.filter((x) => x.startsWith('ok-')).length === 25);
  });

  // ---------------------------------------------------------------- [3]
  console.log('\n[3] aborted transaction (failed statement) is cleared before reuse');
  await section(async () => {
    for (let i = 0; i < 5; i++) {
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        try { await c.query('SELECT 1/0'); } catch (_) { /* aborted */ }
      } finally { c.release(); }
      await settle();
    }
    const results = [];
    for (let i = 0; i < 5; i++) {
      try { results.push((await db.query('SELECT 1 AS ok, txid_current_if_assigned() t')).rows[0]); } catch (e) { results.push({ err: e.message }); }
    }
    check('pool.query works after 5 aborted-and-released transactions', results.every((x) => x.ok === 1 && x.t === null), results);
  });

  // ---------------------------------------------------------------- [4]
  console.log('\n[4] transaction opened with SQL forms the text matcher misses');
  await section(async () => {
    for (const sql of ['begin;', '  BEGIN ;', 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE', { text: 'START TRANSACTION' }]) {
      await db.query(`TRUNCATE ${T}`);
      const c = await db.connect();
      try { await c.query(sql); await c.query(`INSERT INTO ${T} VALUES ('variant')`); } finally { c.release(); }
      await settle();
      const n = await db.connect();
      try { await n.query('BEGIN'); await n.query('COMMIT'); } finally { n.release(); }
      await settle();
      check(`"${typeof sql === 'string' ? sql : sql.text}" rolled back`, !(await rows()).includes('variant'), await rows());
    }
  });

  // ---------------------------------------------------------------- [5]
  console.log('\n[5] release(err) destroys the client; pool recovers');
  await section(async () => {
    const c = await db.connect();
    const pidA = (await c.query('SELECT pg_backend_pid() p')).rows[0].p;
    await c.query('BEGIN'); await c.query(`INSERT INTO ${T} VALUES ('err-release')`);
    c.release(new Error('caller failure')); await settle();
    const n = await db.connect();
    const pidB = (await n.query('SELECT pg_backend_pid() p')).rows[0].p;
    n.release(); await settle();
    check('client discarded (new backend)', pidA !== pidB, { pidA, pidB });
    check('work not persisted', !(await rows()).includes('err-release'));
  });

  // ---------------------------------------------------------------- [6]
  console.log('\n[6] ROLLBACK failure: client discarded, failure recorded, caller error preserved');
  await section(async () => {
    loggedErrors.length = 0;
    const c = await db.connect();
    const pidA = (await c.query('SELECT pg_backend_pid() p')).rows[0].p;
    await c.query('BEGIN'); await c.query(`INSERT INTO ${T} VALUES ('rb-fail')`);
    const realQuery = c.query;
    c.query = function (sql, ...rest) {
      const t = typeof sql === 'string' ? sql : sql && sql.text;
      if (t && /^\s*rollback/i.test(t)) return Promise.reject(new Error('injected rollback failure'));
      return realQuery.call(this, sql, ...rest);
    };
    const callerError = new Error('original caller error');
    let seen = null;
    try { throw callerError; } catch (e) { seen = e; } finally { c.release(); }
    await settle(); await sleep(200);
    c.query = realQuery; // test hygiene: if the client were (wrongly) reused, do not carry the stub forward
    check('caller still holds the original error', seen === callerError && seen.message === 'original caller error');
    const n = await db.connect();
    const pidB = (await n.query('SELECT pg_backend_pid() p')).rows[0].p;
    const st = (await n.query('SELECT txid_current_if_assigned() t')).rows[0];
    n.release(); await settle();
    check('client whose ROLLBACK failed is not reused', pidA !== pidB, { pidA, pidB });
    check('next client is clean', st.t === null);
    check('uncommitted work not persisted', !(await rows()).includes('rb-fail'));
    check('rollback failure is recorded (logger.error)', loggedErrors.some((x) => /rollback/i.test(x)), loggedErrors);
  });

  // ---------------------------------------------------------------- [7]
  console.log('\n[7] healthy commit path and reuse unaffected');
  await section(async () => {
    await db.query(`TRUNCATE ${T}`);
    const c = await db.connect();
    try { await c.query('BEGIN'); await c.query(`INSERT INTO ${T} VALUES ('committed')`); await c.query('COMMIT'); } finally { c.release(); }
    await settle();
    const c2 = await db.connect();
    try { await c2.query('BEGIN'); await c2.query(`INSERT INTO ${T} VALUES ('rolled')`); await c2.query('ROLLBACK'); } finally { c2.release(); }
    await settle();
    check('committed row kept, explicitly rolled-back row absent', JSON.stringify(await rows()) === '["committed"]', await rows());
    let doubleThrew = false;
    const c3 = await db.connect(); c3.release();
    try { c3.release(); } catch (_) { doubleThrew = true; }
    await settle();
    check('double release is harmless (no throw, pool usable)', !doubleThrew && (await db.query('SELECT 1 x')).rows[0].x === 1);
  });

  // ---------------------------------------------------------------- [8]
  console.log('\n[8] concurrency: 60 tasks over a 3-connection pool, every 2nd fails mid-transaction');
  await section(async () => {
    db._setPool(mkPool(3)); await p1.end();
    await db.query(`TRUNCATE ${T}`);
    const tasks = Array.from({ length: 60 }, (_, i) => (async () => {
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO ${T} VALUES ($1)`, [`t-${i}`]);
        await sleep(Math.floor(Math.random() * 5));
        if (i % 2 === 1) throw new Error(`fail ${i}`);
        await c.query('COMMIT');
      } finally { c.release(); }
    })());
    const res = await Promise.allSettled(tasks);
    await settle(); await sleep(200);
    const r = await rows();
    const odd = r.filter((x) => Number(x.slice(2)) % 2 === 1);
    check('30 failed / 30 succeeded', res.filter((x) => x.status === 'rejected').length === 30);
    check('exactly the 30 committed rows persisted', r.length === 30 && odd.length === 0, { count: r.length, odd: odd.slice(0, 5) });
    const after = await Promise.all(Array.from({ length: 9 }, () => db.query('SELECT txid_current_if_assigned() t')));
    check('no pooled connection left inside a transaction', after.every((x) => x.rows[0].t === null));
  });

  await db.query(`DROP TABLE IF EXISTS ${T}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  const cur = db._getPool(); db._setPool(original);
  await cur.end().catch(() => {}); await original.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.log('FATAL', e.stack || e.message);
  process.exit(1);
});
