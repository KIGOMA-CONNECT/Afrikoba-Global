'use strict';

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '5436';
process.env.DB_NAME = 'afrikoba_regression';
process.env.DB_USER = 'afrikoba_r';
process.env.DB_PASSWORD = 'afrikoba_ro_strong';

const pool = require('../src/config/db');
const { approveProfitDistribution } = require('../src/services/mkobaService');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function scalar(client, sql, params = []) {
  const r = await client.query(sql, params);
  return r.rows[0];
}

async function createFixture(client, suffix, groupBalance) {
  const userA = await scalar(client, `
    INSERT INTO users
      (full_name, phone_number, role, wallet_balance, locked_balance)
    VALUES
      ($1, $2, 'MJUMBE', 0, 0)
    RETURNING id
  `, [`PH65-A-${suffix}`, `2557${suffix}01`]);

  const userB = await scalar(client, `
    INSERT INTO users
      (full_name, phone_number, role, wallet_balance, locked_balance)
    VALUES
      ($1, $2, 'MJUMBE', 0, 0)
    RETURNING id
  `, [`PH65-B-${suffix}`, `2557${suffix}02`]);

  const group = await scalar(client, `
    INSERT INTO vicoba_groups
      (group_name, share_value, created_by_user_id, group_wallet_balance,
       group_type, country, language, currency_code)
    VALUES
      ($1, 10000, $2, $3, 'STANDARD', 'Tanzania', 'sw', 'TZS')
    RETURNING id
  `, [`PH65-${suffix}`, userA.id, groupBalance]);

  const distribution = await scalar(client, `
    INSERT INTO vicoba_profit_distributions
      (group_id, cycle_number, total_profit, total_shares_at_distribution,
       per_share_dividend, status)
    VALUES
      ($1, 1, 150, 3, 50, 'PENDING')
    RETURNING id
  `, [group.id]);

  const payoutA = await scalar(client, `
    INSERT INTO vicoba_profit_payouts
      (distribution_id, user_id, shares_count, dividend_amount,
       rollover_shares, paid)
    VALUES
      ($1, $2, 2, 100, 0, FALSE)
    RETURNING id
  `, [distribution.id, userA.id]);

  const payoutB = await scalar(client, `
    INSERT INTO vicoba_profit_payouts
      (distribution_id, user_id, shares_count, dividend_amount,
       rollover_shares, paid)
    VALUES
      ($1, $2, 1, 50, 0, FALSE)
    RETURNING id
  `, [distribution.id, userB.id]);

  return {
    userA: Number(userA.id),
    userB: Number(userB.id),
    group: Number(group.id),
    distribution: Number(distribution.id),
    payoutA: Number(payoutA.id),
    payoutB: Number(payoutB.id),
  };
}

async function readState(client, fixture) {
  const users = await client.query(`
    SELECT id, wallet_balance
    FROM users
    WHERE id = ANY($1::int[])
    ORDER BY id
  `, [[fixture.userA, fixture.userB]]);

  const group = await scalar(client, `
    SELECT group_wallet_balance
    FROM vicoba_groups
    WHERE id = $1
  `, [fixture.group]);

  const distribution = await scalar(client, `
    SELECT status, distributed_at
    FROM vicoba_profit_distributions
    WHERE id = $1
  `, [fixture.distribution]);

  const payouts = await client.query(`
    SELECT id, paid, paid_at
    FROM vicoba_profit_payouts
    WHERE distribution_id = $1
    ORDER BY id
  `, [fixture.distribution]);

  return {
    users: users.rows.map(r => ({
      id: Number(r.id),
      wallet: Number(r.wallet_balance)
    })),
    groupWallet: Number(group.group_wallet_balance),
    status: distribution.status,
    distributedAt: distribution.distributed_at,
    payouts: payouts.rows.map(r => ({
      id: Number(r.id),
      paid: r.paid,
      paidAt: r.paid_at
    }))
  };
}

async function countFinancialRows(client, fixture) {
  const journal = await scalar(client, `
    SELECT COUNT(*)::int AS n
    FROM journal_entries
    WHERE product_type = 'VICOBA'
      AND product_ref = $1
  `, [String(fixture.group)]);

  const operations = await scalar(client, `
    SELECT COUNT(*)::int AS n
    FROM financial_operations
    WHERE operation_type = 'GROUP_TO_WALLET'
      AND user_id = ANY($1::int[])
  `, [[fixture.userA, fixture.userB]]);

  const audit = await scalar(client, `
    SELECT COUNT(*)::int AS n
    FROM financial_audit_log
    WHERE operation = 'group_to_wallet'
      AND account_kind = 'USER_BALANCE'
      AND account_id = ANY($1::bigint[])
  `, [[fixture.userA, fixture.userB]]);

  const transactions = await scalar(client, `
    SELECT COUNT(*)::int AS n
    FROM transactions
    WHERE type = 'VICOBA_PROFIT_PAYOUT'
      AND user_id = ANY($1::int[])
  `, [[fixture.userA, fixture.userB]]);

  return {
    journal: Number(journal.n),
    operations: Number(operations.n),
    audit: Number(audit.n),
    transactions: Number(transactions.n)
  };
}

