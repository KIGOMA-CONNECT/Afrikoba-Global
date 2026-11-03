'use strict';
const { Pool } = require('/tmp/afrikoba-phase68-deposit-fix/node_modules/pg');
const merchantService = require('/tmp/afrikoba-phase68-deposit-fix/src/services/merchantService');

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

    console.log('\n--- Merchant Payment: Legacy Path ---');
    // Create merchant (no connected account)
    const merchRes = await client.query(
      "INSERT INTO merchants (user_id, name, business_type, phone, is_active) VALUES ($1, 'LegacyMerchant', 'RETAIL', '255700000002', true) RETURNING id",
      [uid2]
    );
    const legacyMerchantId = merchRes.rows[0].id;
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);
    const fundedBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;

    const legacyResult = await merchantService.payMerchant(uid, legacyMerchantId, 5000, 'Legacy payment', { client });
    await expect(legacyResult.success === true, 'Legacy payment succeeded', JSON.stringify(legacyResult));
    const legacyRef = legacyResult.reference;
    const legacyTx = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [legacyRef]);
    await expect(legacyTx.rows.length === 1, 'Legacy: transaction row created');
    const legacyTxId = legacyTx.rows[0].id;
    const legacyFo = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [legacyRef]);
    await expect(legacyFo.rows.length > 0 && legacyFo.rows[0].transaction_id === legacyTxId, 'Legacy: financial_operations linked');
    const legacyJe = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [legacyRef]);
    await expect(legacyJe.rows.length > 0 && legacyJe.rows[0].transaction_id === legacyTxId, 'Legacy: journal_entries linked');
    const legacyBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await expect(Number(fundedBal) - Number(legacyBal) === 5000, 'Legacy: payer debited 5000');

    console.log('\n--- Merchant Payment: Connected Path ---');
    // Create connected account for merchant
    const connRes = await client.query(
      "INSERT INTO connected_merchant_accounts (merchant_id, payout_type, payout_reference, status, balance, kyc_verified_at) VALUES ($1, 'MNO_PHONE', '255745000001', 'ACTIVE', 0, NOW()) RETURNING id",
      [legacyMerchantId]
    );
    const connAccountId = connRes.rows[0].id;

    // Fund payer again
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);
    const fundedBal2 = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;

    const connectedResult = await merchantService.payMerchant(uid, legacyMerchantId, 3000, 'Connected payment', { client });
    await expect(connectedResult.success === true, 'Connected payment succeeded', JSON.stringify(connectedResult));
    const connRef = connectedResult.reference;
    const connTx = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [connRef]);
    await expect(connTx.rows.length === 1, 'Connected: transaction row created');
    const connTxId = connTx.rows[0].id;
    const connFo = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [connRef]);
    await expect(connFo.rows.length > 0 && connFo.rows[0].transaction_id === connTxId, 'Connected: financial_operations linked');
    const connJe = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [connRef]);
    await expect(connJe.rows.length > 0 && connJe.rows[0].transaction_id === connTxId, 'Connected: journal_entries linked');
    const connBal = (await client.query('SELECT balance FROM connected_merchant_accounts WHERE id = $1', [connAccountId])).rows[0].balance;
    await expect(Number(connBal) === 3000, 'Connected: merchant balance increased to 3000', `got ${connBal}`);
    const connectedPayerBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await expect(Number(fundedBal2) - Number(connectedPayerBal) === 3000, 'Connected: payer debited 3000');

    console.log('\n--- Merchant Payment: Suspense Path ---');
    // Create merchant where user_id === payer (suspense path)
    const suspenseMerchantRes = await client.query(
      "INSERT INTO merchants (user_id, name, business_type, phone, is_active) VALUES ($1, 'SuspenseMerchant', 'RETAIL', '255700000003', true) RETURNING id",
      [uid]
    );
    const suspenseMerchantId = suspenseMerchantRes.rows[0].id;

    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);
    const fundedBal3 = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;

    const suspenseResult = await merchantService.payMerchant(uid, suspenseMerchantId, 2000, 'Suspense payment', { client });
    await expect(suspenseResult.success === true, 'Suspense payment succeeded', JSON.stringify(suspenseResult));
    const suspRef = suspenseResult.reference;
    const suspTx = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [suspRef]);
    await expect(suspTx.rows.length === 1, 'Suspense: transaction row created');
    const suspTxId = suspTx.rows[0].id;
    const suspFo = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [suspRef]);
    await expect(suspFo.rows.length > 0 && suspFo.rows[0].transaction_id === suspTxId, 'Suspense: financial_operations linked');
    const suspJe = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [suspRef]);
    await expect(suspJe.rows.length > 0 && suspJe.rows[0].transaction_id === suspTxId, 'Suspense: journal_entries linked');
    const suspPayerBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await expect(Number(fundedBal3) - Number(suspPayerBal) === 2000, 'Suspense: payer debited 2000');

    // Rollback test
    console.log('\n--- Merchant Payment: Rollback (insufficient funds) ---');
    const beforeRollback = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    try {
      await merchantService.payMerchant(uid, legacyMerchantId, 999999, 'Should fail', { client });
      fail('Insufficient funds payment rejected', 'payment succeeded unexpectedly');
    } catch (e) {
      ok('Insufficient funds payment rejected');
    }
    const afterRollback = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await expect(Number(beforeRollback) === Number(afterRollback), 'No wallet change on failed payment');

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
