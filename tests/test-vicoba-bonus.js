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

    // Create group + member with leadership role
    const groupRes = await client.query(
      "INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status) VALUES ('BonusTestGroup', $1, 1000, 'ACTIVE') RETURNING id",
      [uid]
    );
    const groupId = groupRes.rows[0].id;
    await client.query(
      "INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, 'MWENYEKITI')",
      [groupId, uid]
    );
    await client.query('COMMIT');

    // Get initial group balance
    const initBal = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;

    // Call addBonus
    const result = await vicobaService.addBonus(uid, groupId, { amount: 500, purpose: 'Interest income test' });
    await expect(result.success === true, 'addBonus succeeded', JSON.stringify(result));

    // Verify group balance increased by 500
    const groupBal = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;
    await expect(Number(groupBal) === Number(initBal) + 500, 'Group balance increased by 500', `got ${groupBal} (init ${initBal})`);

    // Verify bonus record created
    const bonusRes = await client.query('SELECT id, amount, purpose FROM vicoba_bonus WHERE group_id = $1 ORDER BY id DESC LIMIT 1', [groupId]);
    await expect(bonusRes.rows.length === 1, 'Bonus record created');
    await expect(Number(bonusRes.rows[0].amount) === 500, 'Bonus amount recorded', `got ${bonusRes.rows[0].amount}`);
    await expect(bonusRes.rows[0].purpose === 'Interest income test', 'Bonus purpose recorded', `got ${bonusRes.rows[0].purpose}`);

    // Verify journal entries created (SUSPENSE DR, VICOBA_GROUP CR)
    const jeRes = await client.query("SELECT direction, amount FROM journal_entries WHERE reference_id LIKE 'BON%' ORDER BY id DESC LIMIT 2");
    await expect(jeRes.rows.length >= 2, 'Journal entries created', `got ${jeRes.rows.length}`);
    const dr = jeRes.rows.find(r => r.direction === 'DR');
    const cr = jeRes.rows.find(r => r.direction === 'CR');
    await expect(dr && Number(dr.amount) === 500, 'DR entry = 500', `got ${dr ? dr.amount : 'none'}`);
    await expect(cr && Number(cr.amount) === 500, 'CR entry = 500', `got ${cr ? cr.amount : 'none'}`);

    // Verify balance unchanged after read (no side effects)
    const groupBal2 = (await client.query('SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1', [groupId])).rows[0].group_wallet_balance;
    await expect(Number(groupBal2) === Number(initBal) + 500, 'Group balance stable', `got ${groupBal2}`);

    await client.query('ROLLBACK');
    console.log('\nVICOBA BONUS TESTS: ' + passed + ' passed, ' + failed + ' failed');
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