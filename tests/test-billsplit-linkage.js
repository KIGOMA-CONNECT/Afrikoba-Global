'use strict';
const { Pool } = require('/tmp/afrikoba-phase68-deposit-fix/node_modules/pg');
const billSplitService = require('/tmp/afrikoba-phase68-deposit-fix/src/services/billSplitService');

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

    console.log('\n--- Bill Split Linkage Test ---');

    // Fund payer
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);

    // Create a bill split
    const splitRes = await client.query(
      "INSERT INTO bill_splits (creator_id, title, total_amount, split_count, per_person, status) VALUES ($1, 'TestSplit', 5000, 1, 5000, 'PENDING') RETURNING id",
      [uid2]
    );
    const splitId = splitRes.rows[0].id;

    // Add participant
    await client.query(
      "INSERT INTO bill_split_participants (split_id, user_id, amount_owed, amount_paid, status) VALUES ($1, $2, 5000, 0, 'PENDING')",
      [splitId, uid]
    );

    await client.query('COMMIT');

    // Pay the split
    const result = await billSplitService.paySplit(splitId, uid, 5000);
    await expect(result.success === true, 'Bill split payment succeeded', JSON.stringify(result));

    const ref = result.reference || (await client.query('SELECT reference_id FROM transactions WHERE type = \'TRANSFER\' ORDER BY id DESC LIMIT 1')).rows[0]?.reference_id;
    // Find the transaction
    // Find the transaction created by paySplit
    const txRes = await pool.query("SELECT id, reference_id FROM transactions WHERE type = 'TRANSFER' AND meta::text LIKE '%BILL_SPLIT%' ORDER BY id DESC LIMIT 1");
    await expect(txRes.rows.length === 1, 'Transaction row created for bill split');
    const txId = txRes.rows[0].id;
    const txRef = txRes.rows[0].reference_id;

    const foRes = await pool.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [txRef]);
    await expect(foRes.rows.length > 0 && foRes.rows[0].transaction_id === txId, 'Bill split: financial_operations linked', `got ${foRes.rows[0]?.transaction_id} expected ${txId}`);

    const jeRes = await pool.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [txRef]);
    await expect(jeRes.rows.length > 0 && jeRes.rows[0].transaction_id === txId, 'Bill split: journal_entries linked', `got ${jeRes.rows[0]?.transaction_id} expected ${txId}`);

    console.log('\nBILL SPLIT LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
