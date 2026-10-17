/* ============================================================
 * AFRIKOBA GLOBAL - PHASE 69
 * Wallet Debit Invariant Runtime Harness
 *
 * Runs directly against the staging database using the current
 * worktree services.
 *
 * Scope
 *   FAMILY
 *     F1  familySpend sufficient
 *     F2  familySpend insufficient
 *     F3  failed familySpend => no financial residue
 *     F4  familyTransfer sufficient
 *     F5  familyTransfer insufficient
 *     F6  failed familyTransfer => no recipient credit/residue
 *
 *   SACCOS CREDIT
 *     S1  repayLoan sufficient
 *     S2  repayLoan insufficient => wallet unchanged
 *     S3  repayLoan insufficient => loan unchanged
 *     S4  repayLoan insufficient => no financial/domain residue
 *
 *   SACCOS INSTALLMENTS
 *     I1  payInstallment sufficient
 *     I2  insufficient wallet => installment unchanged
 *     I3  insufficient wallet => loan unchanged
 *     I4  insufficient wallet => no financial/domain residue
 *
 * Critical invariant:
 *   A failed wallet debit must rollback the entire transaction.
 * ============================================================ */

const pool = require('../src/config/db');
const family = require('../src/services/familyService');
const saccosCore = require('../src/services/saccosService');
const credit = require('../src/services/saccosCreditService');
const installments = require('../src/services/saccosInstallmentService');

let passed = 0;
let failed = 0;
const failures = [];

const created = {
  users: new Set(),
  familyWallets: new Set(),
  saccos: new Set(),
  loans: new Set(),
  applications: new Set(),
  installmentIds: new Set(),
};

function ok(label) {
  passed += 1;
  console.log(`  PASS ${label}`);
}

function fail(label, extra = '') {
  failed += 1;
  const suffix = extra ? ` :: ${extra}` : '';
  failures.push(`${label}${suffix}`);
  console.error(`  FAIL ${label}${suffix}`);
}

