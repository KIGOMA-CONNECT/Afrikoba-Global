'use strict';
// Phase 68 D1 regression: withdrawal dispatch, reconciliation, recovery and idempotency.
// Real Postgres (disposable phase68_amount_guard_* DB only) and real financialEngine.
// AzamPay, SMS and audit are stubbed: no provider calls, no SMS, no offsite upload.
// Each scenario uses its own fresh user so balance deltas are not affected by
// other scenarios' unresolved withdrawals.

const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_NAME = process.env.DB_NAME || '';
if (!/^phase68_amount_guard_[a-z0-9_]+$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
  console.error('SUITE ERROR: DB_NAME and PHASE68_TEST_DB must match an explicit phase68_amount_guard_<unique_suffix> disposable database name.');
  process.exit(2);
}

const gw = {
  payout: null,
  payoutRefs: [],
  statusByRef: {},
};

function stubModule(rel, exportsObj) {
  const p = path.join(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

stubModule('src/services/azampayService.js', {
  triggerPayout: async (phone, amount, ref, provider) => {
    gw.payoutRefs.push(ref);
    return gw.payout(phone, amount, ref, provider);
  },
  queryTransactionStatus: async (ref) => gw.statusByRef[ref] || { success: false, status: 'UNKNOWN' },
  triggerMnoCheckout: async () => ({ success: false, message: 'stub' }),
  getAzamPayToken: async () => 'stub-token',
});
stubModule('src/services/smsService.js', { sendSMS: async () => ({ success: true }) });
stubModule('src/services/auditService.js', { logAudit: async () => {} });

const config = require(path.join(ROOT, 'src/config'));
config.azampay.enabled = true;
config.azampay.payoutContractVerified = true;
const pool = require(path.join(ROOT, 'src/config/db'));
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const wallet = require(path.join(ROOT, 'src/services/walletService'));
const recon = require(path.join(ROOT, 'src/jobs/reconciliationCron'));

const uniq = (p) => `${p}-D1T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const AMOUNT = 5000;
const MAX_PASSES = 40;

// Clone a seeded user into a fresh row with a unique phone and zero balances.
async function freshUser() {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name <> 'id'
     ORDER BY ordinal_position`
  );
  const names = cols.map((c) => c.column_name);
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const phone = `255${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  // Every single-column UNIQUE text column gets a per-user value so the clone
  // does not collide with the source row (email, nida_number, ...).
  const { rows: uniqueCols } = await pool.query(
    `SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'users'::regclass AND i.indisunique AND NOT i.indisprimary
       AND array_length(i.indkey::int2[], 1) = 1`
  );
  const overrides = new Map([['phone_number', phone]]);
  for (const u of uniqueCols) {
    if (/char|text/.test(u.typ)) {
      overrides.set(u.col, String(Math.floor(Math.random() * 9e9) + 1e9));
    }
  }
  overrides.set('email', `d1test-${suffix}@d1test.invalid`);
  const params = [];
  const select = names.map((c) => {
    if (c === 'wallet_balance' || c === 'locked_balance') return '0';
    if (overrides.has(c)) {
      params.push(overrides.get(c));
      return `$${params.length}`;
    }
    return `"${c}"`;
  });
  const { rows } = await pool.query(
    `INSERT INTO users (${names.map((c) => `"${c}"`).join(', ')})
     SELECT ${select.join(', ')} FROM users WHERE id = (SELECT min(id) FROM users WHERE phone_number IS NOT NULL)
     RETURNING id`,
    params
  );
  return rows[0].id;
}

async function balances(uid) {
  const { rows } = await pool.query(
    `SELECT wallet_balance, locked_balance FROM users WHERE id = $1`, [uid]
  );
  return { wallet: parseFloat(rows[0].wallet_balance), locked: parseFloat(rows[0].locked_balance) };
}

async function fund(uid, amount) {
  await fin.postDeposit({
    userId: uid, amount, commission: 0, reference: uniq('DEP'),
    externalTxId: null, description: 'D1 test funding',
  });
}

async function txOf(ref) {
  const { rows } = await pool.query(
    `SELECT status, external_tx_id, failure_reason, meta FROM transactions WHERE reference_id = $1`, [ref]
  );
  return rows[0];
}

async function lastWithdrawalRef(uid) {
  const { rows } = await pool.query(
    `SELECT reference_id FROM transactions WHERE user_id = $1 AND type = 'WITHDRAWAL' ORDER BY id DESC LIMIT 1`, [uid]
  );
  return rows[0].reference_id;
}

async function exceptionsOf(ref) {
  const { rows } = await pool.query(
    `SELECT exception_type FROM reconciliation_exceptions WHERE reference_id = $1 ORDER BY id`, [ref]
  );
  return rows.map((r) => r.exception_type);
}

async function ageRow(ref) {
  await pool.query(
    `UPDATE transactions SET created_at = NOW() - INTERVAL '1 hour' WHERE reference_id = $1`, [ref]
  );
}

// Recon rotates through a backlog in batches; run passes until the target holds.
async function settleUntil(predicate, maxPasses = MAX_PASSES) {
  for (let i = 0; i < maxPasses; i++) {
    if (await predicate()) return true;
    await recon.reconcilePendingDeposits();
  }
  return predicate();
}

const keyRef = (uid, key) =>
  `WD-${crypto.createHash('sha256').update(`${uid}:${key}`).digest('hex').slice(0, 32).toUpperCase()}`;

const payoutsFor = (ref) => gw.payoutRefs.filter((r) => r === ref).length;
const delta = (after, before, field) => +(after[field] - before[field]).toFixed(2);

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('S0 payout contract unverified: fail closed before any hold or transaction', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  const countTx = async () => (await pool.query(
    `SELECT count(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'WITHDRAWAL'`, [uid]
  )).rows[0].n;
  const txBefore = await countTx();
  const payoutsBefore = gw.payoutRefs.length;
  gw.payout = async () => { throw new Error('must not dispatch'); };
  config.azampay.payoutContractVerified = false;
  try {
    await assert.rejects(
      () => wallet.withdrawToMno(uid, AMOUNT, 'Mpesa'),
      (e) => e.code === 'PAYOUT_CONTRACT_UNVERIFIED' && e.statusCode === 503
    );
  } finally {
    config.azampay.payoutContractVerified = true;
  }
  assert.strictEqual(await countTx(), txBefore, 'transaction created while gate closed');
  assert.deepStrictEqual(await balances(uid), before);
  assert.strictEqual(gw.payoutRefs.length, payoutsBefore, 'provider called while gate closed');
});

scenario('S1 dispatch success after commit; reconciliation settles once, no re-dispatch', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: true, data: { externalId: 'AZ-EXT-S1' } });
  const r = await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa');
  assert.strictEqual(r.status, 'PROCESSING');
  const ref = await lastWithdrawalRef(uid);
  const tx = await txOf(ref);
  assert.strictEqual(tx.status, 'PROCESSING');
  assert.strictEqual(tx.external_tx_id, 'AZ-EXT-S1');
  assert.strictEqual(delta(await balances(uid), before, 'locked'), AMOUNT);

  gw.statusByRef[ref] = { success: true, status: 'SUCCESS', data: { externalId: 'AZ-EXT-S1' } };
  assert.ok(await settleUntil(async () => (await txOf(ref)).status === 'SUCCESS'), 'not settled');
  const settled = await balances(uid);
  assert.strictEqual(delta(settled, before, 'locked'), 0);
  assert.strictEqual(delta(settled, before, 'wallet'), -AMOUNT);

  for (let i = 0; i < 3; i++) await recon.reconcilePendingDeposits();
  assert.strictEqual(payoutsFor(ref), 1, 'payout dispatched more than once');
  assert.deepStrictEqual(await balances(uid), settled);
});

scenario('S2 definitive gateway refusal (4xx): hold released once, FAILED, 502', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: false, ambiguous: false, message: 'Invalid account' });
  await assert.rejects(
    () => wallet.withdrawToMno(uid, AMOUNT, 'Mpesa'),
    (e) => e.code === 'GATEWAY_DISPATCH_FAILED' && e.statusCode === 502
  );
  const ref = await lastWithdrawalRef(uid);
  assert.strictEqual((await txOf(ref)).status, 'FAILED');
  const after = await balances(uid);
  assert.strictEqual(delta(after, before, 'locked'), 0);
  assert.strictEqual(delta(after, before, 'wallet'), 0);

  gw.statusByRef[ref] = { success: true, status: 'FAILED' };
  await ageRow(ref);
  for (let i = 0; i < 3; i++) await recon.reconcilePendingDeposits();
  assert.deepStrictEqual(await balances(uid), after, 'second release after refusal');
});

scenario('S3 ambiguous dispatch (timeout): NO release, state UNCERTAIN, not treated as refusal', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: false, ambiguous: true, message: 'timeout of 20000ms exceeded' });
  const r = await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa');
  assert.strictEqual(r.status, 'PROCESSING');
  const ref = await lastWithdrawalRef(uid);
  const tx = await txOf(ref);
  assert.strictEqual(tx.status, 'PROCESSING');
  assert.strictEqual(tx.meta && tx.meta.dispatch, 'UNCERTAIN');
  assert.strictEqual(delta(await balances(uid), before, 'locked'), AMOUNT, 'hold released on ambiguous dispatch');

  for (let i = 0; i < 3; i++) await recon.reconcilePendingDeposits();
  assert.strictEqual((await txOf(ref)).status, 'PROCESSING', 'reconciled inside dispatch grace window');
  assert.strictEqual(delta(await balances(uid), before, 'locked'), AMOUNT);

  gw.statusByRef[ref] = { success: true, status: 'FAILED' };
  await ageRow(ref);
  assert.ok(await settleUntil(async () => (await txOf(ref)).status === 'FAILED'), 'not settled after grace');
  assert.strictEqual(delta(await balances(uid), before, 'locked'), 0);
  for (let i = 0; i < 3; i++) await recon.reconcilePendingDeposits();
  assert.strictEqual(delta(await balances(uid), before, 'locked'), 0, 'double release');
  assert.strictEqual(payoutsFor(ref), 1, 'payout dispatched more than once');
});

scenario('S3b ambiguous dispatch, gateway later confirms SUCCESS: captured once, no refund', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: false, ambiguous: true, message: 'socket hang up' });
  await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa');
  const ref = await lastWithdrawalRef(uid);
  gw.statusByRef[ref] = { success: true, status: 'SUCCESS', data: { externalId: 'AZ-EXT-S3B' } };
  await ageRow(ref);
  assert.ok(await settleUntil(async () => (await txOf(ref)).status === 'SUCCESS'), 'not settled');
  const after = await balances(uid);
  assert.strictEqual(delta(after, before, 'locked'), 0);
  assert.strictEqual(delta(after, before, 'wallet'), -AMOUNT);
});

scenario('S4 crash between commit and dispatch: held, no exception inside grace, exception after grace', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => { throw new Error('simulated process crash'); };
  await assert.rejects(() => wallet.withdrawToMno(uid, AMOUNT, 'Mpesa'), /simulated process crash/);
  const ref = await lastWithdrawalRef(uid);
  assert.strictEqual((await txOf(ref)).status, 'PROCESSING');
  assert.strictEqual(delta(await balances(uid), before, 'locked'), AMOUNT);

  for (let i = 0; i < 3; i++) await recon.reconcilePendingDeposits();
  assert.deepStrictEqual(await exceptionsOf(ref), [], 'exception raised inside dispatch grace window');

  gw.statusByRef[ref] = { success: false, status: 'UNKNOWN' };
  await ageRow(ref);
  assert.ok(await settleUntil(async () => (await exceptionsOf(ref)).length > 0), 'no exception after grace');
  assert.deepStrictEqual(await exceptionsOf(ref), ['UNDISPATCHED_WITHDRAWAL']);
  assert.strictEqual((await txOf(ref)).status, 'PROCESSING', 'auto-refunded without gateway proof');
  assert.strictEqual(delta(await balances(uid), before, 'locked'), AMOUNT);
  assert.strictEqual(payoutsFor(ref), 1, 'recovery re-dispatched without operator decision');
});

scenario('S4b crash after send but before response: gateway SUCCESS is honoured, not stuck', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => { throw new Error('simulated crash after send'); };
  await assert.rejects(() => wallet.withdrawToMno(uid, AMOUNT, 'Mpesa'));
  const ref = await lastWithdrawalRef(uid);
  gw.statusByRef[ref] = { success: true, status: 'SUCCESS', data: { externalId: 'AZ-EXT-S4B' } };
  await ageRow(ref);
  assert.ok(await settleUntil(async () => (await txOf(ref)).status === 'SUCCESS'), 'row stuck in PROCESSING with funds locked');
  const after = await balances(uid);
  assert.strictEqual(delta(after, before, 'locked'), 0);
  assert.strictEqual(delta(after, before, 'wallet'), -AMOUNT);
});

scenario('S5 concurrent requests with the same Idempotency-Key: one hold, one dispatch', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  const key = uniq('IDEM');
  const ref = keyRef(uid, key);
  gw.payout = async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { success: true, data: { externalId: 'AZ-EXT-S5' } };
  };
  const results = await Promise.allSettled([
    wallet.withdrawToMno(uid, AMOUNT, 'Mpesa', key),
    wallet.withdrawToMno(uid, AMOUNT, 'Mpesa', key),
  ]);
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'both requests should resolve');
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE reference_id = $1`, [ref]);
  assert.strictEqual(rows[0].n, 1);
  assert.strictEqual(payoutsFor(ref), 1, 'payout dispatched more than once');
  assert.strictEqual(delta(await balances(uid), before, 'locked'), AMOUNT, 'double hold');
});

