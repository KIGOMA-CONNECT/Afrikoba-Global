'use strict';
const { Pool } = require('/tmp/afrikoba-phase68-deposit-fix/node_modules/pg');
const vicobaService = require('/tmp/afrikoba-phase68-deposit-fix/src/services/vicobaService');

const DB_NAME = process.env.DB_NAME || '';
if (!/^phase68_amount_guard_[a-z0-9_]+$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
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

    // Create group + member
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status) VALUES ('SocialFundTestGroup', $1, 1000, 'ACTIVE') RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;
    await client.query(
      "INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MJUMBE')",
      [groupId, uid]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 5000 WHERE id = $1', [uid]);
    await client.query('COMMIT');

    // Init social fund
    const fund = await vicobaService.initSocialFund(groupId, 500);
    await expect(fund && fund.id, 'Social fund initialized', JSON.stringify(fund));

    // Call contributeSocialFund
    const result = await vicobaService.contributeSocialFund(groupId, uid, '2026-11');
    await expect(result.success === true, 'contributeSocialFund succeeded', JSON.stringify(result));

    const ref = result.referenceId;
    const txRes = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txRes.rows.length === 1, 'Transaction row created');
    const txId = txRes.rows[0].id;

    // Check financial_operations linked
    const foRes = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1 OR reference_id LIKE $1 || \':%\'', [ref]);
    await expect(foRes.rows.length > 0, 'Financial operations exist');
    const linkedFo = foRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedFo.length > 0, 'At least one financial_operation linked', `found ${linkedFo.length} of ${foRes.rows.length}`);

    // Check journal_entries linked
    const jeRes = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1 OR reference_id LIKE $1 || \':%\'', [ref]);
    await expect(jeRes.rows.length > 0, 'Journal entries exist');
    const linkedJe = jeRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedJe.length > 0, 'At least one journal_entry linked', `found ${linkedJe.length} of ${jeRes.rows.length}`);

    // Verify social fund balance increased
    const fundBal = (await client.query('SELECT total_balance, total_collected FROM vicoba_social_fund WHERE id = $1', [fund.id])).rows[0];
    await expect(Number(fundBal.total_balance) === 500, 'Social fund balance increased to 500', `got ${fundBal.total_balance}`);
    await expect(Number(fundBal.total_collected) === 500, 'Social fund total collected 500', `got ${fundBal.total_collected}`);

    // Verify member social_fund_balance updated
    const memberBal = (await client.query('SELECT social_fund_balance FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, uid])).rows[0].social_fund_balance;
    await expect(Number(memberBal) === 500, 'Member social fund balance updated', `got ${memberBal}`);

    // Verify duplicate contribution rejected
    let dupRejected = false;
    try {
      await vicobaService.contributeSocialFund(groupId, uid, '2026-11');
    } catch (e) {
      dupRejected = true;
    }
    await expect(dupRejected, 'Duplicate contribution rejected');

    await client.query('ROLLBACK');
    console.log('\nVICOBA SOCIAL FUND TESTS: ' + passed + ' passed, ' + failed + ' failed');
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