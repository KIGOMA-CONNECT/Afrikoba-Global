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
    const uid2 = (await client.query('SELECT id FROM users ORDER BY id OFFSET 1 LIMIT 1')).rows[0].id;

    // Create group with sufficient balance
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ('ApproveWdTestGroup', $1, 1000, 'ACTIVE', 10000) RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;

    // Add chairman (uid) and treasurer (uid2)
    await client.query("INSERT INTO vicoba_members (group_id, user_id, role_in_group, contribution_balance) VALUES ($1, $2, 'MWENYEKITI', 5000)", [groupId, uid]);
    await client.query("INSERT INTO vicoba_members (group_id, user_id, role_in_group, contribution_balance) VALUES ($1, $2, 'MWEKAHAZINA', 5000)", [groupId, uid2]);

    // Fund user wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);
    await client.query('COMMIT');

    // Test 1: Request withdrawal
    const wdResult = await vicobaService.requestWithdrawal(uid, groupId, 1000);
    await expect(wdResult.success === true, 'requestWithdrawal succeeded', JSON.stringify(wdResult));

    const wdRes = await client.query('SELECT id, status, amount, reference_id FROM vicoba_withdrawals WHERE group_id = $1 AND user_id = $2', [groupId, uid]);
    await expect(wdRes.rows.length === 1, 'Withdrawal record created');
    const withdrawalId = wdRes.rows[0].id;
    const wdRef = wdRes.rows[0].reference_id;
    await expect(wdRes.rows[0].status === 'PENDING', 'Withdrawal status PENDING', `got ${wdRes.rows[0].status}`);

    // Capture initial balances
    const groupBalBefore = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;
    const memberBalBefore = (await client.query('SELECT contribution_balance FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, uid])).rows[0].contribution_balance;
    const userBalBefore = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;

    // Test 2: Partial approval (chairman only)
    const partialResult = await vicobaService.approveWithdrawal(uid, withdrawalId, { approved: true, note: 'Chairman approved' });
    await expect(partialResult.success === true, 'Chairman partial approval succeeded', JSON.stringify(partialResult));
    await expect(partialResult.message.includes('Inasubiri'), 'Partial approval message', partialResult.message);

    // Verify no financial movement on partial approval
    const groupBalPartial = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;
    await expect(Number(groupBalPartial) === Number(groupBalBefore), 'No group balance change on partial', `got ${groupBalPartial} (was ${groupBalBefore})`);

    // Test 3: Complete approval (treasurer)
    const completeResult = await vicobaService.approveWithdrawal(uid2, withdrawalId, { approved: true, note: 'Treasurer approved' });
    await expect(completeResult.success === true, 'Treasurer approval (disbursement) succeeded', JSON.stringify(completeResult));

    // Verify withdrawal status DISBURSED
    const wdStatus = (await client.query('SELECT status FROM vicoba_withdrawals WHERE id = $1', [withdrawalId])).rows[0].status;
    await expect(wdStatus === 'DISBURSED', 'Withdrawal status DISBURSED', `got ${wdStatus}`);

    // Verify transaction created
    const txRes = await client.query('SELECT id, status, reference_id FROM transactions WHERE reference_id = $1', [wdRef]);
    await expect(txRes.rows.length === 1, 'Transaction row created');
    await expect(txRes.rows[0].status === 'SUCCESS', 'Transaction status SUCCESS', `got ${txRes.rows[0].status}`);
    const txId = txRes.rows[0].id;

    // Verify financial_operations linked
    const foRes = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1', [wdRef]);
    await expect(foRes.rows.length > 0, 'Financial operations exist');
    const linkedFo = foRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedFo.length > 0, 'At least one financial_operation linked', `found ${linkedFo.length} of ${foRes.rows.length}`);

    // Verify journal_entries linked
    const jeRes = await client.query('SELECT transaction_id, direction, amount FROM journal_entries WHERE reference_id = $1', [wdRef]);
    await expect(jeRes.rows.length > 0, 'Journal entries exist');
    const linkedJe = jeRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedJe.length > 0, 'At least one journal_entry linked', `found ${linkedJe.length} of ${jeRes.rows.length}`);

    // Verify group balance decreased
    const groupBalAfter = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;
    await expect(Number(groupBalAfter) === Number(groupBalBefore) - 1000, 'Group balance decreased by 1000', `got ${groupBalAfter} (was ${groupBalBefore})`);

    // Verify member contribution decreased
    const memberBalAfter = (await client.query('SELECT contribution_balance FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, uid])).rows[0].contribution_balance;
    await expect(Number(memberBalAfter) === Number(memberBalBefore) - 1000, 'Member contribution decreased by 1000', `got ${memberBalAfter} (was ${memberBalBefore})`);

    // Test 4: Duplicate approval replay (both already approved)
    let dupRejected = false;
    try {
      await vicobaService.approveWithdrawal(uid, withdrawalId, { approved: true, note: 'Duplicate' });
    } catch (e) {
      dupRejected = true;
    }
    await expect(dupRejected, 'Duplicate approval rejected (already DISBURSED)');

    // Test 5: Rejection on new withdrawal
    const wdResult2 = await vicobaService.requestWithdrawal(uid, groupId, 500);
    await expect(wdResult2.success === true, 'Second withdrawal requested');
    const wdRes2 = await client.query('SELECT id FROM vicoba_withdrawals WHERE group_id = $1 AND user_id = $2 AND status = \'PENDING\' ORDER BY id DESC LIMIT 1', [groupId, uid]);
    const withdrawalId2 = wdRes2.rows[0].id;

    const rejectResult = await vicobaService.approveWithdrawal(uid, withdrawalId2, { approved: false, note: 'Rejected' });
    await expect(rejectResult.success === true, 'Rejection succeeded', JSON.stringify(rejectResult));

    const wdStatus2 = (await client.query('SELECT status FROM vicoba_withdrawals WHERE id = $1', [withdrawalId2])).rows[0].status;
    await expect(wdStatus2 === 'REJECTED', 'Withdrawal status REJECTED', `got ${wdStatus2}`);

    // Verify no financial movement on rejection
    const txCount = (await client.query('SELECT count(*)::int AS n FROM transactions WHERE reference_id = (SELECT reference_id FROM vicoba_withdrawals WHERE id = $1)', [withdrawalId2])).rows[0].n;
    await expect(txCount === 0, 'No transaction on rejected withdrawal', `got ${txCount}`);

    // Test 6: Insufficient group balance - request a large amount that exceeds remaining contribution
    let largeWdRejected = false;
    try {
      await vicobaService.requestWithdrawal(uid, groupId, 99999);
    } catch (e) {
      largeWdRejected = true;
    }
    await expect(largeWdRejected, 'Large withdrawal request rejected (insufficient balance)');

    // Test insufficient group balance: directly insert a withdrawal with amount exceeding group balance
    const largeWd = await client.query(
      "INSERT INTO vicoba_withdrawals (group_id, user_id, amount, reference_id, status) VALUES ($1, $2, 99999, $3, 'PENDING') RETURNING id",
      [groupId, uid, 'WD-LARGE-' + Date.now()]
    );
    const withdrawalId3 = largeWd.rows[0].id;
    // Set chairman and treasurer IDs to simulate partial approval
    await client.query(
      "UPDATE vicoba_withdrawals SET chairman_id = $1, treasurer_id = $2, chairman_at = NOW(), treasurer_at = NOW() WHERE id = $3",
      [uid, uid2, withdrawalId3]
    );

    // Chairman tries to approve (should fail due to insufficient group balance)
    let insufficientRejected = false;
    try {
      await vicobaService.approveWithdrawal(uid, withdrawalId3, { approved: true, note: 'Chairman' });
    } catch (e) {
      insufficientRejected = true;
    }
    await expect(insufficientRejected, 'Insufficient balance rejected on disbursement');

    // Test 7: Unauthorized approval (non-member)
    const wdResult4 = await vicobaService.requestWithdrawal(uid, groupId, 100);
    await expect(wdResult4.success === true, 'Fourth withdrawal requested');
    const wdRes4 = await client.query('SELECT id FROM vicoba_withdrawals WHERE group_id = $1 AND user_id = $2 AND status = \'PENDING\' ORDER BY id DESC LIMIT 1', [groupId, uid]);
    const withdrawalId4 = wdRes4.rows[0].id;

    let unauthorizedRejected = false;
    try {
      await vicobaService.approveWithdrawal(999999, withdrawalId4, { approved: true, note: 'Unauthorized' });
    } catch (e) {
      unauthorizedRejected = true;
    }
    await expect(unauthorizedRejected, 'Unauthorized approval rejected');

    // Test 8: Invalid amount (negative) on request
    let invalidAmountRejected = false;
    try {
      await vicobaService.requestWithdrawal(uid, groupId, -100);
    } catch (e) {
      invalidAmountRejected = true;
    }
    await expect(invalidAmountRejected, 'Invalid amount (negative) rejected');

    await client.query('ROLLBACK');
    console.log('\nVICOBA APPROVE WITHDRAWAL TESTS: ' + passed + ' passed, ' + failed + ' failed');
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