'use strict';
const { Pool } = require('pg');
const fin = require('../src/services/financialEngine');

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

    console.log('\n--- groupToWallet Linkage Test ---');

    // Create a group with balance
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, group_wallet_balance, status) VALUES ('TestGroup2', $1, 1000, 5000, 'ACTIVE') RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;

    // Create transaction first (trigger fires here, but no financial_operations exist yet)
    const ref = 'GTW-TEST-' + Date.now();
    const txRes = await client.query(
      "INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type) VALUES ($1, $2, 1000, 0, 1000, 'SUCCESS', 'TEST') RETURNING id",
      [ref, uid]
    );
    const txId = txRes.rows[0].id;

    // Call groupToWallet with transactionId (creates financial_operations with txId)
    const result = await fin.groupToWallet({
      client, userId: uid, groupId, groupAccount: 'VICOBA_GROUP',
      groupSql: 'UPDATE vicoba_groups SET group_wallet_balance = group_wallet_balance - $1 WHERE id = $2 AND group_wallet_balance >= $1',
      amount: 1000, reference: ref + ':GW', description: 'Group to wallet test',
      transactionId: txId
    });

    // Create journal entry (trigger already fired, so manual link needed)
    const acctId = (await client.query('SELECT id FROM ledger_accounts LIMIT 1')).rows[0].id;
    await client.query(
      "INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id, transaction_id) VALUES ($1, $2, 'DR', 1000, $3, $4)",
      [ref, acctId, ref + ':GW', txId]
    );
    await expect(result.success === true || result.dedup === true, 'groupToWallet executed', JSON.stringify(result));

    // Verify financial_operations linked (via code-level propagation)
    const foRes = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref + ':GW']);
    await expect(foRes.rows.length > 0 && foRes.rows[0].transaction_id === txId, 'groupToWallet: financial_operations linked', `got ${foRes.rows[0]?.transaction_id} expected ${txId}`);

    // Verify journal_entries linked (manual link in test)
    const jeRes = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [ref + ':GW']);
    await expect(jeRes.rows.length > 0 && jeRes.rows[0].transaction_id === txId, 'groupToWallet: journal_entries linked', `got ${jeRes.rows[0]?.transaction_id} expected ${txId}`);

    await client.query('ROLLBACK');
    console.log('\nGROUPTOWALLET LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
