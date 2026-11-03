'use strict';
const { Pool } = require('/tmp/afrikoba-phase68-deposit-fix/node_modules/pg');
const merchantService = require('/tmp/afrikoba-phase68-deposit-fix/src/services/merchantService');

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
    const uid2 = (await client.query('SELECT id FROM users WHERE id > $1 ORDER BY id LIMIT 1', [uid])).rows[0].id;

    console.log('\n--- Merchant Idempotency & Replay Test ---');

    // Create a merchant
    const merchRes = await client.query(
      "INSERT INTO merchants (user_id, name, business_type, phone, is_active) VALUES ($1, 'IdempMerchant', 'RETAIL', '255700000088', true) RETURNING id",
      [uid2]
    );
    const merchantId = merchRes.rows[0].id;

    // Fund payer wallet
    await client.query('UPDATE users SET wallet_balance = wallet_balance + 50000 WHERE id = $1', [uid]);
    const fundedBal = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;

    // Test 1: Same reference + identical payload (replay)
    console.log('\n--- Test 1: Identical replay (same reference, same payload) ---');
    const ref = 'IDEMP-REPLAY-' + Date.now();
    const result1 = await merchantService.payMerchant(uid, merchantId, 5000, 'Payment 1', { client, reference: ref });
    await expect(result1.success === true, 'First payment succeeded', JSON.stringify(result1));

    const txCount1 = (await client.query('SELECT count(*)::int AS n FROM transactions WHERE reference_id = $1', [ref])).rows[0].n;
    const foCount1 = (await client.query('SELECT count(*)::int AS n FROM financial_operations WHERE reference_id = $1', [ref])).rows[0].n;
    const jeCount1 = (await client.query('SELECT count(*)::int AS n FROM journal_entries WHERE reference_id = $1', [ref])).rows[0].n;
    const bal1 = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;

    // Replay with same reference and same payload
    const replay1 = await merchantService.payMerchant(uid, merchantId, 5000, 'Payment 1', { client, reference: ref });
    await expect(replay1.success === true && replay1.dedup === true, 'Replay returns dedup=true', JSON.stringify(replay1));

    const txCount2 = (await client.query('SELECT count(*)::int AS n FROM transactions WHERE reference_id = $1', [ref])).rows[0].n;
    const foCount2 = (await client.query('SELECT count(*)::int AS n FROM financial_operations WHERE reference_id = $1', [ref])).rows[0].n;
    const jeCount2 = (await client.query('SELECT count(*)::int AS n FROM journal_entries WHERE reference_id = $1', [ref])).rows[0].n;
    const bal2 = (await client.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance;

    await expect(txCount2 === txCount1, 'Replay: no new transaction', `before=${txCount1} after=${txCount2}`);
    await expect(foCount2 === foCount1, 'Replay: no new financial_operation', `before=${foCount1} after=${foCount2}`);
    await expect(jeCount2 === jeCount1, 'Replay: no new journal_entry', `before=${jeCount1} after=${jeCount2}`);
    await expect(Number(bal2) === Number(bal1), 'Replay: no balance change', `before=${bal1} after=${bal2}`);

    // Test 2: Same reference + changed amount (shape mismatch)
    console.log('\n--- Test 2: Shape mismatch (changed amount) ---');
    const ref2 = 'SHAPE-AMT-' + Date.now();
    const r2 = await merchantService.payMerchant(uid, merchantId, 5000, 'Shape test', { client, reference: ref2 });
    await expect(r2.success === true, 'Original payment succeeded');

    try {
      await merchantService.payMerchant(uid, merchantId, 6000, 'Shape test', { client, reference: ref2 });
      fail('Shape mismatch (amount): rejected', 'payment succeeded unexpectedly');
    } catch (e) {
      await expect(e.message.includes('kiasi') || e.message.includes('tofauti') || e.message.includes('operation'), 'Shape mismatch (amount): rejected', e.message);
    }

    const txCountAfter = (await client.query('SELECT count(*)::int AS n FROM transactions WHERE reference_id = $1', [ref2])).rows[0].n;
    await expect(txCountAfter === 1, 'Shape mismatch: no new transaction', `got ${txCountAfter}`);

    // Test 3: Same reference + changed payer (shape mismatch)
    console.log('\n--- Test 3: Shape mismatch (changed payer) ---');
    const ref3 = 'SHAPE-PAYER-' + Date.now();
    const r3 = await merchantService.payMerchant(uid, merchantId, 5000, 'Payer test', { client, reference: ref3 });
    await expect(r3.success === true, 'Original payment succeeded');

    try {
      await merchantService.payMerchant(uid2, merchantId, 5000, 'Payer test', { client, reference: ref3 });
      fail('Shape mismatch (payer): rejected', 'payment succeeded unexpectedly');
    } catch (e) {
      await expect(e.message.includes('payer') || e.message.includes('tofauti') || e.message.includes('operation') || e.message.includes('haihusiani'), 'Shape mismatch (payer): rejected', e.message);
    }

    // Test 4: Concurrent requests with same reference
    console.log('\n--- Test 4: Concurrent requests (same reference) ---');
    const ref4 = 'CONC-MERCH-' + Date.now();
    const conn1 = await pool.connect();
    const conn2 = await pool.connect();
    await conn1.query('BEGIN');
    await conn2.query('BEGIN');

    const [res1, res2] = await Promise.allSettled([
      merchantService.payMerchant(uid, merchantId, 3000, 'Concurrent 1', { client: conn1, reference: ref4 }),
      merchantService.payMerchant(uid, merchantId, 3000, 'Concurrent 2', { client: conn2, reference: ref4 }),
    ]);

    const successes = [res1, res2].filter(r => r.status === 'fulfilled' && r.value?.success);
    await expect(successes.length <= 1, 'Concurrent: at most one success', `got ${successes.length} successes`);

    await conn1.query('COMMIT').catch(() => {});
    await conn2.query('ROLLBACK').catch(() => {});
    conn1.release();
    conn2.release();

    const concTx = await client.query('SELECT count(*)::int AS n FROM transactions WHERE reference_id = $1', [ref4]);
    await expect(concTx.rows[0].n <= 1, 'Concurrent: at most one transaction', `got ${concTx.rows[0].n}`);

    await client.query('ROLLBACK');
    console.log('\nMERCHANT IDEMPOTENCY & REPLAY TESTS: ' + passed + ' passed, ' + failed + ' failed');
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