function expect(condition, label, extra = '') {
  if (condition) ok(label);
  else fail(label, extra);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

const RUN_MARKER = unique('P69-RUN');

async function scalar(sql, params = []) {
  const r = await pool.query(sql, params);
  return Number(r.rows[0].n);
}

async function userBalance(userId) {
  const r = await pool.query(
    'SELECT wallet_balance FROM users WHERE id = $1',
    [userId]
  );
  if (!r.rows.length) throw new Error(`User ${userId} not found`);
  return Number(r.rows[0].wallet_balance);
}

async function familyBalance(walletId) {
  const r = await pool.query(
    'SELECT balance FROM family_wallets WHERE id = $1',
    [walletId]
  );
  if (!r.rows.length) throw new Error(`Family wallet ${walletId} not found`);
  return Number(r.rows[0].balance);
}

/*
 * Global financial snapshot.
 *
 * This is intentionally taken immediately before and after each
 * failure-path test. The staging harness is expected to run in an
 * otherwise controlled database, so a failed debit must produce
 * exactly zero change.
 */
async function financialSnapshot() {
  const [ops, journal, tx, audit] = await Promise.all([
    scalar(`
      SELECT COUNT(*)::int AS n
      FROM financial_operations
    `),
    scalar(`
      SELECT COUNT(*)::int AS n
      FROM journal_entries
    `),
    scalar(`
      SELECT COUNT(*)::int AS n
      FROM transactions
    `),
    scalar(`
      SELECT COUNT(*)::int AS n
      FROM financial_audit_log
    `),
  ]);

  return { operations: ops, journal, transactions: tx, audit };
}

function financialDelta(before, after) {
  return {
    operations: after.operations - before.operations,
    journal: after.journal - before.journal,
    transactions: after.transactions - before.transactions,
    audit: after.audit - before.audit,
  };
}

function zeroDelta(delta) {
  return (
    delta.operations === 0 &&
    delta.journal === 0 &&
    delta.transactions === 0 &&
    delta.audit === 0
  );
}

async function domainCounts({ userId, saccosId, loanId, installmentId }) {
  const out = {};

  if (userId !== undefined) {
    out.userTransactions = await scalar(`
      SELECT COUNT(*)::int AS n
      FROM transactions
      WHERE user_id = $1
    `, [userId]);
  }

  if (saccosId !== undefined) {
    out.repayments = await scalar(`
      SELECT COUNT(*)::int AS n
      FROM saccos_loan_repayments
      WHERE saccos_id = $1
    `, [saccosId]);

    out.installments = await scalar(`
      SELECT COUNT(*)::int AS n
      FROM saccos_loan_installments
      WHERE saccos_id = $1
    `, [saccosId]);
  }

  if (loanId !== undefined) {
    out.loanRepayments = await scalar(`
      SELECT COUNT(*)::int AS n
      FROM saccos_loan_repayments
      WHERE loan_id = $1
    `, [loanId]);
  }

  if (installmentId !== undefined) {
    out.installmentRepayments = await scalar(`
      SELECT COUNT(*)::int AS n
      FROM saccos_loan_repayments
      WHERE loan_id = (
        SELECT loan_id
        FROM saccos_loan_installments
        WHERE id = $1
      )
    `, [installmentId]);
  }

  return out;
}

async function createUser(label) {
  const phone = `2557${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 10)}`;

  const r = await pool.query(
    `INSERT INTO users (full_name, phone_number, wallet_balance)
     VALUES ($1, $2, 0)
     RETURNING id, full_name, phone_number`,
    [label, phone]
  );

  const user = r.rows[0];
  created.users.add(user.id);
  return user;
}

async function setWallet(userId, amount) {
  await pool.query(
    `UPDATE users
        SET wallet_balance = $1
      WHERE id = $2`,
    [amount, userId]
  );
}

async function createFamilyFixture() {
  const owner = await createUser('P69 Family Owner');
  const recipient = await createUser('P69 Family Recipient');

  const wallet = await pool.query(
    `INSERT INTO family_wallets
       (name, created_by, currency, balance, description)
     VALUES ($1, $2, 'TZS', $3, 'Phase 69 runtime fixture')
     RETURNING id`,
    [unique('P69-FAMILY'), owner.id, 10000]
  );

  const walletId = wallet.rows[0].id;
  created.familyWallets.add(walletId);

  await pool.query(
    `INSERT INTO family_wallet_members
       (wallet_id, user_id, role, can_spend, spending_limit, status, joined_at)
     VALUES ($1, $2, 'OWNER', TRUE, 0, 'ACTIVE', NOW())`,
    [walletId, owner.id]
  );

  return { owner, recipient, walletId };
}

async function testFamilySpend() {
  section('FAMILY SPEND');

  const { owner, walletId } = await createFamilyFixture();

  const before = await familyBalance(walletId);

  await family.familySpend(
    walletId,
    owner.id,
    3000,
    `${RUN_MARKER} successful family spend`
  );

  const after = await familyBalance(walletId);

  expect(
    after === before - 3000,
    'F1 familySpend sufficient debit'
  );

  const txCountBefore = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM family_wallet_transactions
    WHERE wallet_id = $1
  `, [walletId]);

  const failedFinancialBefore = await financialSnapshot();

  const failedWalletBefore = await familyBalance(walletId);

  let error = null;

  try {
    await family.familySpend(
      walletId,
      owner.id,
      8000,
      `${RUN_MARKER} insufficient family spend`
    );
  } catch (e) {
    error = e;
  }

  expect(
    !!error,
    'F2 familySpend insufficient throws'
  );

  const failedWalletAfter = await familyBalance(walletId);

  expect(
    failedWalletAfter === failedWalletBefore,
    'F2 familySpend insufficient leaves family balance unchanged',
    `before=${failedWalletBefore} after=${failedWalletAfter}`
  );

  const txCountAfter = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM family_wallet_transactions
    WHERE wallet_id = $1
  `, [walletId]);

  expect(
    txCountAfter === txCountBefore,
    'F2 familySpend insufficient leaves domain transaction count unchanged',
    `before=${txCountBefore} after=${txCountAfter}`
  );

  const failedFinancialAfter = await financialSnapshot();
  const delta = financialDelta(
    failedFinancialBefore,
    failedFinancialAfter
  );

  expect(
    zeroDelta(delta),
    'F3 failed familySpend leaves no financial residue',
    JSON.stringify(delta)
  );
}

