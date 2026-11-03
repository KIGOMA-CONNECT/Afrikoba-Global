'use strict';
const { Pool } = require('/tmp/afrikoba-phase68-deposit-fix/node_modules/pg');

const DB_NAME = process.env.DB_NAME || '';
if (!/^phase68_amount_guard_[a-z0-9_]+$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
  console.error('SUITE ERROR');
  process.exit(2);
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: DB_NAME,
});

let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log('  OK ' + label); }
function fail(label, extra) { failed++; failures.push(label); console.log('  FAIL ' + label + (extra ? ' :: ' + extra : '')); }
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra); }

async function run() {
  const client = await pool.connect();
  try {
    // Test 1: ON CONFLICT DO NOTHING leaves transaction usable
    console.log('\n--- Test 1: ON CONFLICT leaves TX usable ---');
    await client.query('BEGIN');
    const ref = 'ONCONFLICT-TEST-' + Date.now();
    // Create partial unique index for test
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS test_uq ON reconciliation_exceptions (exception_type, reference_id)
      WHERE status IN ('OPEN', 'UNDER_INVESTIGATION') AND reference_id IS NOT NULL
    `);
    // First insert
    const r1 = await client.query(`
      INSERT INTO reconciliation_exceptions (exception_type, reference_id, status)
      VALUES ('TEST_TYPE', $1, 'OPEN')
      ON CONFLICT (exception_type, reference_id) WHERE status IN ('OPEN', 'UNDER_INVESTIGATION') AND reference_id IS NOT NULL
      DO NOTHING RETURNING id
    `, [ref]);
    await expect(r1.rows.length === 1, 'First insert succeeds');

    // Second insert (conflict)
    const r2 = await client.query(`
      INSERT INTO reconciliation_exceptions (exception_type, reference_id, status)
      VALUES ('TEST_TYPE', $1, 'OPEN')
      ON CONFLICT (exception_type, reference_id) WHERE status IN ('OPEN', 'UNDER_INVESTIGATION') AND reference_id IS NOT NULL
      DO NOTHING RETURNING id
    `, [ref]);
    await expect(r2.rows.length === 0, 'Second insert conflicts (dedup)');

    // Transaction still usable - execute another SQL statement
    const r3 = await client.query('SELECT 1 AS usable');
    await expect(r3.rows[0].usable === 1, 'Transaction still usable after conflict');

    // Commit succeeds
    await client.query('COMMIT');
    ok('COMMIT succeeds after conflict');

    // Test 2: Unrelated unique violation propagates
    console.log('\n--- Test 2: Unrelated unique violation propagates ---');
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      // Try to insert with duplicate PK (should fail with 23505 but different constraint)
      try {
        await client2.query("INSERT INTO reconciliation_exceptions (id, exception_type, reference_id, status) VALUES (1, 'TEST', 'REF-UNIQUE', 'OPEN')");
        fail('Unrelated unique violation propagates', 'insert succeeded unexpectedly');
      } catch (e) {
        await expect(e.code === '23505', 'Unrelated unique violation raises 23505', e.code);
        await expect(e.constraint !== 'test_uq', 'Constraint is not test_uq', e.constraint);
      }
      await client2.query('ROLLBACK');
      ok('ROLLBACK after unrelated violation');
    } finally {
      client2.release();
    }

    // Cleanup
    const cleanupClient = await pool.connect();
    await cleanupClient.query('DROP INDEX IF EXISTS test_uq');
    await cleanupClient.query("DELETE FROM reconciliation_exceptions WHERE exception_type = 'TEST_TYPE'");
    cleanupClient.release();

    console.log('\nON CONFLICT TESTS: ' + passed + ' passed, ' + failed + ' failed');
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FATAL', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