scenario('S6 replay with same key after success: no second hold or dispatch', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  const key = uniq('IDEM');
  const ref = keyRef(uid, key);
  gw.payout = async () => ({ success: true, data: { externalId: 'AZ-EXT-S6' } });
  await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa', key);
  const replay = await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa', key);
  assert.strictEqual(replay.success, true);
  assert.strictEqual(replay.referenceId, ref);
  assert.strictEqual(payoutsFor(ref), 1);
  assert.strictEqual(delta(await balances(uid), before, 'locked'), AMOUNT);
});

scenario('S7 replay with same key after refusal: reports FAILED, never re-dispatches', async () => {
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  const key = uniq('IDEM');
  const ref = keyRef(uid, key);
  gw.payout = async () => ({ success: false, ambiguous: false, message: 'Invalid account' });
  await assert.rejects(
    () => wallet.withdrawToMno(uid, AMOUNT, 'Mpesa', key),
    (e) => e.code === 'GATEWAY_DISPATCH_FAILED'
  );
  assert.ok(ref.length + '-RELEASE'.length <= 50, 'keyed reference overflows ledger reference_id');
  const replay = await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa', key);
  assert.strictEqual(replay.status, 'FAILED');
  assert.strictEqual(replay.success, false);
  assert.strictEqual(payoutsFor(ref), 1, 'refused payout re-dispatched on replay');
  const after = await balances(uid);
  assert.strictEqual(delta(after, before, 'locked'), 0);
  assert.strictEqual(delta(after, before, 'wallet'), 0);
});

