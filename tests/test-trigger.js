'use strict';
const { Pool } = require('pg');

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
    await client.query('BEGIN');
    const uid = (await client.query('SELECT min(id) AS id FROM users')).rows[0].id;
    const acctId = (await client.query('SELECT id FROM ledger_accounts LIMIT 1')).rows[0].id;

    console.log('\n--- Test 1: Basic linkage ---');
    const ref = 'TRG-TEST-' + Date.now();
    await client.query("INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('TEST_OP', $1, $2, 100, 'NEW')", [ref, uid]);
    await client.query("INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id) VALUES ($1, $2, 'DR', 100, $3)", [ref, acctId, ref]);
    const txRes = await client.query("INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type) VALUES ($1, $2, 100, 0, 100, 'SUCCESS', 'TEST') RETURNING id", [ref, uid]);
    const txId = txRes.rows[0].id;
    const foRes = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref]);
    await expect(foRes.rows[0].transaction_id === txId, 'financial_operations linked');
    const jeRes = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [ref]);
    await expect(jeRes.rows[0].transaction_id === txId, 'journal_entries linked');

    console.log('\n--- Test 2: Suffixed references ---');
    const ref2 = 'TRG-SUFF-' + Date.now();
    await client.query("INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('TEST_OP2', $1, $2, 50, 'NEW')", [ref2 + ':WG', uid]);
    await client.query("INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id) VALUES ($1, $2, 'CR', 50, $3)", [ref2, acctId, ref2 + ':WG']);
    const txRes2 = await client.query("INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type) VALUES ($1, $2, 50, 0, 50, 'SUCCESS', 'TEST') RETURNING id", [ref2, uid]);
    const txId2 = txRes2.rows[0].id;
    const foRes2 = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref2 + ':WG']);
    await expect(foRes2.rows[0].transaction_id === txId2, 'suffixed financial_operations linked');
    const jeRes2 = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [ref2 + ':WG']);
    await expect(jeRes2.rows[0].transaction_id === txId2, 'suffixed journal_entries linked');

    console.log('\n--- Test 3: Multiple transactions ---');
    const ref3a = 'TRG-MULTI-A-' + Date.now();
    const ref3b = 'TRG-MULTI-B-' + Date.now();
    await client.query("INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('TEST_MULTI', $1, $2, 10, 'NEW')", [ref3a, uid]);
    await client.query("INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('TEST_MULTI', $1, $2, 20, 'NEW')", [ref3b, uid]);
    const txRes3a = await client.query("INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type) VALUES ($1, $2, 10, 0, 10, 'SUCCESS', 'TEST') RETURNING id", [ref3a, uid]);
    const txRes3b = await client.query("INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type) VALUES ($1, $2, 20, 0, 20, 'SUCCESS', 'TEST') RETURNING id", [ref3b, uid]);
    const fo3a = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref3a]);
    const fo3b = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref3b]);
    await expect(fo3a.rows[0].transaction_id === txRes3a.rows[0].id, 'multi-A linked correctly');
    await expect(fo3b.rows[0].transaction_id === txRes3b.rows[0].id, 'multi-B linked correctly');
    await expect(fo3a.rows[0].transaction_id !== txRes3b.rows[0].id, 'no cross-link A');
    await expect(fo3b.rows[0].transaction_id !== txRes3a.rows[0].id, 'no cross-link B');

    console.log('\n--- Test 4: Rollback safety ---');
    const ref4 = 'TRG-ROLLBACK-' + Date.now();
    await client.query("INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('TEST_RB', $1, $2, 999, 'NEW')", [ref4, uid]);
    const txRes4 = await client.query("INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type) VALUES ($1, $2, 999, 0, 999, 'SUCCESS', 'TEST') RETURNING id", [ref4, uid]);
    const fo4before = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref4]);
    await expect(fo4before.rows[0].transaction_id === txRes4.rows[0].id, 'linked before rollback');
    await client.query('ROLLBACK');

    const checkClient = await pool.connect();
    const tx4check = await checkClient.query('SELECT id FROM transactions WHERE reference_id = $1', [ref4]);
    await expect(tx4check.rows.length === 0, 'transaction rolled back');
    const fo4check = await checkClient.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref4]);
    await expect(fo4check.rows.length === 0, 'financial_operations rolled back (no orphan)');
    checkClient.release();

    await client.query('BEGIN');

    await client.query('ROLLBACK');
    console.log('\nTRIGGER TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
