'use strict';
const { Pool } = require('pg');
const merchantService = require('../src/services/merchantService');

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

    console.log('\n--- Merchant Payment Linkage Test (direct service call) ---');

    // Create a merchant
    const merchRes = await client.query(
      "INSERT INTO merchants (user_id, name, business_type, phone, is_active) VALUES ($1, 'TestMerchant', 'RETAIL', '255700000001', true) RETURNING id",
      [uid2]
    );
    const merchantId = merchRes.rows[0].id;

    // Fund payer wallet
    const beforeBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);
    const fundedBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;

    // Legacy payment (no connected account)
    const result = await merchantService.payMerchant(uid, merchantId, 5000, 'Test payment', { client });
    await expect(result.success === true, 'Legacy payment succeeded', JSON.stringify(result));

    // Verify transaction linkage
    const ref = result.reference;
    const txRes = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txRes.rows.length === 1, 'Transaction row created');
    const txId = txRes.rows[0].id;

    const foRes = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref]);
    await expect(foRes.rows.length > 0 && foRes.rows[0].transaction_id === txId, 'financial_operations linked', `got ${foRes.rows[0]?.transaction_id} expected ${txId}`);

    const jeRes = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [ref]);
    await expect(jeRes.rows.length > 0 && jeRes.rows[0].transaction_id === txId, 'journal_entries linked', `got ${jeRes.rows[0]?.transaction_id} expected ${txId}`);

    // Verify payer debited
    const payerBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await expect(Number(fundedBal) - Number(payerBal) === 5000, 'Payer debited 5000', `funded=${fundedBal} after=${payerBal}`);

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
