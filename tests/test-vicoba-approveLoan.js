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
    // R34 S5: three-tier chain (KATIBU -> MHASIBU/MWEKAHAZINA -> MWENYEKITI) needs three different
    // officers who are not the applicant, in a group of more than three members.
    const chairId = (await client.query("INSERT INTO users (full_name, phone_number) VALUES ('R30 Fixture Chair', $1) RETURNING id", ['2559' + String(Date.now()).slice(-8)])).rows[0].id;
    const katibuId = (await client.query("INSERT INTO users (full_name, phone_number) VALUES ('R34 Fixture Katibu', $1) RETURNING id", ['2558' + String(Date.now()).slice(-8)])).rows[0].id;

    // Create group
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ('LoanTestGroup', $1, 1000, 'ACTIVE', 5000) RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;

    // Add chairman (chairId), applicant member (uid), treasurer (uid2) and secretary (katibuId): four members
    await client.query("INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MWENYEKITI')", [groupId, chairId]);
    await client.query("INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MJUMBE')", [groupId, uid]);
    await client.query("INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MWEKAHAZINA')", [groupId, uid2]);
    await client.query("INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'KATIBU')", [groupId, katibuId]);

    // Fund applicant wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 1000 WHERE id = $1', [uid]);
    await client.query('COMMIT');

    // Request loan (the member uid submits their own request; interest comes from the group)
    const loan = await vicobaService.requestLoan(uid, { groupId, requestedAmount: 2000, repaymentMonths: 3 });
    await expect(loan && loan.id, 'Loan requested', JSON.stringify(loan));

    // KATIBU, then MHASIBU (treasurer verifies the amount), then MWENYEKITI approves and disburses
    await vicobaService.decideLoanStep(katibuId, loan.id, { step: 'KATIBU', decision: 'APPROVE' });
    await vicobaService.decideLoanStep(uid2, loan.id, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: 2000 });
    const approveResult = await vicobaService.approveLoan(chairId, loan.id, 2000);
    await expect(approveResult.success === true, 'approveLoan succeeded', JSON.stringify(approveResult));

    // Verify transaction created
    const ref = `VICOBA:LOAN:${loan.id}:DISBURSE`;
    const txRes = await client.query('SELECT id, status FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txRes.rows.length === 1, 'Transaction row created');
    await expect(txRes.rows[0].status === 'SUCCESS', 'Transaction status SUCCESS', `got ${txRes.rows[0].status}`);

    // Verify group balance decreased
    const groupBal = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;
    await expect(Number(groupBal) === 3000, 'Group balance decreased to 3000', `got ${groupBal}`);

    // Verify loan status DISBURSED
    const loanStatus = (await client.query('SELECT status FROM vicoba_loan_requests WHERE id = $1', [loan.id])).rows[0].status;
    await expect(loanStatus === 'DISBURSED', 'Loan status DISBURSED', `got ${loanStatus}`);

    // Test: final approval before the KATIBU and MHASIBU steps rejected (no step skipping)
    const loan2 = await vicobaService.requestLoan(uid, { groupId, requestedAmount: 1000, repaymentMonths: 3 });
    let nonTreasurerRejected = false;
    try {
      await vicobaService.approveLoan(chairId, loan2.id, 1000);
    } catch (e) {
      nonTreasurerRejected = e.statusCode === 409;
    }
    await expect(nonTreasurerRejected, 'Non-treasurer approval rejected');

    // Test: verified amount exceeding requested rejected (MHASIBU step)
    const loan3 = await vicobaService.requestLoan(uid, { groupId, requestedAmount: 1000, repaymentMonths: 3 });
    await vicobaService.decideLoanStep(katibuId, loan3.id, { step: 'KATIBU', decision: 'APPROVE' });
    let excessiveAmountRejected = false;
    try {
      await vicobaService.decideLoanStep(uid2, loan3.id, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: 2000 });
    } catch (e) {
      excessiveAmountRejected = e.statusCode === 400;
    }
    await expect(excessiveAmountRejected, 'Excessive amount rejected');

    await client.query('ROLLBACK');
    console.log('\nVICOBA APPROVE LOAN TESTS: ' + passed + ' passed, ' + failed + ' failed');
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