async function testFamilyTransfer() {
  section('FAMILY TRANSFER');

  const { owner, recipient, walletId } = await createFamilyFixture();

  const sourceBefore = await familyBalance(walletId);
  const recipientBefore = await userBalance(recipient.id);

  await family.familyTransfer(
    walletId,
    owner.id,
    recipient.phone_number,
    3000
  );

  const sourceAfter = await familyBalance(walletId);
  const recipientAfter = await userBalance(recipient.id);

  expect(
    sourceAfter === sourceBefore - 3000,
    'F4 familyTransfer sufficient debits family wallet'
  );

  expect(
    recipientAfter === recipientBefore + 3000,
    'F4 familyTransfer sufficient credits recipient'
  );

  const failedSourceBefore = await familyBalance(walletId);
  const failedRecipientBefore = await userBalance(recipient.id);
  const failedTxBefore = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM family_wallet_transactions
    WHERE wallet_id = $1
  `, [walletId]);
  const failedFinancialBefore = await financialSnapshot();

  let error = null;

  try {
    await family.familyTransfer(
      walletId,
      owner.id,
      recipient.phone_number,
      8000
    );
  } catch (e) {
    error = e;
  }

  expect(
    !!error,
    'F5 familyTransfer insufficient throws'
  );

  const failedSourceAfter = await familyBalance(walletId);
  const failedRecipientAfter = await userBalance(recipient.id);

  expect(
    failedSourceAfter === failedSourceBefore,
    'F5 familyTransfer insufficient leaves source unchanged',
    `before=${failedSourceBefore} after=${failedSourceAfter}`
  );

  expect(
    failedRecipientAfter === failedRecipientBefore,
    'F6 failed familyTransfer leaves recipient unchanged',
    `before=${failedRecipientBefore} after=${failedRecipientAfter}`
  );

  const failedTxAfter = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM family_wallet_transactions
    WHERE wallet_id = $1
  `, [walletId]);

  expect(
    failedTxAfter === failedTxBefore,
    'F5 familyTransfer insufficient leaves domain transaction count unchanged',
    `before=${failedTxBefore} after=${failedTxAfter}`
  );

  const failedFinancialAfter = await financialSnapshot();
  const delta = financialDelta(
    failedFinancialBefore,
    failedFinancialAfter
  );

  expect(
    zeroDelta(delta),
    'F6 failed familyTransfer leaves no financial residue',
    JSON.stringify(delta)
  );
}

const SACCOS_CONFIG = {
  lending: {
    interestRate: 12,
    minAmount: 10000,
    maxAmount: 100000,
    maxTermMonths: 12,
    maxActiveLoans: 5,
    autoDisburse: true,
    guaranteesRequired: 0,
    savingsBackingEnabled: false,
  },
};

async function createSaccosFixture() {
  const owner = await createUser('P69 SACCOS Owner');
  const borrower = await createUser('P69 SACCOS Borrower');

  const result = await saccosCore.createSaccos(owner.id, {
    name: unique('P69-SACCOS'),
    registrationNumber: unique('P69REG'),
    countryCode: 'TZ',
    legalEntity: 'P69 Runtime Test',
    config: SACCOS_CONFIG,
  });

  const saccos = result.saccos;
  created.saccos.add(saccos.id);

  await saccosCore.activateSaccos(owner.id, saccos.id);

  const invitation = await saccosCore.inviteMember(
    owner.id,
    saccos.id,
    {
      phoneNumber: borrower.phone_number,
      role: 'MEMBER',
    }
  );

  await saccosCore.acceptMembership(
    borrower.id,
    saccos.id,
    invitation.id
  );

  return {
    owner,
    borrower,
    saccos,
    membership: invitation,
  };
}

