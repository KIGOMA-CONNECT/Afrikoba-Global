'use strict';
const { Pool } = require('/tmp/afrikoba-phase68-deposit-fix/node_modules/pg');
const vicobaService = require('/tmp/afrikoba-phase68-deposit-fix/src/services/vicobaService');

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

    console.log('\n--- VICOBA Penalty Linkage Test ---');

    // Create a VICOBA group
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status) VALUES ('TestGroup3', $1, 1000, 'ACTIVE') RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;

    // Add member
    await client.query(
      "INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MJUMBE')",
      [groupId, uid]
    );

    // Create a penalty
    const penaltyRes = await client.query(
      "INSERT INTO vicoba_penalties (group_id, user_id, penalty_type, amount, reason, status) VALUES ($1, $2, 'LATE_CONTRIBUTION', 500, 'Late payment', 'UNPAID') RETURNING id",
      [groupId, uid]
    );
    const penaltyId = penaltyRes.rows[0].id;

    // Fund user wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 1000 WHERE id = $1', [uid]);

    await client.query('COMMIT');

    // Pay the penalty
    const result = await vicobaService.payPenalty(uid, penaltyId);
    await expect(result.success === true, 'VICOBA penalty payment succeeded', JSON.stringify(result));

    const ref = result.referenceId;
    const txRes = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txRes.rows.length === 1, 'Transaction row created for penalty');
    const txId = txRes.rows[0].id;

    // Check financial_operations (created by debitWallet with reference ${ref}:DR)
    const foRes = await client.query("SELECT transaction_id FROM financial_operations WHERE reference_id = $1", [ref + ':DR']);
    await expect(foRes.rows.length > 0 && foRes.rows[0].transaction_id === txId, 'Penalty: financial_operations linked', `got ${foRes.rows[0]?.transaction_id} expected ${txId}`);

    // Check journal_entries (created by debitWallet with reference ${ref}:DR)
    const jeRes = await client.query("SELECT transaction_id FROM journal_entries WHERE reference_id = $1", [ref + ':DR']);
    await expect(jeRes.rows.length > 0 && jeRes.rows[0].transaction_id === txId, 'Penalty: journal_entries linked', `got ${jeRes.rows[0]?.transaction_id} expected ${txId}`);

    // Verify penalty status updated
    const penaltyCheck = await client.query('SELECT status FROM vicoba_penalties WHERE id = $1', [penaltyId]);
    await expect(penaltyCheck.rows[0].status === 'PAID', 'Penalty status updated to PAID');

    console.log('\nVICOBA PENALTY LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
