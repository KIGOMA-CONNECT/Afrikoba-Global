'use strict';
// Phase 68 D1 regression: withdrawal dispatch, reconciliation and recovery.
// Real Postgres (disposable phase68_amount_guard_* DB only) and real financialEngine.
// AzamPay, SMS and audit are stubbed: no provider calls, no SMS, no offsite upload.

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DB_NAME = process.env.DB_NAME || '';
if (!/^phase68_amount_guard_[a-z0-9_]+$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
  console.error('SUITE ERROR: DB_NAME and PHASE68_TEST_DB must match an explicit phase68_amount_guard_<unique_suffix> disposable database name.');
  process.exit(2);
}

const gw = {
  payout: null,
  query: null,
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
  queryTransactionStatus: async (ref) => {
    if (gw.query) return gw.query(ref);
    return gw.statusByRef[ref] || { success: false, status: 'UNKNOWN' };
  },
  triggerMnoCheckout: async () => ({ success: false, message: 'stub' }),
  getAzamPayToken: async () => 'stub-token',
});
stubModule('src/services/smsService.js', { sendSMS: async () => ({ success: true }) });
stubModule('src/services/auditService.js', { logAudit: async () => {} });

const config = require(path.join(ROOT, 'src/config'));
config.azampay.enabled = true;
const pool = require(path.join(ROOT, 'src/config/db'));
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const wallet = require(path.join(ROOT, 'src/services/walletService'));
const recon = require(path.join(ROOT, 'src/jobs/reconciliationCron'));

const uniq = (p) => `${p}-D1T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function userWithPhone() {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE phone_number IS NOT NULL ORDER BY id LIMIT 1`
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
    `SELECT exception_type FROM reconciliation_exceptions WHERE reference_id = $1`, [ref]
  );
  return rows.map((r) => r.exception_type);
}

async function ageRow(ref) {
  await pool.query(
    `UPDATE transactions SET created_at = NOW() - INTERVAL '1 hour' WHERE reference_id = $1`, [ref]
  );
}

const payoutsFor = (ref) => gw.payoutRefs.filter((r) => r === ref).length;
const AMOUNT = 5000;

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('S1 dispatch success after commit; reconciliation settles once, no re-dispatch', async () => {
  const uid = await userWithPhone();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: true, data: { externalId: 'AZ-EXT-S1' } });

  const r = await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa');
  assert.strictEqual(r.status, 'PROCESSING');
  const ref = await lastWithdrawalRef(uid);
  const tx = await txOf(ref);
  assert.strictEqual(tx.status, 'PROCESSING');
  assert.strictEqual(tx.external_tx_id, 'AZ-EXT-S1');
  const held = await balances(uid);
  assert.strictEqual(+(held.locked - before.locked).toFixed(2), AMOUNT);

  gw.statusByRef[ref] = { success: true, status: 'SUCCESS', data: { externalId: 'AZ-EXT-S1' } };
  await recon.reconcilePendingDeposits();
  assert.strictEqual((await txOf(ref)).status, 'SUCCESS');
  const settled = await balances(uid);
  assert.strictEqual(+(settled.locked - before.locked).toFixed(2), 0);
  assert.strictEqual(+(before.wallet - settled.wallet).toFixed(2), AMOUNT);

  await recon.reconcilePendingDeposits();
  assert.strictEqual(payoutsFor(ref), 1, 'payout dispatched more than once');
  const again = await balances(uid);
  assert.strictEqual(again.wallet, settled.wallet);
  assert.strictEqual(again.locked, settled.locked);
});

scenario('S2 definitive gateway refusal (4xx): hold released once, FAILED, 502', async () => {
  const uid = await userWithPhone();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: false, ambiguous: false, message: 'Invalid account' });

  let err = null;
  try { await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa'); } catch (e) { err = e; }
  assert.ok(err, 'expected GATEWAY_DISPATCH_FAILED');
  assert.strictEqual(err.code, 'GATEWAY_DISPATCH_FAILED');
  assert.strictEqual(err.statusCode, 502);

  const ref = await lastWithdrawalRef(uid);
  assert.strictEqual((await txOf(ref)).status, 'FAILED');
  const after = await balances(uid);
  assert.strictEqual(+(after.locked - before.locked).toFixed(2), 0);
  assert.strictEqual(+(after.wallet - before.wallet).toFixed(2), 0);

  gw.statusByRef[ref] = { success: true, status: 'FAILED' };
  await ageRow(ref);
  await recon.reconcilePendingDeposits();
  const final = await balances(uid);
  assert.strictEqual(final.wallet, after.wallet, 'second release after refusal');
  assert.strictEqual(final.locked, after.locked, 'second release after refusal');
});