async function createLoanFixture({
  owner,
  borrower,
  saccos,
  purpose,
}) {
  const app = await credit.applyLoan(
    borrower.id,
    saccos.id,
    {
      amount: 30000,
      termMonths: 3,
      purpose: purpose || 'P69 runtime wallet invariant',
    }
  );

  created.applications.add(app.id);

  const decision = await credit.decideApplication(
    owner.id,
    saccos.id,
    app.id,
    'APPROVE'
  );

  expect(
    decision && decision.success === true,
    `SACCOS application ${app.id} approved`
  );

  const appRow = await pool.query(
    `SELECT id, loan_id, status
       FROM saccos_loan_applications
      WHERE id = $1`,
    [app.id]
  );

  if (!appRow.rows.length || !appRow.rows[0].loan_id) {
    throw new Error(`Application ${app.id} did not produce a loan`);
  }

  const loanId = Number(appRow.rows[0].loan_id);
  created.loans.add(loanId);

  const generated = await installments.generateInstallments(
    owner.id,
    saccos.id,
    loanId
  );

  for (const row of generated.installments || []) {
    created.installmentIds.add(Number(row.id));
  }

  const loan = await pool.query(
    `SELECT id, member_id, application_id, principal,
            amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [loanId]
  );

  if (!loan.rows.length) {
    throw new Error(`Loan ${loanId} not found after approval`);
  }

  const firstInstallment = await pool.query(
    `SELECT id, installment_no, total, status
       FROM saccos_loan_installments
      WHERE loan_id = $1
      ORDER BY installment_no
      LIMIT 1`,
    [loanId]
  );

  if (!firstInstallment.rows.length) {
    throw new Error(`Loan ${loanId} has no installment schedule`);
  }

  created.installmentIds.add(Number(firstInstallment.rows[0].id));

  return {
    applicationId: app.id,
    loanId,
    loan: loan.rows[0],
    firstInstallment: firstInstallment.rows[0],
  };
}

async function testSaccosCredit() {
  section('SACCOS CREDIT');

  const fixture = await createSaccosFixture();

  const loan1 = await createLoanFixture({
    ...fixture,
    purpose: 'P69 repayLoan invariant',
  });

  const loan2 = await createLoanFixture({
    ...fixture,
    purpose: 'P69 installment invariant',
  });

  /*
   * The auto-disbursement itself should have funded the borrower.
   * We deliberately reset the wallet before each debit invariant test.
   */

  const loanBefore = await pool.query(
    `SELECT amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [loan1.loanId]
  );

  const repaymentBefore = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM saccos_loan_repayments
    WHERE loan_id = $1
  `, [loan1.loanId]);

  await setWallet(fixture.borrower.id, 499);

  const walletBefore = await userBalance(fixture.borrower.id);
  const financialBefore = await financialSnapshot();

  let error = null;

  try {
    await credit.repayLoan(
      fixture.borrower.id,
      fixture.saccos.id,
      loan1.loanId,
      { amount: 5000 }
    );
  } catch (e) {
    error = e;
  }

  expect(
    !!error,
    'S2 repayLoan insufficient wallet throws'
  );

  if (error) {
    expect(
      error.code === 'WALLET_INSUFFICIENT_FUNDS' ||
      /insufficient|salio|balance/i.test(error.message || ''),
      'S2 repayLoan failure is controlled insufficient-funds error',
      `${error.code || 'NO_CODE'} ${error.message || ''}`
    );
  }

  const walletAfter = await userBalance(fixture.borrower.id);

  expect(
    walletAfter === walletBefore,
    'S2 repayLoan insufficient leaves wallet unchanged',
    `before=${walletBefore} after=${walletAfter}`
  );

  const loanAfter = await pool.query(
    `SELECT amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [loan1.loanId]
  );

  expect(
    Number(loanAfter.rows[0].amount_outstanding) ===
      Number(loanBefore.rows[0].amount_outstanding),
    'S3 repayLoan insufficient leaves outstanding unchanged'
  );

  expect(
    loanAfter.rows[0].status === loanBefore.rows[0].status,
    'S3 repayLoan insufficient leaves loan status unchanged'
  );

  const repaymentAfter = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM saccos_loan_repayments
    WHERE loan_id = $1
  `, [loan1.loanId]);

  expect(
    repaymentAfter === repaymentBefore,
    'S4 repayLoan insufficient creates no repayment row',
    `before=${repaymentBefore} after=${repaymentAfter}`
  );

  const financialAfter = await financialSnapshot();
  const failedDelta = financialDelta(financialBefore, financialAfter);

  expect(
    zeroDelta(failedDelta),
    'S4 repayLoan insufficient leaves no financial residue',
    JSON.stringify(failedDelta)
  );

  /*
   * Successful repayment on the same loan after restoring funds.
   */
  await setWallet(fixture.borrower.id, 20000);

  const successWalletBefore = await userBalance(fixture.borrower.id);
  const successLoanBefore = await pool.query(
    `SELECT amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [loan1.loanId]
  );

  const successful = await credit.repayLoan(
    fixture.borrower.id,
    fixture.saccos.id,
    loan1.loanId,
    { amount: 5000 }
  );

  const successWalletAfter = await userBalance(fixture.borrower.id);
  const successLoanAfter = await pool.query(
    `SELECT amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [loan1.loanId]
  );

  expect(
    successWalletAfter === successWalletBefore - 5000,
    'S1 repayLoan sufficient debits wallet by requested amount'
  );

  expect(
    Number(successLoanAfter.rows[0].amount_outstanding) <
      Number(successLoanBefore.rows[0].amount_outstanding),
    'S1 repayLoan sufficient reduces outstanding'
  );

  expect(
    successful && successful.reference,
    'S1 repayLoan sufficient returns transaction reference'
  );

  const successRepayments = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM saccos_loan_repayments
    WHERE loan_id = $1
  `, [loan1.loanId]);

  expect(
    successRepayments === repaymentBefore + 1,
    'S1 repayLoan sufficient creates repayment row'
  );

  /*
   * Return enough funds for installment testing.
   */
  await setWallet(fixture.borrower.id, 20000);

  const instBefore = await pool.query(
    `SELECT status, total
       FROM saccos_loan_installments
      WHERE id = $1`,
    [loan2.firstInstallment.id]
  );

  const loan2Before = await pool.query(
    `SELECT amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [loan2.loanId]
  );

  const instRepaymentsBefore = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM saccos_loan_repayments
    WHERE loan_id = $1
  `, [loan2.loanId]);

  return {
    ...fixture,
    loan2,
    instBefore: instBefore.rows[0],
    loan2Before: loan2Before.rows[0],
    instRepaymentsBefore,
  };
}

