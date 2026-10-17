const pg = require('pg');

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '5436';
process.env.DB_NAME = 'afrikoba_regression';
process.env.DB_USER = 'afrikoba_r';
process.env.DB_PASSWORD = 'afrikoba_ro_strong';

const USER_ID = 1;
const AMOUNT = 1000;
const REF_A = `P62A2_A_${Date.now()}`;
const REF_B = `P62A2_B_${Date.now()}`;

let a2Active = false;
let lockSelectCount = 0;
let firstLockSelectEntered = false;
let firstLockSelectReleased = false;

const originalQuery = pg.Client.prototype.query;

pg.Client.prototype.query = function (...args) {
  const sql =
    typeof args[0] === 'string'
      ? args[0]
      : args[0] && typeof args[0].text === 'string'
        ? args[0].text
        : '';

  const isWalletLock =
    /SELECT\s+wallet_balance\s+FROM\s+users\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(sql);

  if (a2Active && isWalletLock) {
    lockSelectCount += 1;

    return originalQuery.apply(this, args).then(async (result) => {
      if (!firstLockSelectEntered) {
        firstLockSelectEntered = true;

        console.log('A2 first transaction acquired wallet row lock; holding it for 1500ms...');

        await new Promise(resolve => setTimeout(resolve, 1500));

        firstLockSelectReleased = true;
        console.log('A2 first transaction releasing application-side delay.');
      }

      return result;
    });
  }

  return originalQuery.apply(this, args);
};

const pool = require('../src/config/db');
const { postDeposit } = require('../src/services/financialEngine');

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function main() {
  const baseline = await query(
    `SELECT wallet_balance FROM users WHERE id = $1`,
    [USER_ID]
  );

  if (baseline.rows.length !== 1) {
    throw new Error(`User ${USER_ID} not found`);
  }

  const baselineWallet = Number(baseline.rows[0].wallet_balance);

  console.log(`A2 userId=${USER_ID}`);
  console.log(`A2 baseline wallet=${baselineWallet.toFixed(2)}`);
  console.log(`A2 refs=${REF_A}, ${REF_B}`);

  a2Active = true;

  const started = Date.now();

  const pA = postDeposit({
    userId: USER_ID,
    amount: AMOUNT,
    commission: 0,
    reference: REF_A,
    description: 'Phase 62 A2 concurrent deposit A'
  });

  const pB = postDeposit({
    userId: USER_ID,
    amount: AMOUNT,
    commission: 0,
    reference: REF_B,
    description: 'Phase 62 A2 concurrent deposit B'
  });

  const results = await Promise.allSettled([pA, pB]);

  a2Active = false;

  const elapsed = Date.now() - started;

  console.log(`A2 elapsed=${elapsed}ms`);
  console.log(`A2 results=${JSON.stringify(results)}`);
  console.log(`A2 lock-select count=${lockSelectCount}`);
  console.log(`A2 first lock delay completed=${firstLockSelectReleased}`);

  const after = await query(
    `SELECT wallet_balance FROM users WHERE id = $1`,
    [USER_ID]
  );

  const finalWallet = Number(after.rows[0].wallet_balance);

  const ops = await query(
    `SELECT reference_id, operation_type, amount, status
       FROM financial_operations
      WHERE reference_id IN ($1, $2)
      ORDER BY reference_id`,
    [REF_A, REF_B]
  );

  const journals = await query(
    `SELECT reference_id, account_id, direction, amount
       FROM journal_entries
      WHERE reference_id IN ($1, $2)
      ORDER BY reference_id, id`,
    [REF_A, REF_B]
  );

  const audits = await query(
    `SELECT reference_id, account_kind, operation,
            amount, balance_before, balance_after
       FROM financial_audit_log
      WHERE reference_id IN ($1, $2)
      ORDER BY reference_id, id`,
    [REF_A, REF_B]
  );

  console.log(`A2 final wallet=${finalWallet.toFixed(2)}`);
  console.log(`A2 expected wallet=${(baselineWallet + 2 * AMOUNT).toFixed(2)}`);
  console.log(`A2 operations=${JSON.stringify(ops.rows)}`);
  console.log(`A2 journals=${JSON.stringify(journals.rows)}`);
  console.log(`A2 audits=${JSON.stringify(audits.rows)}`);

  const bothSucceeded =
    results.every(r => r.status === 'fulfilled') &&
    results[0].value &&
    results[1].value;

  const walletCorrect =
    finalWallet === baselineWallet + 2 * AMOUNT;

  const successOps =
    ops.rows.length === 2 &&
    ops.rows.every(r =>
      r.operation_type === 'DEPOSIT' &&
      Number(r.amount) === AMOUNT &&
      r.status === 'SUCCESS'
    );

  const journalBalanced =
    journals.rows.length === 4 &&
    journals.rows.every(r => Number(r.amount) === AMOUNT) &&
    journals.rows.filter(r => r.direction === 'DR').length === 2 &&
    journals.rows.filter(r => r.direction === 'CR').length === 2;

  const userAudits =
    audits.rows.length === 2 &&
    audits.rows.every(r =>
      r.account_kind === 'USER_BALANCE' &&
      r.operation === 'deposit' &&
      Number(r.amount) === AMOUNT
    );

  const auditValues = audits.rows
    .map(r => `${Number(r.balance_before)}->${Number(r.balance_after)}`)
    .sort();

  const expectedAuditValues = [
    `${baselineWallet}->${baselineWallet + AMOUNT}`,
    `${baselineWallet + AMOUNT}->${baselineWallet + 2 * AMOUNT}`
  ].sort();

  const sequentialAudits =
    auditValues.length === expectedAuditValues.length &&
    auditValues.every((v, i) => v === expectedAuditValues[i]);

  if (bothSucceeded) {
    console.log('PASS #A2 both concurrent deposits succeeded');
  } else {
    console.log('FAIL #A2 both concurrent deposits succeeded');
  }

  if (walletCorrect) {
    console.log('PASS #A2 final wallet reflects both deposits');
  } else {
    console.log('FAIL #A2 final wallet does not reflect both deposits');
  }

  if (successOps) {
    console.log('PASS #A2 both financial operations SUCCESS');
  } else {
    console.log('FAIL #A2 financial operations incorrect');
  }

  if (journalBalanced) {
    console.log('PASS #A2 journal entries are balanced');
  } else {
    console.log('FAIL #A2 journal entries incorrect');
  }

  if (userAudits) {
    console.log('PASS #A2 two user balance audits recorded');
  } else {
    console.log('FAIL #A2 user balance audits incorrect');
  }

  if (sequentialAudits) {
    console.log('PASS #A2 audit before/after snapshots are sequential');
  } else {
    console.log('FAIL #A2 audit snapshots are not sequential');
  }

  const allPass =
    bothSucceeded &&
    walletCorrect &&
    successOps &&
    journalBalanced &&
    userAudits &&
    sequentialAudits;

  console.log(allPass
    ? '\nA2 RUNTIME RESULT: PASS'
    : '\nA2 RUNTIME RESULT: FAIL');

  process.exitCode = allPass ? 0 : 1;
}

main()
  .catch(err => {
    console.error('A2 HARNESS ERROR:', err.stack || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    setTimeout(() => {
      pool.end().catch(() => {});
    }, 100);
  });
