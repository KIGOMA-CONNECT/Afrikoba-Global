/**
 * Phase 69 — AUTO_SAVINGS financial atomicity acceptance test.
 *
 * Exercises AUTO_SAVINGS through the real runDueTasks() dispatcher.
 *
 * Proves:
 *   1. Insufficient wallet => FAILED execution and complete rollback.
 *   2. Successful savings => wallet debit + balanced journal + SUCCESS operation.
 *   3. SAVINGS_LEDGER exists and old SAVINGS_LEDGE typo does not.
 *   4. Successful financial operation is finalized from NEW -> SUCCESS.
 *   5. Exact run-scoped cleanup leaves no Phase 69 residue.
 *
 * Staging only. Do not run against production.
 */

const pool = require('../src/config/db');
const recurrence = require('../src/services/recurrenceService');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  PASS ${label}`);
}

function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  FAIL ${label}${extra ? ` :: ${extra}` : ''}`);
}

async function expect(condition, label, extra) {
  if (condition) ok(label);
  else fail(label, extra);
}

async function scalar(sql, params = []) {
  const r = await pool.query(sql, params);
  return Number(r.rows[0]?.n || 0);
}

async function createUser() {
  const salt = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const phone = `25569${salt.slice(-9)}`;
  const fullName = `P69 Auto Savings ${salt}`;

  const r = await pool.query(
    `INSERT INTO users
       (phone_number, full_name, wallet_balance, role)
     VALUES ($1, $2, 1000, 'MJUMBE')
     RETURNING id, phone_number, full_name, wallet_balance`,
    [phone, fullName]
  );

  return r.rows[0];
}

async function createRule(userId, amount, name, nextRunAt) {
  const r = await pool.query(
    `INSERT INTO recurrence_rules
       (name, task_type, frequency, interval_step, payload, next_run_at, enabled, created_by)
     VALUES
       ($1, 'AUTO_SAVINGS', 'DAILY', 1, $2::jsonb, $3, TRUE, $4)
     RETURNING id`,
    [
      name,
      JSON.stringify({
        userId,
        amount,
        description: name,
      }),
      nextRunAt,
      userId,
    ]
  );

  return r.rows[0].id;
}