async function testSaccosInstallment(fixture) {
  section('SACCOS INSTALLMENTS');

  await setWallet(fixture.borrower.id, 499);

  const walletBefore = await userBalance(fixture.borrower.id);
  const financialBefore = await financialSnapshot();

  const installmentBefore = await pool.query(
    `SELECT status, total
       FROM saccos_loan_installments
      WHERE id = $1`,
    [fixture.loan2.firstInstallment.id]
  );

  const loanBefore = await pool.query(
    `SELECT amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [fixture.loan2.loanId]
  );

  const repaymentBefore = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM saccos_loan_repayments
    WHERE loan_id = $1
  `, [fixture.loan2.loanId]);

  let error = null;

  try {
    await installments.payInstallment(
      fixture.borrower.id,
      fixture.saccos.id,
      fixture.loan2.loanId,
      fixture.loan2.firstInstallment.id
    );
  } catch (e) {
    error = e;
  }

  expect(
    !!error,
    'I2 payInstallment insufficient wallet throws'
  );

  if (error) {
    expect(
      error.code === 'WALLET_INSUFFICIENT_FUNDS' ||
      /insufficient|salio|balance/i.test(error.message || ''),
      'I2 payInstallment failure is controlled insufficient-funds error',
      `${error.code || 'NO_CODE'} ${error.message || ''}`
    );
  }

  const walletAfter = await userBalance(fixture.borrower.id);

  expect(
    walletAfter === walletBefore,
    'I2 insufficient installment payment leaves wallet unchanged',
    `before=${walletBefore} after=${walletAfter}`
  );

  const installmentAfter = await pool.query(
    `SELECT status, total
       FROM saccos_loan_installments
      WHERE id = $1`,
    [fixture.loan2.firstInstallment.id]
  );

  expect(
    installmentAfter.rows[0].status === installmentBefore.rows[0].status,
    'I2 insufficient installment payment leaves installment status unchanged',
    `before=${installmentBefore.rows[0].status} after=${installmentAfter.rows[0].status}`
  );

  const loanAfter = await pool.query(
    `SELECT amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [fixture.loan2.loanId]
  );

  expect(
    Number(loanAfter.rows[0].amount_outstanding) ===
      Number(loanBefore.rows[0].amount_outstanding),
    'I3 insufficient installment payment leaves loan outstanding unchanged'
  );

  expect(
    loanAfter.rows[0].status === loanBefore.rows[0].status,
    'I3 insufficient installment payment leaves loan status unchanged'
  );

  const repaymentAfter = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM saccos_loan_repayments
    WHERE loan_id = $1
  `, [fixture.loan2.loanId]);

  expect(
    repaymentAfter === repaymentBefore,
    'I4 insufficient installment payment creates no repayment row',
    `before=${repaymentBefore} after=${repaymentAfter}`
  );

  const financialAfter = await financialSnapshot();
  const failedDelta = financialDelta(financialBefore, financialAfter);

  expect(
    zeroDelta(failedDelta),
    'I4 insufficient installment payment leaves no financial residue',
    JSON.stringify(failedDelta)
  );

  /*
   * Successful first installment.
   *
   * For 30,000 principal, 12%, 3 months:
   * total repayable = 30,900
   * first installment = 10,300
   */
  await setWallet(fixture.borrower.id, 20000);

  const expectedAmount = Number(fixture.loan2.firstInstallment.total);
  const successWalletBefore = await userBalance(fixture.borrower.id);

  const successFinancialBefore = await financialSnapshot();

  const result = await installments.payInstallment(
    fixture.borrower.id,
    fixture.saccos.id,
    fixture.loan2.loanId,
    fixture.loan2.firstInstallment.id
  );

  const successWalletAfter = await userBalance(fixture.borrower.id);

  expect(
    successWalletAfter === successWalletBefore - expectedAmount,
    'I1 payInstallment sufficient debits wallet by installment amount',
    `expected=${expectedAmount} before=${successWalletBefore} after=${successWalletAfter}`
  );

  expect(
    result && result.reference,
    'I1 payInstallment sufficient returns transaction reference'
  );

  const paidInstallment = await pool.query(
    `SELECT status, paid_at, reference_id
       FROM saccos_loan_installments
      WHERE id = $1`,
    [fixture.loan2.firstInstallment.id]
  );

  expect(
    paidInstallment.rows[0].status === 'PAID',
    'I1 payInstallment sufficient marks installment PAID'
  );

  expect(
    !!paidInstallment.rows[0].reference_id,
    'I1 paid installment has reference'
  );

  const paidLoan = await pool.query(
    `SELECT amount_outstanding, status
       FROM saccos_loans
      WHERE id = $1`,
    [fixture.loan2.loanId]
  );

  expect(
    Number(paidLoan.rows[0].amount_outstanding) <
      Number(loanBefore.rows[0].amount_outstanding),
    'I1 payInstallment sufficient reduces loan outstanding'
  );

  const paidRepayments = await scalar(`
    SELECT COUNT(*)::int AS n
    FROM saccos_loan_repayments
    WHERE loan_id = $1
  `, [fixture.loan2.loanId]);

  expect(
    paidRepayments === repaymentBefore + 1,
    'I1 payInstallment sufficient creates repayment row'
  );

  const successFinancialAfter = await financialSnapshot();
  const successDelta = financialDelta(
    successFinancialBefore,
    successFinancialAfter
  );

  expect(
    successDelta.operations > 0,
    'I1 successful installment creates financial operation'
  );

  expect(
    successDelta.journal > 0,
    'I1 successful installment creates journal entries'
  );

  expect(
    successDelta.transactions > 0,
    'I1 successful installment creates transaction'
  );
}

