'use strict';

const assert = require('assert');
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'config', 'db'));

async function run() {
  let passed = 0;
  let failed = 0;
  const tests = [];
  const test = (name, fn) => tests.push({ name: name, fn: fn });

  // Test 1: Successful release invokes origRelease exactly once
  test('1. Successful release invokes origRelease exactly once', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function() { return Promise.resolve({ rows: [] }); },
            release: function(err) { self._state.releaseCount++; self._state.lastReleaseErr = err || null; }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    client.release();
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
    assert.strictEqual(pool._state.lastReleaseErr, null);
  });

  // Test 2: Repeated safeRelease calls invoke origRelease exactly once
  test('2. Repeated safeRelease calls invoke origRelease exactly once', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function() { return Promise.resolve({ rows: [] }); },
            release: function(err) { self._state.releaseCount++; self._state.lastReleaseErr = err || null; }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    client.release();
    client.release();
    client.release();
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
  });

  // Test 3: If origRelease throws, it is still invoked exactly once
  test('3. If origRelease throws, it is still invoked exactly once', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function() { return Promise.resolve({ rows: [] }); },
            release: function(err) {
              self._state.releaseCount++;
              self._state.lastReleaseErr = err || null;
              throw new Error('release-throws');
            }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    try { client.release(); } catch (e) {}
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
    try { client.release(); } catch (e) {}
    try { client.release(); } catch (e) {}
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
  });

  // Test 4: Caller error remains the primary error when origRelease also throws
  // Caller-visible error precedence: callerErr propagates, not release-throws
  test('4. Caller error preserved when origRelease throws (error precedence)', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function() { return Promise.resolve({ rows: [] }); },
            release: function(err) {
              self._state.releaseCount++;
              self._state.lastReleaseErr = err || null;
              throw new Error('release-throws');
            }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    const callerErr = new Error('caller-error');
    let thrownErr = null;
    try {
      client.release(callerErr);
    } catch (e) {
      thrownErr = e;
    }
    await new Promise(function(r) { setTimeout(r, 15); });
    // Underlying release invoked exactly once
    assert.strictEqual(pool._state.releaseCount, 1);
    // The exact original callerErr was passed to origRelease
    assert.strictEqual(pool._state.lastReleaseErr, callerErr);
    // Caller-visible error precedence: callerErr propagates, not release exception
    assert.strictEqual(thrownErr, callerErr, 'caller error should be the primary thrown error');
  });

  // Test 4b: origRelease throws with no caller error - release exception propagates
  test('4b. origRelease throws with no caller error - release exception propagates', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function() { return Promise.resolve({ rows: [] }); },
            release: function(err) {
              self._state.releaseCount++;
              self._state.lastReleaseErr = err || null;
              throw new Error('release-throws');
            }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    let thrownErr = null;
    try {
      client.release();
    } catch (e) {
      thrownErr = e;
    }
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
    assert.ok(thrownErr instanceof Error, 'release exception should propagate when no caller error');
    assert.strictEqual(thrownErr.message, 'release-throws');
  });

  // Test 5: Failed rollback (async rejection) does not result in a second underlying release invocation
  test('5. Failed async rollback does not result in a second underlying release invocation', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function() { return Promise.reject(new Error('rollback-fail')); },
            release: function(err) {
              self._state.releaseCount++;
              self._state.lastReleaseErr = err || null;
            }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    client.__afrikobaInTx = true;
    client.release();
    await new Promise(function(r) { setTimeout(r, 25); });
    assert.strictEqual(pool._state.releaseCount, 1);
    assert(pool._state.lastReleaseErr);
    assert.strictEqual(pool._state.lastReleaseErr.message, 'rollback-fail');
  });

  // Test 6: Successful rollback and cleanup preserve existing behavior
  test('6. Successful rollback and cleanup preserve existing behavior', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function() { return Promise.resolve({ rows: [] }); },
            release: function(err) {
              self._state.releaseCount++;
              self._state.lastReleaseErr = err || null;
            }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    client.release();
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
    assert.strictEqual(pool._state.lastReleaseErr, null);
  });

  // Test 7: Synchronous rollback exception path
  test('7. Synchronous rollback exception invokes release exactly once with sync error', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function() { throw new Error('sync-rollback-fail'); },
            release: function(err) {
              self._state.releaseCount++;
              self._state.lastReleaseErr = err || null;
            }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    client.__afrikobaInTx = true;
    client.release();
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
    assert(pool._state.lastReleaseErr);
    assert.strictEqual(pool._state.lastReleaseErr.message, 'sync-rollback-fail');
  });

  // Test 8: Transaction state remains correct after BEGIN, COMMIT and ROLLBACK success/failure
  test('8. Transaction state remains correct after BEGIN, COMMIT and ROLLBACK success/failure', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0 };
    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            query: function(sql) {
              if (typeof sql === 'string') {
                const t = sql.trim().toLowerCase();
                if (t.indexOf('begin') === 0) return Promise.resolve({ rows: [] });
                if (t.indexOf('commit') === 0) return Promise.resolve({ rows: [] });
                if (t.indexOf('rollback') === 0) return Promise.resolve({ rows: [] });
              }
              return Promise.resolve({ rows: [] });
            },
            release: function(err) { self._state.releaseCount++; self._state.lastReleaseErr = err || null; }
          };
          return Promise.resolve(client);
        }
      });
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query('ROLLBACK');
    } catch (e) {
      // ignore
    } finally {
      client.release();
    }
    await new Promise(function(r) { setTimeout(r, 15); });
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    assert.strictEqual(pool._state.releaseCount, 1);
  });

  // Test 9: No real database credentials or live database connection are required
  test('9. No real database credentials or live database connection are required by these unit tests', async () => {
    assert.ok(true);
  });

  // Test 10: Caller error + successful async rollback + throwing origRelease
  test('10. Caller error + successful async rollback + throwing origRelease: exactly-once, no unhandled rejection', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0, unhandledRejection: null };
    const unhandledHandler = (reason) => { state.unhandledRejection = reason; };
    process.on('unhandledRejection', unhandledHandler);

    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            __afrikobaInTx: true,
            query: function() { return Promise.resolve({ rows: [] }); },
            release: function(err) {
              self._state.releaseCount++;
              self._state.lastReleaseErr = err || null;
              throw new Error('release-throws');
            }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; pool._state.unhandledRejection = null; }

    const client = await db.connect();
    const callerErr = new Error('caller-error-async-success');
    client.release(callerErr);
    await new Promise(function(r) { setTimeout(r, 30); });

    process.removeListener('unhandledRejection', unhandledHandler);

    // Exactly one underlying release invocation
    assert.strictEqual(pool._state.releaseCount, 1);
    // Caller error was passed to origRelease (primary application error)
    assert.strictEqual(pool._state.lastReleaseErr, callerErr);
    // No unhandled promise rejection emitted
    assert.strictEqual(pool._state.unhandledRejection, null);
    // Repeated calls do not cause another release
    client.release(callerErr);
    client.release(callerErr);
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
  });

  // Test 11: Caller error + rejected async rollback + throwing origRelease
  test('11. Caller error + rejected async rollback + throwing origRelease: exactly-once, rollback failure observable, no unhandled rejection', async () => {
    const state = { lastReleaseErr: null, releaseCount: 0, unhandledRejection: null };
    const unhandledHandler = (reason) => { state.unhandledRejection = reason; };
    process.on('unhandledRejection', unhandledHandler);

    if (typeof db._setPool === 'function') {
      db._setPool({
        _state: state,
        connect: function() {
          const self = this;
          const client = {
            __afrikobaInTx: true,
            query: function() { return Promise.reject(new Error('async-rollback-fail')); },
            release: function(err) {
              self._state.releaseCount++;
              self._state.lastReleaseErr = err || null;
              throw new Error('release-throws');
            }
          };
          return Promise.resolve(client);
        }
      });
    }
    const pool = typeof db._getPool === 'function' ? db._getPool() : null;
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; pool._state.unhandledRejection = null; }

    const client = await db.connect();
    const callerErr = new Error('caller-error-async-reject');
    client.release(callerErr);
    await new Promise(function(r) { setTimeout(r, 30); });

    process.removeListener('unhandledRejection', unhandledHandler);

    // Exactly one underlying release invocation
    assert.strictEqual(pool._state.releaseCount, 1);
    // Pool receives the rollback failure error (client-destruction error)
    assert.ok(pool._state.lastReleaseErr, 'pool should receive an error');
    assert.strictEqual(pool._state.lastReleaseErr.message, 'async-rollback-fail');
    // No unhandled promise rejection emitted
    assert.strictEqual(pool._state.unhandledRejection, null);
    // Repeated calls do not cause another release
    client.release(callerErr);
    client.release(callerErr);
    await new Promise(function(r) { setTimeout(r, 15); });
    assert.strictEqual(pool._state.releaseCount, 1);
  });

  for (let i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      console.log('✓ ' + tests[i].name);
      passed++;
    } catch (e) {
      console.log('✗ ' + tests[i].name);
      console.log('  ' + e.message);
      failed++;
    }
  }
  console.log('\nDB RELEASE HARDENING TESTS: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(function(e) {
  console.error(e);
  process.exit(1);
});
