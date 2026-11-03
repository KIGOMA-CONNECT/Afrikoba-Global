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
  const uid = (await pool.query('SELECT min(id) AS id FROM users')).rows[0].id;
  const ref = 'CONC-TEST-' + Date.now();

  console.log('\n--- Concurrency Test: Independent connections ---');

  const conn1 = await pool.connect();
  const conn2 = await pool.connect();

  try {
    // Connection 1: insert financial_operation + transaction
    await conn1.query('BEGIN');
    await conn1.query(
      "INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('CONC_OP', $1, $2, 100, 'NEW')",
      [ref, uid]
    );
    const tx1 = await conn1.query(
      "INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type) VALUES ($1, $2, 100, 0, 100, 'SUCCESS', 'TEST') RETURNING id",
      [ref, uid]
    );
    await conn1.query('COMMIT');
    ok('Connection 1: committed successfully');

    // Connection 2: try to insert with same reference (should fail on unique constraint)
    await conn2.query('BEGIN');
    try {
      await conn2.query(
        "INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('CONC_OP', $1, $2, 100, 'NEW')",
        [ref, uid]
      );
      fail('Connection 2: duplicate insert rejected', 'insert succeeded unexpectedly');
    } catch (e) {
      await expect(e.code === '23505', 'Connection 2: duplicate rejected (23505)', e.code);
    }
    await conn2.query('ROLLBACK');
    ok('Connection 2: rolled back');

    // Verify only one transaction exists
    const txCount = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txCount.rows[0].n === 1, 'Only one transaction created', `got ${txCount.rows[0].n}`);

    const foCount = await pool.query('SELECT count(*)::int AS n FROM financial_operations WHERE reference_id = $1', [ref]);
    await expect(foCount.rows[0].n === 1, 'Only one financial_operation created', `got ${foCount.rows[0].n}`);

    // Verify trigger linked them
    const fo = await pool.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref]);
    const tx = await pool.query('SELECT id FROM transactions WHERE reference_id = $1', [ref]);
    await expect(fo.rows[0].transaction_id === tx.rows[0].id, 'Trigger linked financial_operation to transaction');

    // Cleanup
    await pool.query("DELETE FROM financial_operations WHERE reference_id = $1", [ref]);
    await pool.query("DELETE FROM transactions WHERE reference_id = $1", [ref]);

    console.log('\nCONCURRENCY TESTS: ' + passed + ' passed, ' + failed + ' failed');
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  } catch (e) {
    await conn1.query('ROLLBACK').catch(() => {});
    await conn2.query('ROLLBACK').catch(() => {});
    console.error('FATAL', e);
    process.exit(1);
  } finally {
    conn1.release();
    conn2.release();
    await pool.end();
  }
}

run();
