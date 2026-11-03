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
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status) VALUES ('ShareTestGroup', $1, 1000, 'ACTIVE') RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;
    await client.query(
      "INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MJUMBE')",
      [groupId, uid]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 5000 WHERE id = $1', [uid]);
    const initBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await client.query('COMMIT');

    // Call contributeShares
    const result = await vicobaService.contributeShares(groupId, uid, 1000, 1);
    await expect(result.success === true, 'contributeShares succeeded', JSON.stringify(result));

    const ref = result.referenceId;
    const txRes = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txRes.rows.length === 1, 'Transaction row created');
    const txId = txRes.rows[0].id;

    // Check financial_operations linked (via trigger or code)
    const foRes = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1 OR reference_id LIKE $1 || \':%\'', [ref]);
    await expect(foRes.rows.length > 0, 'Financial operations exist');
    const linkedFo = foRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedFo.length > 0, 'At least one financial_operation linked', `found ${linkedFo.length} of ${foRes.rows.length}`);

    // Check journal_entries linked
    const jeRes = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1 OR reference_id LIKE $1 || \':%\'', [ref]);
    await expect(jeRes.rows.length > 0, 'Journal entries exist');
    const linkedJe = jeRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedJe.length > 0, 'At least one journal_entry linked', `found ${linkedJe.length} of ${jeRes.rows.length}`);

    // Verify group balance increased
    const groupBal = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;
    await expect(Number(groupBal) === 1000, 'Group balance increased to 1000', `got ${groupBal}`);

    // Verify member shares updated
    const memberShares = (await client.query('SELECT total_shares, contribution_balance FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, uid])).rows[0];
    await expect(Number(memberShares.total_shares) === 1, 'Member shares updated', `got ${memberShares.total_shares}`);
    await expect(Number(memberShares.contribution_balance) === 1000, 'Member contribution balance updated', `got ${memberShares.contribution_balance}`);

    // Verify user wallet decreased
    const userBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await expect(Number(userBal) === Number(initBal) - 1000, 'User wallet decreased by 1000', `got ${userBal} (init ${initBal})`);

    // Rollback test
    await client.query('BEGIN');
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 9999 WHERE id = $1', [uid]);
    await client.query('ROLLBACK');
    const userBalAfter = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    await expect(Number(userBalAfter) === Number(initBal) - 1000, 'Rollback preserved wallet balance', `got ${userBalAfter}`);

    await client.query('ROLLBACK');
    console.log('\nVICOBA SHARES LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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