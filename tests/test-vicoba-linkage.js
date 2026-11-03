'use strict';
const { Pool } = require('pg');
const vicobaService = require('../src/services/vicobaService');

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

    console.log('\n--- VICOBA Contribution Linkage Test ---');

    // Create a VICOBA group
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status) VALUES ('TestGroup', $1, 1000, 'ACTIVE') RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;

    // Add member
    await client.query(
      "INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'CHAIRMAN')",
      [groupId, uid]
    );

    // Fund user wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 5000 WHERE id = $1', [uid]);

    await client.query('COMMIT');

    // Call contributeShares (creates its own transaction)
    const result = await vicobaService.contributeShares(groupId, uid, 1000, 1);
    await expect(result.success === true, 'VICOBA contribution succeeded', JSON.stringify(result));

    const ref = result.referenceId;
    const txRes = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [ref]);
    await expect(txRes.rows.length === 1, 'Transaction row created');
    const txId = txRes.rows[0].id;

    const foRes = await client.query('SELECT transaction_id FROM financial_operations WHERE reference_id = $1 OR reference_id LIKE $1 || \':%\'', [ref]);
    await expect(foRes.rows.length > 0, 'Financial operations exist');
    // Check if any are linked
    const linkedFo = foRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedFo.length > 0, 'At least one financial_operation linked to transaction', `found ${linkedFo.length} linked of ${foRes.rows.length}`);

    const jeRes = await client.query('SELECT transaction_id FROM journal_entries WHERE reference_id = $1 OR reference_id LIKE $1 || \':%\'', [ref]);
    await expect(jeRes.rows.length > 0, 'Journal entries exist');
    const linkedJe = jeRes.rows.filter(r => r.transaction_id === txId);
    await expect(linkedJe.length > 0, 'At least one journal_entry linked to transaction', `found ${linkedJe.length} linked of ${jeRes.rows.length}`);

    // Verify group balance increased
    const groupBal = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;
    await expect(Number(groupBal) === 1000, 'Group balance increased to 1000', `got ${groupBal}`);

    await client.query('ROLLBACK');
    console.log('\nVICOBA CONTRIBUTION LINKAGE TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
