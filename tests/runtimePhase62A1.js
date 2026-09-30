const assert = require('assert');

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '5436';
process.env.DB_NAME = 'afrikoba_regression';
process.env.DB_USER = 'afrikoba_r';
process.env.DB_PASSWORD = 'afrikoba_ro_strong';

const pg = require('pg');

let injectAuditFailure = false;
let auditFailureInjected = false;

const originalQuery = pg.Client.prototype.query;

pg.Client.prototype.query = function (...args) {
  const sql =
    typeof args[0] === 'string'
      ? args[0]
      : args[0] && typeof args[0].text === 'string'
        ? args[0].text
        : '';

  if (
    injectAuditFailure &&
    !auditFailureInjected &&
    /INSERT\s+INTO\s+financial_audit_log/i.test(sql)
  ) {
    auditFailureInjected = true;
    return Promise.reject(
      new Error('P62A1 injected audit INSERT failure')
    );
  }

  return originalQuery.apply(this, args);
};

const pool = require('../src/config/db');
const { postDeposit } = require('../src/services/financialEngine');

const TEST_REF = `P62A1_${Date.now()}`;
const TEST_AMOUNT = 1234;

async function scalar(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0];
}

async function main() {
  console.log(`A1 reference: ${TEST_REF}`);

  const setup = await pool.connect();

  let userId;
  let baseline;

  try {
    const user = await scalar(
      setup,
      `SELECT id, wallet_balance
         FROM users
        WHERE is_active = TRUE
          AND full_name LIKE 'ZZ %'
        ORDER BY id
        LIMIT 1`
    );

    assert(user, 'A1 setup failed: no isolated ZZ test user found.');

    userId = Number(user.id);

    baseline = {
      wallet: String(user.wallet_balance),
      operations: Number(
        (await scalar(
          setup,
          `SELECT COUNT(*)::int AS n
             FROM financial_operations
            WHERE user_id = $1`,
          [userId]
        )).n
      ),
      revenue: String(
        (await scalar(
          setup,
          `SELECT total_commission
             FROM company_revenue
            WHERE id = 1`
        )).total_commission
      )
    };

    console.log(`userId=${userId}`);
    console.log(`baseline wallet=${baseline.wallet}`);
    console.log(`baseline operations=${baseline.operations}`);
    console.log(`baseline revenue=${baseline.revenue}`);
  } finally {
    setup.release();
  }

  let failed = false;

  injectAuditFailure = true;

  try {
    await postDeposit({
      userId,
      amount: TEST_AMOUNT,
      commission: 0,
      reference: TEST_REF,
      externalTxId: null,
      description: 'Phase 62 A1 runtime rollback test'
    });
  } catch (error) {
    failed = true;
    console.log(`caught expected error: ${error.message}`);
  } finally {
    injectAuditFailure = false;
  }

  assert.strictEqual(
    auditFailureInjected,
    true,
    'A1 HARNESS FAIL: audit INSERT fault was not injected.'
  );

  assert.strictEqual(
    failed,
    true,
    'A1 FAIL: postDeposit unexpectedly succeeded despite audit INSERT failure.'
  );

  const verify = await pool.connect();

  try {
    const after = {
      wallet: String(
        (await scalar(
          verify,
          `SELECT wallet_balance
             FROM users
            WHERE id = $1`,
          [userId]
        )).wallet_balance
      ),

      operationCount: Number(
        (await scalar(
          verify,
          `SELECT COUNT(*)::int AS n
             FROM financial_operations
            WHERE reference_id = $1`,
          [TEST_REF]
        )).n
      ),

      journalCount: Number(
        (await scalar(
          verify,
          `SELECT COUNT(*)::int AS n
             FROM journal_entries
            WHERE reference_id = $1`,
          [TEST_REF]
        )).n
      ),

      auditCount: Number(
        (await scalar(
          verify,
          `SELECT COUNT(*)::int AS n
             FROM financial_audit_log
            WHERE reference_id = $1`,
          [TEST_REF]
        )).n
      ),

      revenue: String(
        (await scalar(
          verify,
          `SELECT total_commission
             FROM company_revenue
            WHERE id = 1`
        )).total_commission
      )
    };

    console.log(`after wallet=${after.wallet}`);
    console.log(`after operations=${after.operationCount}`);
    console.log(`after journals=${after.journalCount}`);
    console.log(`after audits=${after.auditCount}`);
    console.log(`after revenue=${after.revenue}`);

    assert.strictEqual(
      after.wallet,
      baseline.wallet,
      'A1 FAIL: wallet balance changed despite audit failure.'
    );

    assert.strictEqual(
      after.operationCount,
      0,
      'A1 FAIL: financial operation residue remained for the test reference.'
    );

    assert.strictEqual(
      after.journalCount,
      0,
      'A1 FAIL: journal residue remained for the test reference.'
    );

    assert.strictEqual(
      after.auditCount,
      0,
      'A1 FAIL: audit residue remained for the failed test reference.'
    );

    assert.strictEqual(
      after.revenue,
      baseline.revenue,
      'A1 FAIL: company revenue changed despite audit failure.'
    );

    console.log('');
    console.log('PASS #A1 runtime: audit INSERT failure propagated and transaction rolled back');
    console.log('PASS #A1 wallet unchanged');
    console.log('PASS #A1 financial operation rolled back');
    console.log('PASS #A1 journal rolled back');
    console.log('PASS #A1 audit residue absent');
    console.log('PASS #A1 company revenue unchanged');

  } finally {
    verify.release();
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error('');
  console.error('FAIL #A1 runtime');
  console.error(error.stack || error.message);

  try {
    await pool.end();
  } catch (_) {}

  process.exitCode = 1;
});