scenario('S3 ambiguous dispatch (timeout): NO release, state UNCERTAIN, not treated as refusal', async () => {
  const uid = await userWithPhone();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: false, ambiguous: true, message: 'timeout of 20000ms exceeded' });

  const r = await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa');
  assert.strictEqual(r.status, 'PROCESSING');
  const ref = await lastWithdrawalRef(uid);
  const tx = await txOf(ref);
  assert.strictEqual(tx.status, 'PROCESSING');
  assert.strictEqual(tx.meta && tx.meta.dispatch, 'UNCERTAIN');
  const held = await balances(uid);
  assert.strictEqual(+(held.locked - before.locked).toFixed(2), AMOUNT, 'hold released on ambiguous dispatch');

  await recon.reconcilePendingDeposits();
  assert.strictEqual((await txOf(ref)).status, 'PROCESSING', 'reconciled inside dispatch grace window');
  assert.strictEqual(+((await balances(uid)).locked - before.locked).toFixed(2), AMOUNT);

  gw.statusByRef[ref] = { success: true, status: 'FAILED' };
  await ageRow(ref);
  await recon.reconcilePendingDeposits();
  assert.strictEqual((await txOf(ref)).status, 'FAILED');
  assert.strictEqual(+((await balances(uid)).locked - before.locked).toFixed(2), 0);
  await recon.reconcilePendingDeposits();
  assert.strictEqual(+((await balances(uid)).locked - before.locked).toFixed(2), 0, 'double release');
  assert.strictEqual(payoutsFor(ref), 1, 'payout dispatched more than once');
});

scenario('S3b ambiguous dispatch, gateway later confirms SUCCESS: captured once, no refund', async () => {
  const uid = await userWithPhone();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => ({ success: false, ambiguous: true, message: 'socket hang up' });

  await wallet.withdrawToMno(uid, AMOUNT, 'Mpesa');
  const ref = await lastWithdrawalRef(uid);
  gw.statusByRef[ref] = { success: true, status: 'SUCCESS', data: { externalId: 'AZ-EXT-S3B' } };
  await ageRow(ref);
  await recon.reconcilePendingDeposits();
  assert.strictEqual((await txOf(ref)).status, 'SUCCESS');
  const after = await balances(uid);
  assert.strictEqual(+(after.locked - before.locked).toFixed(2), 0);
  assert.strictEqual(+(before.wallet - after.wallet).toFixed(2), AMOUNT);
});

scenario('S4 crash between commit and dispatch: held, recon does not guess, exception raised after grace', async () => {
  const uid = await userWithPhone();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => { throw new Error('simulated process crash'); };

  await assert.rejects(() => wallet.withdrawToMno(uid, AMOUNT, 'Mpesa'), /simulated process crash/);
  const ref = await lastWithdrawalRef(uid);
  assert.strictEqual((await txOf(ref)).status, 'PROCESSING');
  assert.strictEqual(+((await balances(uid)).locked - before.locked).toFixed(2), AMOUNT);

  await recon.reconcilePendingDeposits();
  assert.deepStrictEqual(await exceptionsOf(ref), [], 'exception raised inside dispatch grace window');

  gw.statusByRef[ref] = { success: false, status: 'UNKNOWN' };
  await ageRow(ref);
  await recon.reconcilePendingDeposits();
  assert.deepStrictEqual(await exceptionsOf(ref), ['UNDISPATCHED_WITHDRAWAL']);
  assert.strictEqual((await txOf(ref)).status, 'PROCESSING', 'auto-refunded without gateway proof');
  assert.strictEqual(+((await balances(uid)).locked - before.locked).toFixed(2), AMOUNT);
  assert.strictEqual(payoutsFor(ref), 1, 'recovery re-dispatched without operator decision');
});

scenario('S4b crash after send but before response: gateway SUCCESS is honoured, not stuck', async () => {
  const uid = await userWithPhone();
  await fund(uid, 50000);
  const before = await balances(uid);
  gw.payout = async () => { throw new Error('simulated crash after send'); };

  await assert.rejects(() => wallet.withdrawToMno(uid, AMOUNT, 'Mpesa'));
  const ref = await lastWithdrawalRef(uid);
  gw.statusByRef[ref] = { success: true, status: 'SUCCESS', data: { externalId: 'AZ-EXT-S4B' } };
  await ageRow(ref);
  await recon.reconcilePendingDeposits();
  assert.strictEqual((await txOf(ref)).status, 'SUCCESS', 'row stuck in PROCESSING with funds locked');
  const after = await balances(uid);
  assert.strictEqual(+(after.locked - before.locked).toFixed(2), 0);
  assert.strictEqual(+(before.wallet - after.wallet).toFixed(2), AMOUNT);
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
