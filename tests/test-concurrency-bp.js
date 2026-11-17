'use strict';
const { Pool } = require('pg');
const walletService = require('../src/services/walletService');

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
  let uid, uid2, phone2, bal1Before, bal2Before;
  try {
    await client.query('BEGIN');
    uid = (await client.query('SELECT min(id) AS id FROM users')).rows[0].id;
    const uid2Row = (await client.query('SELECT id, phone_number FROM users ORDER BY id OFFSET 1 LIMIT 1')).rows[0];
    uid2 = uid2Row.id;
    phone2 = uid2Row.phone_number;
    const phone1 = (await client.query('SELECT phone_number FROM users WHERE id = $1', [uid])).rows[0].phone_number;

    // Fund user1 wallet (will be cleaned up in finally)
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 10000 WHERE id = $1', [uid]);
    await client.query('COMMIT');

    bal1Before = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    bal2Before = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [uid2])).rows[0].wallet_balance;

    // Two concurrent transfers from user1 to user2 (different references)
    const results = await Promise.all([
      walletService.transferWallet(uid, phone2, 1000, 'CONC-BP-1').then(r => ({ ok: true, r })).catch(e => ({ ok: false, e: e.message })),
      walletService.transferWallet(uid, phone2, 2000, 'CONC-BP-2').then(r => ({ ok: true, r })).catch(e => ({ ok: false, e: e.message })),
    ]);

    // Both should succeed (different references, sufficient balance)
    const successes = results.filter(r => r.ok);
    await expect(successes.length === 2, 'Both transfers succeeded', `successes=${successes.length}`);

    // Verify balances
    const bal1After = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;
    const bal2After = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [uid2])).rows[0].wallet_balance;
    const expected1 = Number(bal1Before) - 1000 - 2000;
    const expected2 = Number(bal2Before) + 1000 + 2000;
    await expect(Number(bal1After) === expected1, 'User1 balance decreased by 3000', `got ${bal1After} (expected ${expected1})`);
    await expect(Number(bal2After) === expected2, 'User2 balance increased by 3000', `got ${bal2After} (expected ${expected2})`);

    // Verify transaction records
    const ref1 = results[0].r.referenceId;
    const ref2 = results[1].r.referenceId;
    const tx1 = await pool.query('SELECT id FROM transactions WHERE reference_id = $1', [ref1]);
    const tx2 = await pool.query('SELECT id FROM transactions WHERE reference_id = $1', [ref2]);
    await expect(tx1.rows.length === 1, 'Transaction 1 created', `ref=${ref1}`);
    await expect(tx2.rows.length === 1, 'Transaction 2 created', `ref=${ref2}`);

    // Verify journal entries exist for both
    const je1 = await pool.query('SELECT COUNT(*)::int AS n FROM journal_entries WHERE reference_id = $1', [ref1]);
    const je2 = await pool.query('SELECT COUNT(*)::int AS n FROM journal_entries WHERE reference_id = $1', [ref2]);
    await expect(je1.rows[0].n >= 2, 'Journal entries for transfer 1', `got ${je1.rows[0].n}`);
    await expect(je2.rows[0].n >= 2, 'Journal entries for transfer 2', `got ${je2.rows[0].n}`);

  } catch (e) {
    console.error('FATAL', e);
    failed++;
  } finally {
    // Cleanup: restore balances to original state
    try {
      if (uid && uid2 && bal1Before && bal2Before) {
        await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [bal1Before, uid]);
        await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [bal2Before, uid2]);
      }
    } catch (cleanupErr) {
      console.error('CLEANUP ERROR:', cleanupErr.message);
    }
    client.release();
    await pool.end();
    console.log('\nBUSINESS-PATH CONCURRENCY TESTS: ' + passed + ' passed, ' + failed + ' failed');
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  }
}

run();