async function cleanup() {
  section('CLEANUP');

  /*
   * Delete financial records associated with the fixture users.
   * Transactions must be removed before users because transactions.user_id
   * is restrictive. Journal entries reference transactions, so remove
   * journal rows first.
   */
  const userIds = [...created.users];

  if (userIds.length) {
    /*
     * Financial residue cleanup.
     *
     * Important: not every financial-engine operation creates a
     * transactions row. groupToWallet(), for example, can create
     * financial_audit_log + journal_entries directly. Therefore we
     * collect references from BOTH transactions and USER_BALANCE
     * financial audit rows before deleting either source.
     */

    const transactionRefs = await pool.query(`
      SELECT DISTINCT reference_id
      FROM transactions
      WHERE user_id = ANY($1::int[])
        AND reference_id IS NOT NULL
    `, [userIds]);

    const auditRefs = await pool.query(`
      SELECT DISTINCT reference_id
      FROM financial_audit_log
      WHERE account_kind = 'USER_BALANCE'
        AND account_id = ANY($1::int[])
        AND reference_id IS NOT NULL
    `, [userIds]);

    /*
     * familySpend() posts journal entries directly through postJournal()
     * and does not create a transactions or financial_audit_log row.
     * The Phase 69 harness gives these entries a unique P69 description,
     * so collect their references explicitly before deletion.
     */
    const p69JournalRefs = await pool.query(`
      SELECT DISTINCT reference_id
      FROM journal_entries
      WHERE description LIKE $1
        AND reference_id IS NOT NULL
    `, [`${RUN_MARKER}%`]);

    const referenceIds = [
      ...new Set([
        ...transactionRefs.rows.map((r) => r.reference_id),
        ...auditRefs.rows.map((r) => r.reference_id),
        ...p69JournalRefs.rows.map((r) => r.reference_id),
      ].filter(Boolean)),
    ];

    if (referenceIds.length) {
      await pool.query(
        `DELETE FROM journal_entries
         WHERE reference_id = ANY($1::text[])`,
        [referenceIds]
      );

      await pool.query(
        `DELETE FROM financial_operations
         WHERE reference_id = ANY($1::text[])`,
        [referenceIds]
      );

      await pool.query(
        `DELETE FROM financial_audit_log
         WHERE reference_id = ANY($1::text[])`,
        [referenceIds]
      );
    }

    /*
     * Transaction-linked journal entries must be removed before
     * transactions because journal_entries.transaction_id may FK
     * to transactions.id.
     */
    await pool.query(`
      DELETE FROM journal_entries
      WHERE transaction_id IN (
        SELECT id
        FROM transactions
        WHERE user_id = ANY($1::int[])
      )
    `, [userIds]);

    await pool.query(`
      DELETE FROM financial_operations
      WHERE user_id = ANY($1::int[])
    `, [userIds]);

    await pool.query(`
      DELETE FROM transactions
      WHERE user_id = ANY($1::int[])
    `, [userIds]);
  }

  /*
   * SACCOS domain tables.
   * Deleting the parent SACCOS removes the dependent SACCOS records
   * through the existing FK cascade definitions.
   */
  for (const saccosId of created.saccos) {
    await pool.query(
      `DELETE FROM saccos WHERE id = $1`,
      [saccosId]
    );
  }

  /*
   * Family domain records.
   */
  for (const walletId of created.familyWallets) {
    await pool.query(
      `DELETE FROM family_wallet_transactions WHERE wallet_id = $1`,
      [walletId]
    );

    await pool.query(
      `DELETE FROM family_wallet_members WHERE wallet_id = $1`,
      [walletId]
    );

    await pool.query(
      `DELETE FROM family_wallets WHERE id = $1`,
      [walletId]
    );
  }

  /*
   * Service-level audit logs are linked to fixture users.
   * audit_logs has no reference_id column; referenceId is stored
   * inside meta JSON. Delete by the fixture user IDs before users.
   */
  if (userIds.length) {
    await pool.query(
      `DELETE FROM audit_logs
       WHERE user_id = ANY($1::int[])`,
      [userIds]
    );
  }

  if (userIds.length) {
    await pool.query(
      `DELETE FROM users WHERE id = ANY($1::int[])`,
      [userIds]
    );
  }

  console.log(
    `  Cleanup complete: users=${userIds.length}, ` +
    `familyWallets=${created.familyWallets.size}, ` +
    `saccos=${created.saccos.size}, ` +
    `loans=${created.loans.size}`
  );
}

async function run() {
  try {
    await testFamilySpend();
    await testFamilyTransfer();

    const saccosFixture = await testSaccosCredit();
    await testSaccosInstallment(saccosFixture);

    console.log(
      `\nPHASE 69 RESULT: ${passed} passed, ${failed} failed`
    );

    if (failed) {
      console.log('\nFAILED ASSERTIONS:');
      for (const item of failures) {
        console.log(`  - ${item}`);
      }
      process.exitCode = 1;
    }
  } catch (e) {
    failed += 1;
    failures.push(`FATAL: ${e.message}`);
    console.error('\nFATAL:', e);
    process.exitCode = 1;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      failed += 1;
      failures.push(`CLEANUP FAILED: ${cleanupError.message}`);
      console.error('\nCLEANUP FAILED:', cleanupError);
      process.exitCode = 1;
    }

    await pool.end().catch(() => {});
  }
}

run();
