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

    // Create group
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance, penalty_rate, max_penalty_percent) VALUES ('RepayLoanTestGroup', $1, 1000, 'ACTIVE', 10000, 5, 10) RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;

    // Add chairman (uid) and treasurer (uid2)
    await client.query("INSERT INTO vicoba_members (group_id, user_id, role_in_group, contribution_balance) VALUES ($1, $2, 'MWENYEKITI', 5000)", [groupId, uid]);
    await client.query("INSERT INTO vicoba_members (group_id, user_id, role_in_group, contribution_balance) VALUES ($1, $2, 'MWEKAHAZINA', 5000)", [groupId, uid2]);

    // Fund applicant wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);
    await client.query('COMMIT');

    // Request loan (by chairman, for uid as applicant)
    const loan = await vicobaService.requestLoan(uid, { groupId, applicantUserId: uid, requestedAmount: 2000, interestRate: 10, repaymentMonths: 3 });
    await expect(loan && loan.id, 'Loan requested', JSON.stringify(loan));

    // Approve loan (by treasurer) - this disburses it
    const approveResult = await vicobaService.approveLoan(uid2, loan.id, 2000);
    await expect(approveResult.success === true, 'approveLoan succeeded', JSON.stringify(approveResult));

    // Verify loan is DISBURSED
    const loanStatus = (await client.query('SELECT status, outstanding_balance FROM vicoba_loan_requests WHERE id = $1', [loan.id])).rows[0];
    await expect(loanStatus.status === 'DISBURSED', 'Loan status DISBURSED', `got ${loanStatus.status}`);

    // Capture initial balances
    const userBalBefore = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    const groupBalBefore = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;

    // Test 1: Normal repayment
    const repayResult = await vicobaService.repayLoan(uid, loan.id, 500, 'Test repayment');
    await expect(repayResult.success === true, 'repayLoan succeeded', JSON.stringify(repayResult));

    // Verify transaction created
    const txRes = await client.query("SELECT id, status FROM transactions WHERE reference_id = $1", [repayResult.referenceId]);
    await expect(txRes.rows.length === 1, 'Transaction row created');
    await expect(txRes.rows[0].status === 'SUCCESS', 'Transaction status SUCCESS', `got ${txRes.rows[0].status}`);
    const txId = txRes.rows[0].id;

    // Verify financial_operations linked
    const foRes = await client.query("SELECT transaction_id FROM financial_operations WHERE reference_id = $1 OR reference_id LIKE $1 || ':%'", [repayResult.referenceId]);
    await expect(foRes.rows.length > 0, 'Financial operations exist');
    const linkedFo = foRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedFo.length > 0, 'At least one financial_operation linked', `found ${linkedFo.length} of ${foRes.rows.length}`);

    // Verify journal_entries linked
    const jeRes = await client.query("SELECT transaction_id, direction, amount FROM journal_entries WHERE reference_id = $1 OR reference_id LIKE $1 || ':%'", [repayResult.referenceId]);
    await expect(jeRes.rows.length > 0, 'Journal entries exist');
    const linkedJe = jeRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedJe.length > 0, 'At least one journal_entry linked', `found ${linkedJe.length} of ${jeRes.rows.length}`);

    // Verify loan outstanding decreased
    const loanAfter = (await client.query('SELECT outstanding_balance, total_repaid FROM vicoba_loan_requests WHERE id = $1', [loan.id])).rows[0];
    await expect(Number(loanAfter.total_repaid) === 500, 'Loan total_repaid updated', `got ${loanAfter.total_repaid}`);

    // Test 2: Exact replay (no key -> deterministic reference)
    const repayResult2 = await vicobaService.repayLoan(uid, loan.id, 500, 'Test repayment');
    await expect(repayResult2.dedup === true, 'Replay returns dedup: true', JSON.stringify(repayResult2));

    // Verify no new transaction created
    const txRes2 = await client.query("SELECT id FROM transactions WHERE reference_id = $1", [repayResult.referenceId]);
    await expect(txRes2.rows.length === 1, 'No new transaction on replay', `got ${txRes2.rows.length}`);

    // Test 3: Same key with different amount rejected
    const repayResult3 = await vicobaService.repayLoan(uid, loan.id, 100, 'Test repayment 2', 'KEY2');
    await expect(repayResult3.success === true, 'New repayment with different key succeeded');

    let amountMismatchRejected = false;
    try {
      await vicobaService.repayLoan(uid, loan.id, 200, 'Test repayment 2', 'KEY2');
    } catch (e) {
      amountMismatchRejected = true;
    }
    await expect(amountMismatchRejected, 'Same key different amount rejected');

    // Test 4: Invalid amount (0)
    let zeroRejected = false;
    try {
      await vicobaService.repayLoan(uid, loan.id, 0, 'Test');
    } catch (e) {
      zeroRejected = true;
    }
    await expect(zeroRejected, 'Zero amount rejected');

    // Test 5: Invalid amount (negative)
    let negRejected = false;
    try {
      await vicobaService.repayLoan(uid, loan.id, -100, 'Test');
    } catch (e) {
      negRejected = true;
    }
    await expect(negRejected, 'Negative amount rejected');

    // Test 6: Non-owner (different userId)
    let nonOwnerRejected = false;
    try {
      await vicobaService.repayLoan(uid2, loan.id, 100, 'Test');
    } catch (e) {
      nonOwnerRejected = true;
    }
    await expect(nonOwnerRejected, 'Non-owner rejected');

    // Test 7: Loan not DISBURSED
    const loan2 = await vicobaService.requestLoan(uid, { groupId, applicantUserId: uid, requestedAmount: 1000, interestRate: 10, repaymentMonths: 3 });
    let notDisbursedRejected = false;
    try {
      await vicobaService.repayLoan(uid, loan2.id, 100, 'Test');
    } catch (e) {
      notDisbursedRejected = true;
    }
    await expect(notDisbursedRejected, 'Not disbursed loan rejected');

    // Test 8: Invalid idempotency key format
    let invalidKeyRejected = false;
    try {
      await vicobaService.repayLoan(uid, loan.id, 100, 'Test', '!!!invalid!!!');
    } catch (e) {
      invalidKeyRejected = true;
    }
    await expect(invalidKeyRejected, 'Invalid idempotency key rejected');

    await client.query('ROLLBACK');
    console.log('\nVICOBA REPAY LOAN TESTS: ' + passed + ' passed, ' + failed + ' failed');
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