async function cleanup(client, fixture) {
  await client.query('BEGIN');
  try {
    await client.query(`
      DELETE FROM financial_audit_log
      WHERE account_kind = 'USER_BALANCE'
        AND account_id = ANY($1::bigint[])
    `, [[fixture.userA, fixture.userB]]);

    await client.query(`
      DELETE FROM journal_entries
      WHERE product_type = 'VICOBA'
        AND product_ref = $1
    `, [String(fixture.group)]);

    await client.query(`
      DELETE FROM financial_operations
      WHERE operation_type = 'GROUP_TO_WALLET'
        AND user_id = ANY($1::int[])
    `, [[fixture.userA, fixture.userB]]);

    await client.query(`
      DELETE FROM transactions
      WHERE type = 'VICOBA_PROFIT_PAYOUT'
        AND user_id = ANY($1::int[])
    `, [[fixture.userA, fixture.userB]]);

    await client.query(`
      DELETE FROM vicoba_profit_payouts
      WHERE distribution_id = $1
    `, [fixture.distribution]);

    await client.query(`
      DELETE FROM vicoba_profit_distributions
      WHERE id = $1
    `, [fixture.distribution]);

    await client.query(`
      DELETE FROM vicoba_groups
      WHERE id = $1
    `, [fixture.group]);

    await client.query(`
      DELETE FROM users
      WHERE id = ANY($1::int[])
    `, [[fixture.userA, fixture.userB]]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function run() {
  const client = await pool.connect();
  const suffix = String(Date.now()).slice(-6);
  let sufficient;
  let insufficient;

  try {
    console.log('=== PHASE 65 LIVE VICOBA PROFIT PAYOUT REGRESSION ===');

    sufficient = await createFixture(client, `${suffix}A`, 150);

    const before = await readState(client, sufficient);
    const beforeFinancial = await countFinancialRows(client, sufficient);

    const result = await approveProfitDistribution(
      sufficient.distribution,
      sufficient.userA
    );

    assert(result.success === true, 'sufficient-funds approval returned success');
    assert(result.distributed === 2, 'two unpaid payouts were distributed');

    const after = await readState(client, sufficient);
    const afterFinancial = await countFinancialRows(client, sufficient);

    assert(after.groupWallet === 0, 'group wallet decreased from 150 to 0');

    const userA = after.users.find(u => u.id === sufficient.userA);
    const userB = after.users.find(u => u.id === sufficient.userB);

    assert(userA.wallet === 100, 'user A received exactly 100');
    assert(userB.wallet === 50, 'user B received exactly 50');

    assert(after.status === 'COMPLETED', 'distribution became COMPLETED');
    assert(after.distributedAt !== null, 'distribution timestamp was recorded');
    assert(after.payouts.every(p => p.paid === true), 'all payouts became paid');

    assert(
      afterFinancial.journal - beforeFinancial.journal === 4,
      'two payouts created four journal lines'
    );
    assert(
      afterFinancial.operations - beforeFinancial.operations === 2,
      'two GROUP_TO_WALLET operations were recorded'
    );
    assert(
      afterFinancial.audit - beforeFinancial.audit === 2,
      'two group_to_wallet audit rows were recorded'
    );
    assert(
      afterFinancial.transactions - beforeFinancial.transactions === 2,
      'two VICOBA_PROFIT_PAYOUT transactions were recorded'
    );

    console.log('PASS  sufficient funds: 150 -> payouts 100 + 50');
    console.log('PASS  group wallet reached 0');
    console.log('PASS  user wallets received 100 and 50');
    console.log('PASS  distribution COMPLETED and payouts paid');
    console.log('PASS  journal/operation/audit/transaction side effects recorded');

    insufficient = await createFixture(client, `${suffix}B`, 149);

    const insufficientBefore = await readState(client, insufficient);
    const insufficientFinancialBefore =
      await countFinancialRows(client, insufficient);

    let failed = false;
    try {
      await approveProfitDistribution(
        insufficient.distribution,
        insufficient.userA
      );
    } catch (error) {
      failed = true;
      assert(
        error.statusCode === 400,
        `insufficient-funds failure status is 400 (got ${error.statusCode})`
      );
      console.log('PASS  insufficient funds rejected with status 400');
    }

    assert(failed, 'insufficient funds approval must fail');

    const insufficientAfter = await readState(client, insufficient);
    const insufficientFinancialAfter =
      await countFinancialRows(client, insufficient);

    assert(
      insufficientAfter.groupWallet === insufficientBefore.groupWallet,
      'insufficient-funds rollback preserved group wallet'
    );

    assert(
      JSON.stringify(insufficientAfter.users) ===
        JSON.stringify(insufficientBefore.users),
      'insufficient-funds rollback preserved user wallets'
    );

    assert(
      insufficientAfter.status === 'PENDING',
      'insufficient-funds rollback preserved PENDING status'
    );

    assert(
      insufficientAfter.payouts.every(p => p.paid === false),
      'insufficient-funds rollback preserved unpaid payouts'
    );

    assert(
      insufficientFinancialAfter.journal === insufficientFinancialBefore.journal,
      'insufficient-funds rollback left no journal rows'
    );

    assert(
      insufficientFinancialAfter.operations ===
        insufficientFinancialBefore.operations,
      'insufficient-funds rollback left no operation rows'
    );

    assert(
      insufficientFinancialAfter.audit === insufficientFinancialBefore.audit,
      'insufficient-funds rollback left no audit rows'
    );

    assert(
      insufficientFinancialAfter.transactions ===
        insufficientFinancialBefore.transactions,
      'insufficient-funds rollback left no transaction rows'
    );

    console.log('PASS  insufficient-funds transaction rollback preserved all state');
    console.log('');
    console.log('LIVE REGRESSION: PASS');
  } finally {
    try {
      if (sufficient) await cleanup(client, sufficient);
      if (insufficient) await cleanup(client, insufficient);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

run().catch(error => {
  console.error('');
  console.error('LIVE REGRESSION: FAIL');
  console.error(error.stack || error);
  process.exitCode = 1;
});
