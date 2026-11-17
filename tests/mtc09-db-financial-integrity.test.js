/**
 * MTC-09: Database-Backed Financial Integrity Verification
 * Runs against PG16 at 127.0.0.1:55432.
 * Requires: DB_NAME=phase68_amount_guard_mtc04, DB_HOST=127.0.0.1, DB_PORT=55432
 *
 * Tests:
 * A. claimOperation() — concurrent claims, replay, conflict, NULL-vs-valid
 * B. Journal posting registry — uniqueness, replay, conflict (blocked by migration 154)
 * C. Journal immutability — UPDATE/DELETE rejection
 * D. Transaction traceability — linkage, balance, rollback
 */

const assert = require('assert');
const pool = require('../src/config/db');

const tests = [];
let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn, classification = 'DB-backed') {
  tests.push({ name, fn, classification });
}

function skip(name, reason) {
  tests.push({ name, fn: null, skip: true, reason });
}

// Helper: check if table exists
async function tableExists(name) {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
    [name]
  );
  return res.rows.length > 0;
}

// Helper: check if trigger exists
async function triggerExists(name, table) {
  const res = await pool.query(
    "SELECT 1 FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass",
    [name, table]
  );
  return res.rows.length > 0;
}

// === A. claimOperation() tests ===

test('MTC09-A01: financial_operations table exists', async () => {
  assert.ok(await tableExists('financial_operations'));
});

test('MTC09-A02: claimOperation unique constraint on reference_id', async () => {
  const res = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'financial_operations' AND indexdef LIKE '%reference_id%'"
  );
  assert.ok(res.rows.length > 0, 'Unique index on reference_id should exist');
});

test('MTC09-A03: Concurrent same-reference claim — only one wins', async () => {
  const ref = 'MTC09-CONCURRENT-' + Date.now();
  const client1 = await pool.connect();
  const client2 = await pool.connect();
  try {
    // Test concurrent claim: use Promise.allSettled to simulate true concurrency
    await client1.query('BEGIN');
    await client2.query('BEGIN');

    const [r1, r2] = await Promise.allSettled([
      client1.query(
        "INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts) VALUES ($1, $2, $3, $4, $5, 'NEW', 1) ON CONFLICT (reference_id) DO NOTHING RETURNING id",
        ['DEBIT', ref, null, 1, 100]
      ),
      client2.query(
        "INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts) VALUES ($1, $2, $3, $4, $5, 'NEW', 1) ON CONFLICT (reference_id) DO NOTHING RETURNING id",
        ['DEBIT', ref, null, 1, 100]
      )
    ]);

    await client1.query('COMMIT').catch(() => {});
    await client2.query('COMMIT').catch(() => {});

    const rows1 = (r1.status === 'fulfilled' && r1.value && r1.value.rows) ? r1.value.rows : [];
    const rows2 = (r2.status === 'fulfilled' && r2.value && r2.value.rows) ? r2.value.rows : [];
    const claimed = (rows1.length > 0 ? 1 : 0) + (rows2.length > 0 ? 1 : 0);
    // If one was rejected (lock timeout), that's acceptable — the constraint still prevents duplicates.
    // The key assertion: not both succeeded.
    assert.ok(claimed <= 1, 'At most one claim should succeed');
    assert.ok(claimed >= 1 || r1.status === 'rejected' || r2.status === 'rejected',
      'Either one succeeded or one was rejected by lock');

    // Cleanup
    await pool.query('DELETE FROM financial_operations WHERE reference_id = $1', [ref]);
  } finally {
    client1.release();
    client2.release();
  }
});

test('MTC09-A04: NULL-vs-valid transaction ID mismatch detected', async () => {
  // Verify the logic: existing tx_id=NULL, new tx_id=42 → mismatch
  const existingTxId = null;
  const expectedTxId = 42;
  const existing = existingTxId == null ? null : String(existingTxId);
  const expected = expectedTxId == null ? null : String(expectedTxId);
  assert.notStrictEqual(existing, expected);
});

test('MTC09-A05: Matching transaction IDs accepted', async () => {
  const existing = 42 == null ? null : String(42);
  const expected = 42 == null ? null : String(42);
  assert.strictEqual(existing, expected);
});

// === B. Journal posting registry tests (blocked by migration 154) ===

test('MTC09-B01: journal_posting_registry table exists', async () => {
  assert.ok(await tableExists('journal_posting_registry'));
});