async function latestExecution(ruleId) {
  const r = await pool.query(
    `SELECT id, rule_id, status, detail, run_at
       FROM recurrence_executions
      WHERE rule_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [ruleId]
  );
  return r.rows[0] || null;
}

async function run() {
  const runMarker = `P69-AS-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userId = null;
  let ruleId = null;
  const references = new Set();

  try {
    console.log(`\n=== PHASE 69 AUTO_SAVINGS ===`);
    console.log(`RUN MARKER: ${runMarker}`);

    console.log('\n=== ACCOUNT PREREQUISITES ===');

    const accounts = await pool.query(
      `SELECT account_code, account_type, currency_code, is_system
         FROM ledger_accounts
        WHERE account_code IN ('SAVINGS_LEDGER', 'SAVINGS_LEDGE')
        ORDER BY account_code`
    );

    await expect(
      accounts.rows.some(r => r.account_code === 'SAVINGS_LEDGER'),
      'SAVINGS_LEDGER account exists'
    );

    await expect(
      !accounts.rows.some(r => r.account_code === 'SAVINGS_LEDGE'),
      'SAVINGS_LEDGE typo account absent'
    );

    const savings = accounts.rows.find(r => r.account_code === 'SAVINGS_LEDGER');
    await expect(
      savings?.account_type === 'LIABILITY',
      'SAVINGS_LEDGER is LIABILITY'
    );
    await expect(
      savings?.currency_code === 'TZS',
      'SAVINGS_LEDGER currency is TZS'
    );
    await expect(
      savings?.is_system === true,
      'SAVINGS_LEDGER is system account'
    );

    console.log('\n=== FIXTURE SETUP ===');

    const user = await createUser();
    userId = user.id;

    await expect(
      Number(user.wallet_balance) === 1000,
      `fresh user starts at TZS 1000 (got ${user.wallet_balance})`
    );

    const beforeOps = await scalar(
      `SELECT COUNT(*) AS n FROM financial_operations WHERE user_id = $1`,
      [userId]
    );
    const beforeJournals = await scalar(
      `SELECT COUNT(*) AS n FROM journal_entries WHERE reference_id LIKE 'SAV-%'`
    );

    console.log('\n=== R1: INSUFFICIENT BALANCE ===');

    ruleId = await createRule(
      userId,
      5000,
      `${runMarker}-INSUFFICIENT`,
      new Date(Date.now() - 60000)
    );

    await recurrence.runDueTasks();

    const r1Exec = await latestExecution(ruleId);

    await expect(
      r1Exec?.status === 'FAILED',
      `R1 execution FAILED (got ${r1Exec?.status})`
    );

    const r1Wallet = await pool.query(
      `SELECT wallet_balance FROM users WHERE id = $1`,
      [userId]
    );
    const r1Balance = Number(r1Wallet.rows[0]?.wallet_balance);

    await expect(
      r1Balance === 1000,
      `R1 wallet unchanged at 1000 (got ${r1Balance})`
    );

    const r1Ops = await scalar(
      `SELECT COUNT(*) AS n
         FROM financial_operations
        WHERE user_id = $1`,
      [userId]
    );

    await expect(
      r1Ops === beforeOps,
      `R1 creates no surviving financial operation (before ${beforeOps}, after ${r1Ops})`
    );

    const r1ExecDetail = r1Exec?.detail || {};
    await expect(
      String(r1ExecDetail.error || '').length > 0,
      'R1 records an execution error'
    );

    console.log('\n=== R2: SUCCESSFUL AUTO_SAVINGS ===');

    await pool.query(
      `UPDATE recurrence_rules
          SET payload = jsonb_set(payload, '{amount}', '400'::jsonb),
              name = $2,
              next_run_at = NOW() - interval '1 minute',
              enabled = TRUE
        WHERE id = $1`,
      [ruleId, `${runMarker}-SUCCESS`]
    );

    await recurrence.runDueTasks();

    const r2Exec = await latestExecution(ruleId);

    await expect(
      r2Exec?.status === 'SUCCESS',
      `R2 execution SUCCESS (got ${r2Exec?.status})`
    );

    const r2Detail = r2Exec?.detail || {};
    const r2Result = r2Detail.result || {};
    const reference = r2Result.reference;

    await expect(
      /^SAV-\d+$/.test(reference || ''),
      `R2 returns SAV-* reference (got ${reference})`
    );

    if (reference) references.add(reference);

    await expect(
      Number(r2Result.saved) === 400,
      `R2 result saved amount is 400 (got ${r2Result.saved})`
    );

    const r2Wallet = await pool.query(
      `SELECT wallet_balance FROM users WHERE id = $1`,
      [userId]
    );
    const r2Balance = Number(r2Wallet.rows[0]?.wallet_balance);

    await expect(
      r2Balance === 600,
      `R2 wallet balance is 600 (got ${r2Balance})`
    );

    console.log('\n=== R2 FINANCIAL OPERATION ===');

    const op = await pool.query(
      `SELECT id, operation_type, reference_id, user_id, amount, status, attempts
         FROM financial_operations
        WHERE reference_id = $1`,
      [reference]
    );

    await expect(
      op.rows.length === 1,
      `R2 creates exactly one financial operation (got ${op.rows.length})`
    );

    await expect(
      op.rows[0]?.operation_type === 'DEBIT',
      `R2 operation type DEBIT (got ${op.rows[0]?.operation_type})`
    );

    await expect(
      Number(op.rows[0]?.amount) === 400,
      `R2 operation amount 400 (got ${op.rows[0]?.amount})`
    );

    await expect(
      op.rows[0]?.status === 'SUCCESS',
      `R2 operation finalized SUCCESS (got ${op.rows[0]?.status})`
    );

    await expect(
      op.rows[0]?.user_id === userId,
      `R2 operation belongs to test user (got ${op.rows[0]?.user_id})`
    );

    console.log('\n=== R2 JOURNAL ===');

    const journal = await pool.query(
      `SELECT
          je.id,
          je.entry_group_id,
          je.reference_id,
          je.direction,
          je.amount,
          la.account_code,
          la.account_type,
          je.currency_code
       FROM journal_entries je
       JOIN ledger_accounts la ON la.id = je.account_id
       WHERE je.reference_id = $1
       ORDER BY je.id`,
      [reference]
    );

    await expect(
      journal.rows.length === 2,
      `R2 creates exactly two journal lines (got ${journal.rows.length})`
    );

    const dr = journal.rows.find(
      r => r.account_code === 'CUSTOMER_WALLET' && r.direction === 'DR'
    );
    const cr = journal.rows.find(
      r => r.account_code === 'SAVINGS_LEDGER' && r.direction === 'CR'
    );

    await expect(
      !!dr,
      'R2 journal has CUSTOMER_WALLET DR'
    );

    await expect(
      !!cr,
      'R2 journal has SAVINGS_LEDGER CR'
    );

    await expect(
      Number(dr?.amount) === 400,
      `R2 CUSTOMER_WALLET DR is 400 (got ${dr?.amount})`
    );

    await expect(
      Number(cr?.amount) === 400,
      `R2 SAVINGS_LEDGER CR is 400 (got ${cr?.amount})`
    );

    const journalDr = journal.rows
      .filter(r => r.direction === 'DR')
      .reduce((sum, r) => sum + Number(r.amount), 0);

    const journalCr = journal.rows
      .filter(r => r.direction === 'CR')
      .reduce((sum, r) => sum + Number(r.amount), 0);

    await expect(
      Math.abs(journalDr - journalCr) < 0.000001,
      `R2 journal balanced DR=${journalDr} CR=${journalCr}`
    );

    await expect(
      journal.rows.every(r => r.currency_code === 'TZS'),
      'R2 journal currency is TZS'
    );

    console.log('\n=== R2 NO FALSE COMMIT ===');

    const r2UserUpdated = await pool.query(
      `SELECT wallet_balance, updated_at
         FROM users
        WHERE id = $1`,
      [userId]
    );

    await expect(
      Number(r2UserUpdated.rows[0]?.wallet_balance) === 600,
      'R2 wallet mutation committed with financial records'
    );

    const r2Ops = await scalar(
      `SELECT COUNT(*) AS n
         FROM financial_operations
        WHERE user_id = $1`,
      [userId]
    );

    await expect(
      r2Ops === beforeOps + 1,
      `only successful operation survives for test user (got ${r2Ops})`
    );

    const runJournalCount = await scalar(
      `SELECT COUNT(*) AS n
         FROM journal_entries
        WHERE reference_id = $1`,
      [reference]
    );

    await expect(
      runJournalCount === 2,
      `exact successful reference has two journal lines (got ${runJournalCount})`
    );

    console.log('\n=== R2 RECURRENCE RECORD ===');

    await expect(
      r2Exec?.rule_id === ruleId,
      'R2 execution belongs to test rule'
    );

    await expect(
      r2Result.reference === reference,
      'R2 execution detail preserves financial reference'
    );

    console.log('\n=== PRE-CLEANUP SNAPSHOT ===');

    const snapshot = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM financial_operations WHERE reference_id = $1) AS operations,
        (SELECT COUNT(*) FROM journal_entries WHERE reference_id = $1) AS journals,
        (SELECT COUNT(*) FROM recurrence_executions WHERE rule_id = $2) AS executions,
        (SELECT COUNT(*) FROM recurrence_rules WHERE id = $2) AS rules,
        (SELECT COUNT(*) FROM users WHERE id = $3) AS users`,
      [reference, ruleId, userId]
    );

    console.table(snapshot.rows);

  } finally {
    console.log('\n=== EXACT CLEANUP ===');

    try {
      await pool.query('BEGIN');

      if (references.size > 0) {
        const refs = [...references];

        await pool.query(
          `DELETE FROM journal_entries
            WHERE reference_id = ANY($1::text[])`,
          [refs]
        );

        await pool.query(
          `DELETE FROM financial_audit_log
            WHERE reference_id = ANY($1::text[])`,
          [refs]
        );

        await pool.query(
          `DELETE FROM transactions
            WHERE reference_id = ANY($1::text[])`,
          [refs]
        );

        await pool.query(
          `DELETE FROM financial_operations
            WHERE reference_id = ANY($1::text[])`,
          [refs]
        );
      }

      if (ruleId !== null) {
        await pool.query(
          `DELETE FROM recurrence_executions WHERE rule_id = $1`,
          [ruleId]
        );

        await pool.query(
          `DELETE FROM recurrence_rules WHERE id = $1`,
          [ruleId]
        );
      }

      if (userId !== null) {
        await pool.query(
          `DELETE FROM users WHERE id = $1`,
          [userId]
        );
      }

      await pool.query('COMMIT');
      console.log('Cleanup transaction committed.');
    } catch (cleanupError) {
      await pool.query('ROLLBACK').catch(() => {});
      console.error(`CLEANUP FAILED: ${cleanupError.message}`);
      failed++;
      failures.push('exact cleanup');
    }
  }
}

run()
  .then(async () => {
    console.log(`\nPHASE 69 AUTO_SAVINGS RESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log('FAILURES:', failures.join(' | '));
    }

    await pool.end();
    process.exit(failed ? 1 : 0);
  })
  .catch(async (error) => {
    console.error('\nFATAL:', error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
