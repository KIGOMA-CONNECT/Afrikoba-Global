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
    await client.query('BEGIN');
    const uid = (await client.query('SELECT min(id) AS id FROM users')).rows[0].id;
    const uid2 = (await client.query('SELECT id FROM users WHERE id > $1 ORDER BY id LIMIT 1', [uid])).rows[0].id;

    console.log('\n--- Merchant Payment Linkage Test ---');

    // Create a merchant
    const merchRes = await client.query(
      "INSERT INTO merchants (user_id, name, business_type, phone, is_active) VALUES ($1, 'TestMerchant', 'RETAIL', '255700000001', true) RETURNING id",
      [uid2]
    );
    const merchantId = merchRes.rows[0].id;

    // Fund payer wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);

    // Create a merchant payment (legacy path - no connected account)
    const ref = 'MERCH-TEST-' + Date.now();
    const result = await client.query(
      "SELECT * FROM merchants WHERE id = $1", [merchantId]
    );
    const merchant = result.rows[0];

    // Simulate payMerchant legacy path
    const txRes = await client.query(
      `INSERT INTO transactions (user_id, type, total_charged, wallet_amount, commission, status, reference_id, meta)
       VALUES ($1, 'TRANSFER', 5000, 5000, 0, 'SUCCESS', $2, $3) RETURNING id`,
      [uid, ref, JSON.stringify({ merchant_id: merchantId, type: 'MERCHANT_PAYMENT' })]
    );
    const txId = txRes.rows[0].id;

    // Create financial_operation with NULL transaction_id (simulating engine call before transaction)
    await client.query(
      "INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('MERCHANT_PAYMENT', $1, $2, 5000, 'SUCCESS')",
      [ref, uid]
    );

    // Create journal entry
    const acctId = (await client.query('SELECT id FROM ledger_accounts LIMIT 1')).rows[0].id;
    await client.query(
      "INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id) VALUES ($1, $2, 'DR', 5000, $3)",
      [ref, acctId, ref]
    );

    // Trigger should have linked them already (since transaction was inserted before)
    // But financial_operations and journal were inserted AFTER transaction, so trigger won't fire
    // Need to verify trigger fires on transaction insert only
    // Let's check: the transaction was inserted BEFORE the financial_operations, so trigger already fired
    // and found no matching financial_operations (they didn't exist yet)
    // So transaction_id should be NULL on financial_operations

    const foCheck = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref]);
    console.log('  financial_operations.transaction_id before manual link:', foCheck.rows[0].transaction_id);

    // Now test: if we insert transaction AFTER financial_operations, trigger links them
    const ref2 = 'MERCH-TEST2-' + Date.now();
    await client.query(
      "INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('MERCHANT_PAYMENT', $1, $2, 3000, 'NEW')",
      [ref2, uid]
    );
    const acctId2 = acctId;
    await client.query(
      "INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id) VALUES ($1, $2, 'DR', 3000, $3)",
      [ref2, acctId2, ref2]
    );
    const txRes2 = await client.query(
      "INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type) VALUES ($1, $2, 3000, 0, 3000, 'SUCCESS', 'TEST') RETURNING id",
      [ref2, uid]
    );
    const txId2 = txRes2.rows[0].id;

    const foCheck2 = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref2]);
    await expect(foCheck2.rows[0].transaction_id === txId2, 'merchant financial_operations linked by trigger');

    const jeCheck2 = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [ref2]);
    await expect(jeCheck2.rows[0].transaction_id === txId2, 'merchant journal_entries linked by trigger');

    await client.query('ROLLBACK');
    console.log('\nMERCHANT PAYMENT LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
