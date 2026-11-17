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

    // Create group + member with leadership role
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status) VALUES ('WithdrawalTestGroup', $1, 1000, 'ACTIVE') RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;
    await client.query(
      "INSERT INTO vicoba_members (group_id, user_id, role_in_group, contribution_balance) VALUES ($1, $2, 'MWENYEKITI', 5000)",
      [groupId, uid]
    );
    await client.query('COMMIT');

    // Test 1: requestWithdrawal with sufficient balance
    const result = await vicobaService.requestWithdrawal(uid, groupId, 1000);
    await expect(result.success === true, 'requestWithdrawal succeeded', JSON.stringify(result));

    // Verify withdrawal record created
    const wdRes = await client.query('SELECT id, status, amount, reference_id FROM vicoba_withdrawals WHERE group_id = $1 AND user_id = $2', [groupId, uid]);
    await expect(wdRes.rows.length === 1, 'Withdrawal record created');
    await expect(Number(wdRes.rows[0].amount) === 1000, 'Withdrawal amount recorded', `got ${wdRes.rows[0].amount}`);
    await expect(wdRes.rows[0].status === 'PENDING', 'Withdrawal status PENDING', `got ${wdRes.rows[0].status}`);

    // Test 2: requestWithdrawal with insufficient balance
    let insufficientRejected = false;
    try {
      await vicobaService.requestWithdrawal(uid, groupId, 99999);
    } catch (e) {
      insufficientRejected = true;
    }
    await expect(insufficientRejected, 'Insufficient balance rejected');

    // Test 3: requestWithdrawal by non-member
    let nonMemberRejected = false;
    try {
      await vicobaService.requestWithdrawal(999999, groupId, 100);
    } catch (e) {
      nonMemberRejected = true;
    }
    await expect(nonMemberRejected, 'Non-member rejected');

    // Test 4: requestWithdrawal with invalid amount
    let invalidAmountRejected = false;
    try {
      await vicobaService.requestWithdrawal(uid, groupId, -100);
    } catch (e) {
      invalidAmountRejected = true;
    }
    await expect(invalidAmountRejected, 'Invalid amount (negative) rejected');

    let zeroAmountRejected = false;
    try {
      await vicobaService.requestWithdrawal(uid, groupId, 0);
    } catch (e) {
      zeroAmountRejected = true;
    }
    await expect(zeroAmountRejected, 'Invalid amount (zero) rejected');

    await client.query('ROLLBACK');
    console.log('\nVICOBA WITHDRAWAL REQUEST TESTS: ' + passed + ' passed, ' + failed + ' failed');
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