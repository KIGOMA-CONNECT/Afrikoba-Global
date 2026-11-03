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
    const uid = (await client.query('SELECT user_id FROM saccos_members LIMIT 1')).rows[0].user_id;

    console.log('\n--- SACCOS Savings Deposit Linkage Test (Trigger-based) ---');

    // Check if SACCOS tables exist
    const tables = await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'saccos'");
    if (tables.rows[0].n === 0) {
      console.log('  SKIP: SACCOS tables not found');
      await client.query('ROLLBACK');
      process.exit(0);
    }

    // Check if there's an active SACCOS org
    const orgs = await client.query("SELECT id FROM saccos WHERE status = 'ACTIVE' LIMIT 1");
    if (orgs.rows.length === 0) {
      console.log('  SKIP: No active SACCOS org found');
      await client.query('ROLLBACK');
      process.exit(0);
    }

    const saccosId = orgs.rows[0].id;

    // Check if user is a member
    const member = await client.query("SELECT id FROM saccos_members WHERE saccos_id = $1 AND user_id = $2", [saccosId, uid]);
    if (member.rows.length === 0) {
      console.log('  SKIP: User is not a SACCOS member');
      await client.query('ROLLBACK');
      process.exit(0);
    }

    // Fund user wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);

    // Create a savings deposit reference
    const ref = 'SACCOS-TEST-' + Date.now();

    // Insert financial_operation (simulating debitWallet)
    await client.query(
      "INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status) VALUES ('DEBIT', $1, $2, 5000, 'SUCCESS')",
      [ref, uid]
    );

    // Insert journal entry
    const acctId = (await client.query('SELECT id FROM ledger_accounts LIMIT 1')).rows[0].id;
    await client.query(
      "INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id) VALUES ($1, $2, 'DR', 5000, $3)",
      [ref, acctId, ref]
    );

    // Insert transaction (trigger should link them)
    const txRes = await client.query(
      "INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta) VALUES ($1, $2, 5000, 0, 5000, 'SUCCESS', 'SACCOS_SAVINGS_DEPOSIT', $3) RETURNING id",
      [ref, uid, JSON.stringify({ saccosId, test: true })]
    );
    const txId = txRes.rows[0].id;

    // Verify trigger linked them
    const foRes = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref]);
    await expect(foRes.rows.length > 0 && foRes.rows[0].transaction_id === txId, 'SACCOS: financial_operations linked', `got ${foRes.rows[0]?.transaction_id} expected ${txId}`);

    const jeRes = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1', [ref]);
    await expect(jeRes.rows.length > 0 && jeRes.rows[0].transaction_id === txId, 'SACCOS: journal_entries linked', `got ${jeRes.rows[0]?.transaction_id} expected ${txId}`);

    // Verify rollback safety
    await client.query('ROLLBACK');

    const checkClient = await pool.connect();
    const txCheck = await checkClient.query('SELECT id FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txCheck.rows.length === 0, 'SACCOS: transaction rolled back');
    const foCheck = await checkClient.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [ref]);
    await expect(foCheck.rows.length === 0, 'SACCOS: financial_operation rolled back');
    checkClient.release();

    console.log('\nSACCOS SAVINGS DEPOSIT LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
