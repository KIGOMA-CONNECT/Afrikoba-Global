'use strict';
const assert = require('assert');
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'config', 'db'));

async function run() {
  let passed = 0, failed = 0;
  const tests = [];
  const test = (name, fn) => tests.push({name, fn});

  test('successful BEGIN sets transaction state only after successful query completion (promise)', async () => {
    const client = await db.connect();
    try {
      const origQuery = client.query.bind(client);
      client.query = function() {
        const args = Array.prototype.slice.call(arguments);
        const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text ? args[0].text : '');
        const p = origQuery.apply(this, args);
        if (String(sql).trim().toLowerCase().indexOf('begin') === 0 && p && typeof p.then === 'function') {
          // At the moment before resolution, state should reflect pre-success? We track on success
          assert.strictEqual(!!client.__afrikobaInTx, false);
        }
        return p;
      };
      await client.query('BEGIN');
      assert.strictEqual(client.__afrikobaInTx, true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  test('failed BEGIN does not set transaction state', async () => {
    const client = await db.connect();
    try {
      const origQuery = client.query.bind(client);
      client.query = function() {
        const args = Array.prototype.slice.call(arguments);
        const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text ? args[0].text : '');
        if (String(sql).trim().toLowerCase().indexOf('begin') === 0) {
          // simulate failure by throwing/rejecting
          return Promise.reject(new Error('begin failed'));
        }
        return origQuery.apply(this, args);
      };
      try {
        await client.query('BEGIN');
        assert.fail('should have failed');
      } catch (e) {
        assert.strictEqual(!!client.__afrikobaInTx, false);
      }
    } finally {
      client.release();
    }
  });

  test('successful COMMIT and ROLLBACK clear transaction state', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      assert.strictEqual(client.__afrikobaInTx, true);
      await client.query('COMMIT');
      assert.strictEqual(!!client.__afrikobaInTx, false);
      await client.query('BEGIN');
      await client.query('ROLLBACK');
      assert.strictEqual(!!client.__afrikobaInTx, false);
    } finally {
      client.release();
    }
  });

  test('failed COMMIT/ROLLBACK do not falsely clear state', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      assert.strictEqual(client.__afrikobaInTx, true);
      const origQuery = client.query.bind(client);
      client.query = function() {
        const args = Array.prototype.slice.call(arguments);
        const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text ? args[0].text : '');
        if (String(sql).trim().toLowerCase().indexOf('commit') === 0) {
          return Promise.reject(new Error('commit failed'));
        }
        return origQuery.apply(this, args);
      };
      try {
        await client.query('COMMIT');
        assert.fail('should fail');
      } catch (e) {
        // state should remain true because commit failed
        assert.strictEqual(client.__afrikobaInTx, true);
      }
      try { await origQuery('ROLLBACK'); } catch (e) {}
    } finally {
      client.release();
    }
  });

  test('successful cleanup rollback releases normally', async () => {
    const client = await db.connect();
    let releasedWithError = false;
    const origRelease = client.release.bind(client);
    client.release = function(err) { if (err) releasedWithError = true; return origRelease(err); };
    await client.query('BEGIN');
    await client.query('SELECT 1');
    client.release();
    await new Promise(function(r){setTimeout(r,100);});
    assert.strictEqual(releasedWithError, false);
  });

  test('failed cleanup rollback destroys the client', async () => {
    const client = await db.connect();
    let releasedWithError = false;
    let releasedError = null;
    const origRelease = client.release.bind(client);
    client.release = function(err) { if (err) { releasedWithError = true; releasedError = err; } return origRelease(err); };
    const origQuery = client.query.bind(client);
    client.query = function() {
      const args = Array.prototype.slice.call(arguments);
      const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text ? args[0].text : '');
      if (String(sql).trim().toLowerCase().indexOf('rollback') === 0) {
        return Promise.reject(new Error('rollback failed'));
      }
      return origQuery.apply(this, args);
    };
    await client.query('BEGIN');
    await client.query('SELECT 1');
    client.release();
    await new Promise(function(r){setTimeout(r,150);});
    assert.strictEqual(releasedWithError, true);
    assert(releasedError);
  });

  test('synchronous rollback exception destroys the client', async () => {
    const client = await db.connect();
    let releasedWithError = false;
    const origRelease = client.release.bind(client);
    client.release = function(err) { if (err) releasedWithError = true; return origRelease(err); };
    const origQuery = client.query.bind(client);
    client.query = function() {
      const args = Array.prototype.slice.call(arguments);
      const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text ? args[0].text : '');
      if (String(sql).trim().toLowerCase().indexOf('rollback') === 0) {
        throw new Error('rollback sync fail');
      }
      return origQuery.apply(this, args);
    };
    await client.query('BEGIN');
    await client.query('SELECT 1');
    client.release();
    await new Promise(function(r){setTimeout(r,150);});
    assert.strictEqual(releasedWithError, true);
  });

  test('repeated release calls do not double-release', async () => {
    const client = await db.connect();
    let releaseCount = 0;
    const origRelease = client.release.bind(client);
    client.release = function(err) { releaseCount++; return origRelease(err); };
    await client.query('SELECT 1');
    client.release();
    client.release();
    client.release();
    await new Promise(function(r){setTimeout(r,50);});
    assert.strictEqual(releaseCount, 1);
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

run().catch(function(e) { console.error(e); process.exit(1); });