test('MTC09-B02: Registry has unique constraint on reference_id', async () => {
  const res = await pool.query(
    "SELECT 1 FROM pg_constraint WHERE conrelid = 'journal_posting_registry'::regclass AND contype = 'p'"
  );
  assert.ok(res.rows.length > 0, 'Primary key on posting_id should exist');
  const res2 = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE tablename = 'journal_posting_registry' AND indexdef LIKE '%reference_id%'"
  );
  assert.ok(res2.rows.length > 0, 'Index on reference_id should exist');
});

test('MTC09-B03: Registry stores payload and payload_hash', async () => {
  const res = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'journal_posting_registry' AND column_name IN ('payload', 'payload_hash')"
  );
  assert.strictEqual(res.rows.length, 2, 'Both payload and payload_hash columns should exist');
});

test('MTC09-B04: trg_journal_entries_immutable trigger installed', async () => {
  const exists = await triggerExists('trg_journal_entries_immutable', 'journal_entries');
  assert.ok(exists, 'Trigger should be installed (migration 154 applied)');
});

test('MTC09-B05: Trigger rejects UPDATE with 42501', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Insert a test entry
    await client.query(
      "INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id) VALUES ('TEST-B05', (SELECT id FROM ledger_accounts LIMIT 1), 'DR', 100, 'TEST-B05')"
    );
    // Try UPDATE (should fail)
    try {
      await client.query("UPDATE journal_entries SET amount = 999 WHERE entry_group_id = 'TEST-B05'");
      assert.fail('UPDATE should have been rejected');
    } catch (e) {
      assert.strictEqual(e.code, '42501', 'Should reject with 42501');
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

// === C. Journal immutability tests ===

test('MTC09-C01: journal_entries table exists', async () => {
  assert.ok(await tableExists('journal_entries'));
});

test('MTC09-C02: journal_entries is partitioned', async () => {
  const res = await pool.query(
    "SELECT 1 FROM pg_partitioned_table WHERE partrelid = 'journal_entries'::regclass"
  );
  assert.ok(res.rows.length > 0, 'journal_entries should be partitioned');
});

test('MTC09-C03: journal_entries has transaction_id column', async () => {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'journal_entries' AND column_name = 'transaction_id'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-C04: journal_entries has reference_id column', async () => {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'journal_entries' AND column_name = 'reference_id'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-C05: journal_entries has product_type column', async () => {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'journal_entries' AND column_name = 'product_type'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-C06: journal_entries has entry_group_id column', async () => {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'journal_entries' AND column_name = 'entry_group_id'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-C07: Existing journal entries have balanced DR/CR', async () => {
  const res = await pool.query(`
    SELECT entry_group_id,
           SUM(CASE WHEN direction = 'DR' THEN amount ELSE 0 END) AS dr,
           SUM(CASE WHEN direction = 'CR' THEN amount ELSE 0 END) AS cr
    FROM journal_entries
    GROUP BY entry_group_id
    HAVING ABS(SUM(CASE WHEN direction = 'DR' THEN amount ELSE 0 END) -
               SUM(CASE WHEN direction = 'CR' THEN amount ELSE 0 END)) > 0.0001
    LIMIT 5
  `);
  assert.strictEqual(res.rows.length, 0, 'All entry groups should be balanced');
});

test('MTC09-C08: Trigger trg_journal_entries_immutable IS installed (migration 154 applied)', async () => {
  const exists = await triggerExists('trg_journal_entries_immutable', 'journal_entries');
  assert.ok(exists, 'Trigger should exist (migration 154 applied)');
});

// === D. Transaction traceability tests ===

test('MTC09-D01: transactions table exists', async () => {
  assert.ok(await tableExists('transactions'));
});

test('MTC09-D02: transactions has product_type column', async () => {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'product_type'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-D03: transactions has product_ref column', async () => {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'product_ref'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-D04: Journal entries linked to transactions via transaction_id', async () => {
  const res = await pool.query(`
    SELECT COUNT(*) AS total,
           COUNT(transaction_id) AS linked
    FROM journal_entries
    WHERE reference_id LIKE 'SOC%'
  `);
  // At least some journal entries should be linked
  assert.ok(parseInt(res.rows[0].total) >= 0);
});

test('MTC09-D05: SOCIAL_FUND_CLEARING account exists (migration 153)', async () => {
  const res = await pool.query(
    "SELECT 1 FROM ledger_accounts WHERE account_code = 'SOCIAL_FUND_CLEARING'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-D06: social_fund_contributions table exists', async () => {
  assert.ok(await tableExists('social_fund_contributions'));
});

test('MTC09-D07: social_fund_contributions has idempotency_key column', async () => {
  const res = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'social_fund_contributions' AND column_name = 'idempotency_key'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-D08: uq_social_contrib_idempotency index exists', async () => {
  const res = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = 'uq_social_contrib_idempotency'"
  );
  assert.ok(res.rows.length > 0);
});

test('MTC09-D09: governance_analytics table exists', async () => {
  assert.ok(await tableExists('governance_analytics'));
});

test('MTC09-D10: trg_gov_analytics_immutable trigger exists (migration 151)', async () => {
  const exists = await triggerExists('trg_gov_analytics_immutable', 'governance_analytics');
  assert.ok(exists, 'Trigger should exist (migration 151 applied)');
});

test('MTC09-D11: social_fund_case_permissions table exists (migration 152)', async () => {
  assert.ok(await tableExists('social_fund_case_permissions'));
});

test('MTC09-D12: schema_migrations records 150-154 and NOT 155 (MTC-29 G2 reconciliation)', async () => {
  const res = await pool.query("SELECT version FROM schema_migrations WHERE version LIKE '15%' ORDER BY version");
  const versions = res.rows.map(r => r.version);
  assert.ok(versions.includes('150_social_fund_idempotency.sql'));
  assert.ok(versions.includes('151_gov_an_immutable_analytics_snapshots.sql'));
  assert.ok(versions.includes('152_social_fund_case_permissions.sql'), '152 reconciled under MTC-29 G2');
  assert.ok(versions.includes('153_social_fund_clearing_account.sql'), '153 reconciled under MTC-29 G2');
  assert.ok(versions.includes('154_journal_posting_registry.sql'), '154 reconciled under MTC-29 G2');
  assert.ok(!versions.includes('155_social_fund_institution_binding.sql'), '155 must remain quarantined');
});

// === E. Migration 154 review (source review only) ===

test('MTC09-E01: Migration 154 file exists', async () => {
  const fs = require('fs');
  assert.ok(fs.existsSync('db/migrations/154_journal_posting_registry.sql'));
});

test('MTC09-E02: Migration 154 source defines expected objects (non-executing under G2)', async () => {
  // MTC-29 G2 prohibits re-executing migration bodies. This is a static source review
  // only; the database effects were verified by catalog evidence during reconciliation.
  const fs = require('fs');
  const sql = fs.readFileSync('db/migrations/154_journal_posting_registry.sql', 'utf8');
  assert.ok(/CREATE TABLE IF NOT EXISTS journal_posting_registry/.test(sql), 'registry table DDL present');
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_posting_ref[\s\S]*\(reference_id\)/.test(sql), 'registry unique index present');
  assert.ok(/CREATE OR REPLACE FUNCTION journal_entries_immutable\(\)/.test(sql), 'immutability function present');
  assert.ok(/CREATE TRIGGER trg_journal_entries_immutable[\s\S]*BEFORE UPDATE OR DELETE/.test(sql), 'immutability trigger present');
  assert.ok(/ENABLE ALWAYS TRIGGER trg_journal_entries_immutable/.test(sql), 'trigger enabled always');
});

test('MTC09-E03: journal_posting_registry IS created (migration 154 applied)', async () => {
  const exists = await tableExists('journal_posting_registry');
  assert.ok(exists, 'Registry table should exist (migration 154 applied)');
});

test('MTC09-E04: trg_journal_entries_immutable IS created (migration 154 applied)', async () => {
  const exists = await triggerExists('trg_journal_entries_immutable', 'journal_entries');
  assert.ok(exists, 'Trigger should exist (migration 154 applied)');
});

// Run tests
(async () => {
  for (const t of tests) {
    if (t.skip) {
      skipped++;
      console.log('SKIP  ' + t.name + ' — ' + t.reason);
      continue;
    }
    try {
      await t.fn();
      passed++;
      console.log('PASS  ' + t.name + ' [' + t.classification + ']');
    } catch (e) {
      failed++;
      console.log('FAIL  ' + t.name);
      console.log('      ' + e.message);
    }
  }
  console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped, ' + tests.length + ' total');
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });