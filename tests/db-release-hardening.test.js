'use strict';
const assert = require('assert');
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'config', 'db'));

function createMockPool() {
  const state = { lastReleaseErr: null, releaseCount: 0 };
  return {
    _state: state,
    connect: function() {
      const client = {
        _q: function() { return Promise.resolve({ rows: [] }); },
        query: function() { return this._q.apply(this, arguments); },
        release: function(err) { this._pState.releaseCount++; this._pState.lastReleaseErr = err || null; }
      };
      client._pState = state;
      return Promise.resolve(client);
    }
  };
}

async function run() {
  let passed = 0, failed = 0;
  const tests = [];
  const test = (name, fn) => tests.push({name, fn});
  if (typeof db._setPool === 'function') db._setPool(createMockPool());
  const pool = typeof db._getPool === 'function' ? db._getPool() : null;

  test('BEGIN state changes only after successful completion (promise)', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    try {
      let resolveBegin;
      const p = new Promise(function(r){ resolveBegin = r; });
      client._q = function(sql) {
        if (typeof sql === 'string' && sql.trim().toLowerCase().indexOf('begin') === 0) {
          assert.strictEqual(!!client.__afrikobaInTx, false);
          return p.then(function(){ return {rows:[]}; });
        }
        return Promise.resolve({rows:[]});
      };
      const q = client.query('BEGIN');
      resolveBegin();
      await q;
      assert.strictEqual(client.__afrikobaInTx, true);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  test('failed BEGIN does not set transaction state', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    try {
      client._q = function(sql) {
        if (typeof sql === 'string' && sql.trim().toLowerCase().indexOf('begin') === 0) return Promise.reject(new Error('x'));
        return Promise.resolve({rows:[]});
      };
      try { await client.query('BEGIN'); assert.fail('should fail'); } catch(e) { assert.strictEqual(!!client.__afrikobaInTx, false); }
    } finally { client.release(); }
  });

  test('successful COMMIT and ROLLBACK clear transaction state', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      assert.strictEqual(client.__afrikobaInTx, true);
      await client.query('COMMIT');
      assert.strictEqual(!!client.__afrikobaInTx, false);
      await client.query('BEGIN');
      assert.strictEqual(client.__afrikobaInTx, true);
      await client.query('ROLLBACK');
      assert.strictEqual(!!client.__afrikobaInTx, false);
    } finally { client.release(); }
  });

  test('failed COMMIT/ROLLBACK do not falsely clear state', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      assert.strictEqual(client.__afrikobaInTx, true);
      client._q = function(sql) {
        if (typeof sql === 'string') {
          var t = sql.trim().toLowerCase();
          if (t.indexOf('commit') === 0) return Promise.reject(new Error('x'));
          if (t.indexOf('begin') === 0) return Promise.resolve({rows:[]});
          if (t.indexOf('rollback') === 0) return Promise.resolve({rows:[]});
        }
        return Promise.resolve({rows:[]});
      };
      try { await client.query('COMMIT'); assert.fail('should fail'); } catch(e) { assert.strictEqual(client.__afrikobaInTx, true); }
      client._q = function(){ return Promise.resolve({rows:[]}); };
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  test('successful cleanup rollback releases normally', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1');
    client.release();
    await new Promise(function(r){setTimeout(r,10);});
    assert.strictEqual(pool._state.releaseCount >= 1, true);
    assert.strictEqual(pool._state.lastReleaseErr, null);
  });

  test('failed cleanup rollback destroys the client', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    client._q = function(sql) {
      if (typeof sql === 'string') {
        var t = sql.trim().toLowerCase();
        if (t.indexOf('rollback') === 0) return Promise.reject(new Error('x'));
        if (t.indexOf('begin') === 0) return Promise.resolve({rows:[]});
      }
      return Promise.resolve({rows:[]});
    };
    await client.query('BEGIN');
    await client.query('SELECT 1');
    client.release();
    await new Promise(function(r){setTimeout(r,20);});
    assert.strictEqual(pool._state.releaseCount >= 1, true);
    assert(pool._state.lastReleaseErr);
  });

  test('synchronous rollback exception destroys the client', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    client._q = function(sql) {
      if (typeof sql === 'string') {
        var t = sql.trim().toLowerCase();
        if (t.indexOf('rollback') === 0) throw new Error('x');
        if (t.indexOf('begin') === 0) return Promise.resolve({rows:[]});
      }
      return Promise.resolve({rows:[]});
    };
    await client.query('BEGIN');
    await client.query('SELECT 1');
    client.release();
    await new Promise(function(r){setTimeout(r,20);});
    assert.strictEqual(pool._state.releaseCount >= 1, true);
    assert(pool._state.lastReleaseErr);
  });

  test('repeated release calls invoke the underlying release exactly once', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    await client.query('SELECT 1');
    client.release();
    client.release();
    client.release();
    await new Promise(function(r){setTimeout(r,10);});
    assert.strictEqual(pool._state.releaseCount, 1);
  });

  test('caller error preserved on successful cleanup rollback', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1');
    client.release(new Error('e'));
    await new Promise(function(r){setTimeout(r,20);});
    assert.strictEqual(pool._state.releaseCount >= 1, true);
    assert(pool._state.lastReleaseErr);
  });

  test('caller error with failed cleanup rollback destroys the client', async () => {
    if (pool && pool._state) { pool._state.releaseCount = 0; pool._state.lastReleaseErr = null; }
    const client = await db.connect();
    client._q = function(sql) {
      if (typeof sql === 'string') {
        var t = sql.trim().toLowerCase();
        if (t.indexOf('rollback') === 0) return Promise.reject(new Error('rb'));
        if (t.indexOf('begin') === 0) return Promise.resolve({rows:[]});
      }
      return Promise.resolve({rows:[]});
    };
    await client.query('BEGIN');
    await client.query('SELECT 1');
    client.release(new Error('caller'));
    await new Promise(function(r){setTimeout(r,20);});
    assert.strictEqual(pool._state.releaseCount >= 1, true);
    assert(pool._state.lastReleaseErr);
  });

  for (let i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); console.log('✓ ' + tests[i].name); passed++; }
    catch(e) { console.log('✗ ' + tests[i].name); console.log('  ' + e.message); failed++; }
  }
  console.log('\nDB RELEASE HARDENING TESTS: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(function(e) { console.error(e); process.exit(1); });
