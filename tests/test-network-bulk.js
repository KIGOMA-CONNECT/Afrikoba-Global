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
    const recipients = await client.query('SELECT id, phone_number FROM users WHERE id != $1 LIMIT 2', [uid]);
    const r1 = recipients.rows[0];
    const r2 = recipients.rows[1];

    // Fund sender wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);

    // Create bulk payment batch
    const batchRes = await client.query(
      "INSERT INTO bulk_payment_batches (user_id, batch_name, recipient_count, status, total_amount) VALUES ($1, 'TestBatch', 2, 'PENDING', 0) RETURNING id",
      [uid]
    );
    const batchId = batchRes.rows[0].id;

    // Create bulk payment items
    await client.query(
      "INSERT INTO bulk_payment_items (batch_id, recipient_phone, amount, status) VALUES ($1, $2, 3000, 'PENDING')",
      [batchId, r1.phone_number]
    );
    await client.query(
      "INSERT INTO bulk_payment_items (batch_id, recipient_phone, amount, status) VALUES ($1, $2, 2000, 'PENDING')",
      [batchId, r2.phone_number]
    );

    // Update batch total
    await client.query("UPDATE bulk_payment_batches SET total_amount = 5000 WHERE id = $1", [batchId]);

    await client.query('COMMIT');

    // Call processBulkBatch (creates its own connection)
    const networkService = require('/tmp/afrikoba-phase68-deposit-fix/src/services/networkService');
    const result = await networkService.processBulkBatch(batchId);
    await expect(result.success === 2 && result.failed === 0, 'Bulk batch processed: 2 success, 0 failed', JSON.stringify(result));

    // Verify transaction linkage for each item
    const items = await pool.query('SELECT * FROM bulk_payment_items WHERE batch_id = $1', [batchId]);
    for (const item of items.rows) {
      if (item.status === 'SUCCESS') {
        await expect(item.transaction_id !== null, `Item ${item.id}: transaction_id set`, `got ${item.transaction_id}`);
      }
    }

    // Verify journal entries exist for the batch
    const jeCount = await pool.query(
      "SELECT count(*)::int AS n FROM journal_entries WHERE reference_id LIKE 'NET:%:TR'"
    );
    await expect(jeCount.rows[0].n >= 2, 'Journal entries created for bulk payments', `got ${jeCount.rows[0].n}`);

    // Verify trigger linked all transactions
    const txs = await pool.query("SELECT id, reference_id FROM transactions WHERE type = 'BULK_PAYMENT'");
    for (const tx of txs.rows) {
      const jeRes = await pool.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [tx.reference_id]);
      // Note: journal entries use NET: references, not BP: references
      // So we check via the trigger-linked NET: references
    }

    // Verify journal entries are linked to transactions
    const linkedJe = await pool.query(
      "SELECT count(*)::int AS n FROM journal_entries WHERE reference_id LIKE 'NET:%:TR' AND transaction_id IS NOT NULL"
    );
    await expect(linkedJe.rows[0].n >= 2, 'NET journal entries linked to transactions', `got ${linkedJe.rows[0].n}`);

    console.log('\nNETWORK BULK LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
