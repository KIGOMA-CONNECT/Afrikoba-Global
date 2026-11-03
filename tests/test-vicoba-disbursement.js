'use strict';
const { Pool } = require('pg');
const vicobaService = require('../src/services/vicobaService');

const DB_NAME = process.env.DB_NAME || '';
if (!/^(phase68_amount_guard_[a-z0-9_]+|afrikoba_global)$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
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

    console.log('\n--- VICOBA Social Fund Disbursement Linkage Test ---');

    // Create a VICOBA group
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status) VALUES ('TestGroup4', $1, 1000, 'ACTIVE') RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;

    // Add member
    await client.query(
      "INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MWENYEKITI')",
      [groupId, uid]
    );
    await client.query(
      "INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MJUMBE')",
      [groupId, uid2]
    );

    // Initialize social fund
    await client.query(
      "INSERT INTO vicoba_social_fund (group_id, monthly_contribution, total_balance, total_collected, total_disbursed) VALUES ($1, 1000, 5000, 5000, 0)",
      [groupId]
    );
    const fund = (await client.query('SELECT id FROM vicoba_social_fund WHERE group_id = $1', [groupId])).rows[0];

    // Fund requester wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 100 WHERE id = $1', [uid2]);

    await client.query('COMMIT');

    // Request disbursement
    const request = await vicobaService.requestSocialFundDisbursement(groupId, uid2, {
      reasonType: 'DEATH',
      reasonDetail: 'Family emergency',
      requestedAmount: 2000
    });
    await expect(request.id, 'Social fund disbursement requested', JSON.stringify(request));

    // Approve disbursement (as chairman)
    const result = await vicobaService.approveSocialFundDisbursement(uid, request.id, 2000);
    await expect(result.success === true, 'Social fund disbursement approved', JSON.stringify(result));

    const ref = result.referenceId;
    const txRes = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txRes.rows.length === 1, 'Transaction row created for disbursement');
    const txId = txRes.rows[0].id;

    // Check financial_operations (created by groupToWallet with reference ${ref}:GW)
    const foRes = await client.query("SELECT transaction_id FROM financial_operations WHERE reference_id = $1", [ref + ':GW']);
    await expect(foRes.rows.length > 0 && foRes.rows[0].transaction_id === txId, 'Disbursement: financial_operations linked', `got ${foRes.rows[0]?.transaction_id} expected ${txId}`);

    // Check journal_entries (created by groupToWallet with reference ${ref}:GW)
    const jeRes = await client.query("SELECT transaction_id FROM journal_entries WHERE reference_id = $1", [ref + ':GW']);
    await expect(jeRes.rows.length > 0 && jeRes.rows[0].transaction_id === txId, 'Disbursement: journal_entries linked', `got ${jeRes.rows[0]?.transaction_id} expected ${txId}`);

    // Verify requester wallet increased
    const requesterBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid2])).rows[0].wallet_balance;
    await expect(Number(requesterBal) >= 2000, 'Requester wallet increased', `got ${requesterBal}`);

    console.log('\nVICOBA SOCIAL FUND DISBURSEMENT LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