scenario('S8 same key for different users yields different references and separate holds', async () => {
  const u1 = await freshUser();
  const u2 = await freshUser();
  await fund(u1, 50000);
  await fund(u2, 50000);
  const key = uniq('IDEM');
  gw.payout = async () => ({ success: true, data: { externalId: 'AZ-EXT-S8' } });
  const r1 = await wallet.withdrawToMno(u1, AMOUNT, 'Mpesa', key);
  const r2 = await wallet.withdrawToMno(u2, AMOUNT, 'Mpesa', key);
  assert.notStrictEqual(r1.referenceId, r2.referenceId);
  assert.strictEqual(r1.referenceId, keyRef(u1, key));
  assert.strictEqual(r2.referenceId, keyRef(u2, key));
});

scenario('S9 unresolved backlog does not starve new withdrawals; exceptions are not duplicated', async () => {
  // Backlog: several unresolved withdrawals from earlier scenarios/runs.
  const { rows: stuck } = await pool.query(
    `SELECT count(*)::int AS n FROM transactions WHERE status = 'PROCESSING' AND type = 'WITHDRAWAL'`
  );
  const { rows: maxRows } = await pool.query(`SELECT COALESCE(MAX(id), 0)::int AS m FROM reconciliation_exceptions`);
  const exceptionMarker = maxRows[0].m;
  const uid = await freshUser();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: true, data: { externalId: 'AZ-EXT-S9' } });
  await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa');
  const ref = await lastWithdrawalRef(uid);
  gw.statusByRef[ref] = { success: true, status: 'SUCCESS', data: { externalId: 'AZ-EXT-S9' } };
  const settled = await settleUntil(async () => (await txOf(ref)).status === 'SUCCESS');
  assert.ok(settled, `new withdrawal starved behind ${stuck[0].n} unresolved ones`);
  assert.strictEqual(delta(await balances(uid), before, 'locked'), 0);

  const { rows: dup } = await pool.query(
    `SELECT reference_id, exception_type, count(*)::int AS n FROM reconciliation_exceptions
     WHERE id > $1 AND exception_type IN ('UNDISPATCHED_WITHDRAWAL','STALE_WITHDRAWAL')
     GROUP BY reference_id, exception_type HAVING count(*) > 1 LIMIT 5`,
    [exceptionMarker]
  );
  assert.deepStrictEqual(dup, [], 'duplicate exceptions for the same withdrawal and type');
});

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    try {
      await s.fn();
      console.log(`PASS ${s.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}\n     ${(e.stack || e.message).split('\n').slice(0, 4).join('\n     ')}`);
    }
  }
  console.log(`RESULT: ${scenarios.length - failed} passed, ${failed} failed of ${scenarios.length}`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})();
