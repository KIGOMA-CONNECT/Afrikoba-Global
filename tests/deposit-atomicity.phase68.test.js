'use strict';
/**
 * Phase 68 — deposit atomicity and provider-contract verification.
 *
 * Runs against a disposable Postgres database only (name must match
 * /^phase68_amount_guard_[a-z0-9_]+$/ and PHASE68_TEST_DB must equal DB_NAME).
 * The AzamPay gateway, SMS and audit transport are stubbed: no provider call,
 * no SMS, no production write.
 *
 * Every scenario uses a fresh user and a fresh reference so scenarios cannot
 * influence each other.
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DB_NAME = process.env.DB_NAME || '';
if (!/^phase68_amount_guard_[a-z0-9_]+$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
  console.error('SUITE ERROR: DB_NAME and PHASE68_TEST_DB must match an explicit phase68_amount_guard_<unique_suffix> disposable database name.');
  process.exit(2);
}

const gw = { calls: [], byRef: {}, sequence: null };

function stubModule(rel, exportsObj) {
  const p = path.join(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

stubModule('src/services/azampayService.js', {
  queryTransactionStatus: async (ref) => {
    gw.calls.push(ref);
    if (gw.sequence) return gw.sequence(ref);
    return gw.byRef[ref] || { success: false, status: 'UNKNOWN', error: 'no record' };
  },
  triggerMnoCheckout: async () => ({ success: false, message: 'stub' }),
  triggerPayout: async () => ({ success: false, ambiguous: false, message: 'stub' }),
  getAzamPayToken: async () => 'stub-token',
});
stubModule('src/services/smsService.js', { sendSMS: async () => ({ success: true }) });
stubModule('src/services/auditService.js', { logAudit: async () => {} });

const config = require(path.join(ROOT, 'src/config'));
config.azampay.enabled = true;
config.azampay.statusContractVerified = true;

const pool = require(path.join(ROOT, 'src/config/db'));
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const wallet = require(path.join(ROOT, 'src/services/walletService'));
const recon = require(path.join(ROOT, 'src/jobs/reconciliationCron'));

const WALLET = 10000;
const COMMISSION = 100;
const TOTAL = WALLET + COMMISSION;
const TOL = 0.005;

const uniq = (p) => `${p}-D1A-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

async function freshUser() {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name <> 'id'
      ORDER BY ordinal_position`
  );
  const names = cols.map((c) => c.column_name);
  const { rows: uniqueCols } = await pool.query(
    `SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = 'users'::regclass AND i.indisunique AND NOT i.indisprimary
        AND array_length(i.indkey::int2[], 1) = 1`
  );
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const overrides = new Map([
    ['phone_number', `255${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`],
  ]);
  for (const u of uniqueCols) {
    if (/char|text/.test(u.typ)) overrides.set(u.col, String(Math.floor(Math.random() * 9e9) + 1e9));
  }
  overrides.set('email', `d1a-${suffix}@d1a.invalid`);
  const params = [];
  const select = names.map((c) => {
    if (c === 'wallet_balance' || c === 'locked_balance') return '0';
    if (overrides.has(c)) { params.push(overrides.get(c)); return `$${params.length}`; }
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

async function createDeposit(uid, { walletAmount = WALLET, commission = COMMISSION } = {}) {
  const ref = uniq('DP');
  const { rows } = await pool.query(
    `INSERT INTO transactions
       (reference_id, user_id, wallet_amount, commission, total_charged, status, type)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', 'DEPOSIT')
     RETURNING id`,
    [ref, uid, walletAmount, commission, walletAmount + commission]
  );
  return { ref, id: rows[0].id };
}

const balance = async (uid) => parseFloat((await pool.query(
  `SELECT wallet_balance FROM users WHERE id = $1`, [uid]
)).rows[0].wallet_balance);

const txOf = async (ref) => (await pool.query(
  `SELECT id, status, external_tx_id, failure_reason, total_charged
     FROM transactions WHERE reference_id = $1`, [ref]
)).rows[0];

const txRow = async (id) => (await pool.query(
  `SELECT * FROM transactions WHERE id = $1`, [id]
)).rows[0];

const foOf = async (ref) => (await pool.query(
  `SELECT operation_type, status, transaction_id, user_id, amount::text AS amount
     FROM financial_operations WHERE reference_id = $1`, [ref]
)).rows[0];

const foCount = async (ref) => (await pool.query(
  `SELECT count(*)::int AS n FROM financial_operations WHERE reference_id = $1`, [ref]
)).rows[0].n;

const journalRows = async (ref) => (await pool.query(
  `SELECT je.entry_group_id, la.account_code, je.direction, je.amount::text AS amount,
          je.transaction_id
     FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id
    WHERE je.reference_id = $1
    ORDER BY la.account_code, je.direction`, [ref]
)).rows;

const journalCount = async (ref) => (await pool.query(
  `SELECT count(*)::int AS n FROM journal_entries WHERE reference_id = $1`, [ref]
)).rows[0].n;

const ledgerRows = async (ref) => (await pool.query(
  `SELECT transaction_id, reference_id, to_user_id, amount::text AS amount
     FROM wallet_ledger WHERE reference_id = $1 ORDER BY id`, [ref]
)).rows;

const exceptionsOf = async (ref) => (await pool.query(
  `SELECT exception_type, detail FROM reconciliation_exceptions
    WHERE reference_id = $1 ORDER BY id`, [ref]
)).rows;

const sumDir = (rows, dir) => rows
  .filter((r) => r.direction === dir)
  .reduce((acc, r) => acc + Number(r.amount), 0);

const body = (ref, status = 'success') => ({
  utilityref: ref, transactionstatus: status, reference: 'AZ-CB-1', message: '', provider: 'Mpesa',
});

const goodGateway = (ref, amount = TOTAL) => ({
  success: true, status: 'SUCCESS', data: { externalId: ref, amount },
});

async function expectConflict(fn, label) {
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error, `${label}: expected a conflict error, none thrown`);
  assert.strictEqual(error.code, 'DEPOSIT_IDEMPOTENCY_CONFLICT', `${label}: ${error.message}`);
}

async function assertNoFinancialEffect(uid, ref, before, label) {
  assert.strictEqual(await balance(uid), before, `${label}: wallet changed`);
  assert.strictEqual(await journalCount(ref), 0, `${label}: journal residue`);
  assert.strictEqual(await foCount(ref), 0, `${label}: financial_operations residue`);
  assert.strictEqual((await txOf(ref)).status, 'PENDING', `${label}: transaction moved`);
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

/* ------------------------------------------------------------------ *
 * A. Provider-contract gate (D1)
 * ------------------------------------------------------------------ */

scenario('A1 contract gate closed: callback never credits', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  const before = await balance(uid);
  config.azampay.statusContractVerified = false;
  gw.byRef[ref] = goodGateway(ref);
  try {
    const r = await wallet.processDepositCallback(body(ref, 'success'));
    assert.strictEqual(r.pending, true);
    assert.strictEqual(r.verified, false);
  } finally {
    config.azampay.statusContractVerified = true;
  }
  await assertNoFinancialEffect(uid, ref, before, 'A1');
  const ex = await exceptionsOf(ref);
  assert.deepStrictEqual(ex.map((e) => e.exception_type), ['CALLBACK_UNVERIFIED']);
  assert.strictEqual(ex[0].detail.reason, 'STATUS_CONTRACT_UNVERIFIED');
});

scenario('A2 contract gate closed: reconciliation never credits', async () => {
  const uid = await freshUser();
  const { ref, id } = await createDeposit(uid);
  const before = await balance(uid);
  config.azampay.statusContractVerified = false;
  gw.byRef[ref] = goodGateway(ref);
  try {
    await recon.settleDeposit(await txRow(id));
  } finally {
    config.azampay.statusContractVerified = true;
  }
  await assertNoFinancialEffect(uid, ref, before, 'A2');
  const ex = await exceptionsOf(ref);
  assert.deepStrictEqual(ex.map((e) => e.exception_type), ['DEPOSIT_CONTRACT_UNVERIFIED']);
});

/* ------------------------------------------------------------------ *
 * B. Callback verification (body is a claim, gateway is evidence)
 * ------------------------------------------------------------------ */

scenario('B1 forged SUCCESS with no gateway record: no credit', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef = {};
  const r = await wallet.processDepositCallback(body(ref, 'success'));
  assert.strictEqual(r.pending, true);
  await assertNoFinancialEffect(uid, ref, before, 'B1');
  assert.deepStrictEqual((await exceptionsOf(ref)).map((e) => e.exception_type), ['CALLBACK_UNVERIFIED']);
});

scenario('B2 forged SUCCESS while gateway is PENDING: no credit', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = { success: true, status: 'PENDING', data: { externalId: ref } };
  await wallet.processDepositCallback(body(ref, 'success'));
  await assertNoFinancialEffect(uid, ref, before, 'B2');
});

scenario('B3 verified SUCCESS credits once with a balanced journal', async () => {
  const uid = await freshUser();
  const { ref, id } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = goodGateway(ref);
  const r = await wallet.processDepositCallback(body(ref, 'success'));
  assert.strictEqual(r.success, true);
  assert.ok(!r.pending);
  assert.strictEqual(+(await balance(uid) - before).toFixed(2), WALLET);

  const rows = await journalRows(ref);
  assert.strictEqual(rows.length, 3, 'journal line count');
  assert.strictEqual(sumDir(rows, 'DR'), TOTAL, 'journal DR total');
  assert.strictEqual(sumDir(rows, 'CR'), TOTAL, 'journal CR total');
  assert.ok(rows.every((row) => String(row.transaction_id) === String(id)), 'journal transaction id');
  const commission = rows.find((row) => row.account_code === 'COMMISSION');
  assert.ok(commission, 'commission line missing');
  assert.strictEqual(Number(commission.amount), COMMISSION, 'commission amount');
  assert.strictEqual(Number(rows.find((r2) => r2.account_code === 'CUSTOMER_WALLET').amount), WALLET);

  const ledger = await ledgerRows(ref);
  assert.strictEqual(ledger.length, 1, 'wallet_ledger rows');
  assert.strictEqual(Number(ledger[0].amount), WALLET);
  assert.strictEqual(String(ledger[0].transaction_id), String(id));
  assert.strictEqual(String(ledger[0].to_user_id), String(uid));

  assert.strictEqual((await txOf(ref)).status, 'SUCCESS');
  const fo = await foOf(ref);
  assert.strictEqual(fo.status, 'SUCCESS');
  assert.strictEqual(fo.operation_type, 'DEPOSIT');
  assert.strictEqual(String(fo.transaction_id), String(id));
  assert.strictEqual(Number(fo.amount), WALLET);
});

scenario('B4 replay of a finished callback: no second gateway call, no second credit', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  gw.byRef[ref] = goodGateway(ref);
  await wallet.processDepositCallback(body(ref, 'success'));
  const after = await balance(uid);
  const callsBefore = gw.calls.filter((c) => c === ref).length;
  const r = await wallet.processDepositCallback(body(ref, 'success'));
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(gw.calls.filter((c) => c === ref).length, callsBefore, 'gateway called for finished tx');
  assert.strictEqual(await balance(uid), after);
  assert.strictEqual(await journalCount(ref), 3);
  assert.strictEqual((await ledgerRows(ref)).length, 1);
});

scenario('B5 concurrent duplicate callbacks: exactly one credit', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  const before = await balance(uid);
  gw.sequence = async (r) => {
    await new Promise((res) => setTimeout(res, 150));
    return goodGateway(r);
  };
  const results = await Promise.allSettled([
    wallet.processDepositCallback(body(ref, 'success')),
    wallet.processDepositCallback(body(ref, 'success')),
  ]);
  gw.sequence = null;
  assert.ok(results.every((x) => x.status === 'fulfilled'), 'concurrent callback rejected');
  assert.strictEqual(+(await balance(uid) - before).toFixed(2), WALLET, 'double credit');
  assert.strictEqual(await journalCount(ref), 3, 'journal posted more than once');
  assert.strictEqual((await ledgerRows(ref)).length, 1, 'wallet_ledger duplicated');
  assert.strictEqual(await foCount(ref), 1, 'financial_operations duplicated');
});

scenario('B6 amount mismatch: conflict, no credit', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = goodGateway(ref, WALLET);
  const r = await wallet.processDepositCallback(body(ref, 'success'));
  assert.strictEqual(r.pending, true);
  await assertNoFinancialEffect(uid, ref, before, 'B6');
  const ex = await exceptionsOf(ref);
  assert.deepStrictEqual(ex.map((e) => e.exception_type), ['CALLBACK_GATEWAY_CONFLICT']);
  assert.strictEqual(ex[0].detail.reason, 'AMOUNT_MISMATCH');
});

scenario('B7 reference mismatch: conflict, no credit', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = { success: true, status: 'SUCCESS', data: { externalId: 'SOME-OTHER-REF', amount: TOTAL } };
  await wallet.processDepositCallback(body(ref, 'success'));
  await assertNoFinancialEffect(uid, ref, before, 'B7');
  const ex = await exceptionsOf(ref);
  assert.deepStrictEqual(ex.map((e) => e.exception_type), ['CALLBACK_GATEWAY_CONFLICT']);
  assert.strictEqual(ex[0].detail.reason, 'REFERENCE_MISMATCH');
});

scenario('B8 gateway timeout/UNKNOWN: unverified, no credit', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  const before = await balance(uid);
  gw.sequence = async () => ({ success: false, status: 'UNKNOWN', error: 'timeout of 15000ms exceeded' });
  try {
    const r = await wallet.processDepositCallback(body(ref, 'success'));
    assert.strictEqual(r.pending, true);
  } finally {
    gw.sequence = null;
  }
  await assertNoFinancialEffect(uid, ref, before, 'B8');
  const ex = await exceptionsOf(ref);
  assert.deepStrictEqual(ex.map((e) => e.exception_type), ['CALLBACK_UNVERIFIED']);
  assert.strictEqual(ex[0].detail.reason, 'GATEWAY_UNAVAILABLE');
});

scenario('B9 forged FAILED while gateway is SUCCESS: deposit not cancelled', async () => {
  const uid = await freshUser();
  const { ref } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = goodGateway(ref);
  await wallet.processDepositCallback(body(ref, 'failed'));
  await assertNoFinancialEffect(uid, ref, before, 'B9');
  const ex = await exceptionsOf(ref);
  assert.deepStrictEqual(ex.map((e) => e.exception_type), ['CALLBACK_GATEWAY_CONFLICT']);
});

scenario('B10 body SUCCESS while gateway is FAILED: not credited, reconciliation fails it', async () => {
  const uid = await freshUser();
  const { ref, id } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = { success: true, status: 'FAILED', data: { externalId: ref } };
  await wallet.processDepositCallback(body(ref, 'success'));
  assert.strictEqual((await txOf(ref)).status, 'PENDING', 'body SUCCESS cancelled/credited the deposit');
  assert.strictEqual(await balance(uid), before);
  assert.deepStrictEqual((await exceptionsOf(ref)).map((e) => e.exception_type), ['CALLBACK_GATEWAY_CONFLICT']);

  await recon.settleDeposit(await txRow(id));
  assert.strictEqual((await txOf(ref)).status, 'FAILED');
  assert.strictEqual(await balance(uid), before);
  assert.strictEqual(await journalCount(ref), 0);
});

scenario('B11 unknown reference: 404 and no gateway call', async () => {
  const callsBefore = gw.calls.length;
  const r = await wallet.processDepositCallback(body(uniq('NOPE'), 'success'));
  assert.strictEqual(r.code, 404);
  assert.strictEqual(gw.calls.length, callsBefore);
});

/* ------------------------------------------------------------------ *
 * C. postDeposit idempotency
 * ------------------------------------------------------------------ */

async function settledDeposit() {
  const uid = await freshUser();
  const { ref, id } = await createDeposit(uid);
  gw.byRef[ref] = goodGateway(ref);
  await wallet.processDepositCallback(body(ref, 'success'));
  return { uid, ref, id };
}

scenario('C1 duplicate with matching commission: verified dedup, no effect', async () => {
  const { uid, ref, id } = await settledDeposit();
  const before = await balance(uid);
  const res = await fin.postDeposit({
    userId: uid, amount: WALLET, commission: COMMISSION, reference: ref, transactionId: id,
  });
  assert.strictEqual(res.dedup, true);
  assert.strictEqual(res.verified, true);
  assert.strictEqual(await balance(uid), before);
  assert.strictEqual(await journalCount(ref), 3);
  assert.strictEqual(await foCount(ref), 1);
});

scenario('C2 duplicate with conflicting commission: conflict, no effect', async () => {
  const { uid, ref, id } = await settledDeposit();
  const before = await balance(uid);
  await expectConflict(() => fin.postDeposit({
    userId: uid, amount: WALLET, commission: COMMISSION + 50, reference: ref, transactionId: id,
  }), 'C2');
  assert.strictEqual(await balance(uid), before);
  assert.strictEqual(await journalCount(ref), 3);
  assert.strictEqual((await foOf(ref)).status, 'SUCCESS');
});

scenario('C3 duplicate with conflicting user: conflict, no effect', async () => {
  const { ref, id } = await settledDeposit();
  const other = await freshUser();
  const otherBefore = await balance(other);
  await expectConflict(() => fin.postDeposit({
    userId: other, amount: WALLET, commission: COMMISSION, reference: ref, transactionId: id,
  }), 'C3');
  assert.strictEqual(await balance(other), otherBefore);
});

scenario('C4 duplicate with conflicting operation type: conflict', async () => {
  const uid = await freshUser();
  const ref = uniq('DP');
  await pool.query(
    `INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status)
     VALUES ('HOLD', $1, $2, $3, 'SUCCESS')`, [ref, uid, WALLET]
  );
  await expectConflict(() => fin.postDeposit({
    userId: uid, amount: WALLET, commission: COMMISSION, reference: ref, transactionId: null,
  }), 'C4');
});

scenario('C5 duplicate with a missing journal line: conflict', async () => {
  const { uid, ref, id } = await settledDeposit();
  const { rows: acc } = await pool.query(
    `SELECT id FROM ledger_accounts WHERE account_code = 'COMMISSION'`
  );
  const commissionAccount = acc[0].id;
  try {
    await pool.query(
      `DELETE FROM journal_entries WHERE reference_id = $1 AND account_id = $2`,
      [ref, commissionAccount]
    );
    await expectConflict(() => fin.postDeposit({
      userId: uid, amount: WALLET, commission: COMMISSION, reference: ref, transactionId: id,
    }), 'C5');
  } finally {
    // Restore the deleted line: this database is shared with the global
    // amount-guard invariant suite, which must still see balanced journals.
    const existing = await pool.query(
      `SELECT 1 FROM journal_entries WHERE reference_id = $1 AND account_id = $2`,
      [ref, commissionAccount]
    );
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO journal_entries
           (entry_group_id, transaction_id, account_id, direction, amount, reference_id, description, posted_by)
         VALUES ($1,$2,$3,'CR',$4,$1,'restored by C5','test')`,
        [ref, id, commissionAccount, COMMISSION]
      );
    }
  }
});

scenario('C6 duplicate with extra journal lines: conflict', async () => {
  const { uid, ref, id } = await settledDeposit();
  const { rows } = await pool.query(
    `SELECT id, account_code FROM ledger_accounts WHERE account_code IN ('SUSPENSE','COMMISSION')`
  );
  const suspense = rows.find((r) => r.account_code === 'SUSPENSE').id;
  await pool.query(
    `INSERT INTO journal_entries
       (entry_group_id, transaction_id, account_id, direction, amount, reference_id, description, posted_by)
     VALUES ($1,$2,$3,'DR',1,$1,'extra pair','test'),
            ($1,$2,$3,'CR',1,$1,'extra pair','test')`,
    [ref, id, suspense]
  );
  await expectConflict(() => fin.postDeposit({
    userId: uid, amount: WALLET, commission: COMMISSION, reference: ref, transactionId: id,
  }), 'C6');
});

scenario('C7 duplicate whose operation is not SUCCESS: conflict', async () => {
  const { uid, ref, id } = await settledDeposit();
  await pool.query(`UPDATE financial_operations SET status = 'FAILED' WHERE reference_id = $1`, [ref]);
  await expectConflict(() => fin.postDeposit({
    userId: uid, amount: WALLET, commission: COMMISSION, reference: ref, transactionId: id,
  }), 'C7');
});

/* ------------------------------------------------------------------ *
 * D. Atomicity and rollback
 * ------------------------------------------------------------------ */

scenario('D1 wallet-ledger conflict rolls back journal, wallet and operation', async () => {
  const uid = await freshUser();
  const { ref, id } = await createDeposit(uid);
  const before = await balance(uid);
  await pool.query(
    `INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description)
     VALUES ($1, $2, $3, $4, 'pre-existing conflicting row')`,
    [id, ref, uid, WALLET + 1]
  );
  gw.byRef[ref] = goodGateway(ref);
  let error = null;
  try {
    await wallet.processDepositCallback(body(ref, 'success'));
  } catch (e) {
    error = e;
  }
  assert.ok(error, 'ledger conflict did not fail the settlement');
  assert.strictEqual(error.code, 'DEPOSIT_LEDGER_CONFLICT');
  await assertNoFinancialEffect(uid, ref, before, 'D1');
  assert.strictEqual((await ledgerRows(ref)).length, 1, 'pre-existing ledger row should remain alone');
  assert.deepStrictEqual((await exceptionsOf(ref)).map((e) => e.exception_type), ['DEPOSIT_SETTLEMENT_FAILED']);
});

scenario('D2 unbalanced journal is rejected before and by the database', async () => {
  const ref = uniq('JE');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let err = null;
    try {
      await fin.postJournal({
        client, referenceId: ref,
        lines: [
          { accountCode: 'MNO_CLEARING', direction: 'DR', amount: 10 },
          { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: 9 },
        ],
      });
    } catch (e) { err = e; }
    assert.ok(err && /unbalanced/i.test(err.message), 'postJournal accepted an unbalanced group');
    await client.query('ROLLBACK');

    assert.strictEqual(await journalCount(ref), 0, 'unbalanced journal left residue');
  } finally {
    client.release();
  }

  const { rows: acc } = await pool.query(
    `SELECT id, account_code FROM ledger_accounts WHERE account_code IN ('MNO_CLEARING','CUSTOMER_WALLET')`
  );
  const drAcc = acc.find((r) => r.account_code === 'MNO_CLEARING').id;
  const crAcc = acc.find((r) => r.account_code === 'CUSTOMER_WALLET').id;
  const ref2 = uniq('JE');
  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');
    await client2.query(
      `INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id, posted_by)
       VALUES ($1,$2,'DR',10,$1,'test'), ($1,$3,'CR',9,$1,'test')`,
      [ref2, drAcc, crAcc]
    );
    let err = null;
    try {
      await client2.query('COMMIT');
    } catch (e) { err = e; }
    assert.ok(err && /BALANCED_LEDGER_VIOLATION/.test(err.message), 'database accepted an unbalanced group');
  } finally {
    await client2.query('ROLLBACK').catch(() => {});
    client2.release();
  }
  assert.strictEqual(await journalCount(ref2), 0, 'database-level unbalanced journal left residue');
});

/* ------------------------------------------------------------------ *
 * E. Reconciliation parity
 * ------------------------------------------------------------------ */

scenario('E1 reconciliation verified SUCCESS credits once', async () => {
  const uid = await freshUser();
  const { ref, id } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = goodGateway(ref);
  await recon.settleDeposit(await txRow(id));
  assert.strictEqual(+(await balance(uid) - before).toFixed(2), WALLET);
  assert.strictEqual((await txOf(ref)).status, 'SUCCESS');
  assert.strictEqual(await journalCount(ref), 3);
  assert.strictEqual((await ledgerRows(ref)).length, 1);
  assert.strictEqual(await foCount(ref), 1);
});

scenario('E2 reconciliation amount conflict: no credit and an exception', async () => {
  const uid = await freshUser();
  const { ref, id } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = goodGateway(ref, WALLET);
  await recon.settleDeposit(await txRow(id));
  await assertNoFinancialEffect(uid, ref, before, 'E2');
  const ex = await exceptionsOf(ref);
  assert.deepStrictEqual(ex.map((e) => e.exception_type), ['DEPOSIT_GATEWAY_CONFLICT']);
  assert.strictEqual(ex[0].detail.reason, 'AMOUNT_MISMATCH');
});

scenario('E3 callback then reconciliation: a single credit', async () => {
  const uid = await freshUser();
  const { ref, id } = await createDeposit(uid);
  const before = await balance(uid);
  gw.byRef[ref] = goodGateway(ref);
  await wallet.processDepositCallback(body(ref, 'success'));
  await recon.settleDeposit(await txRow(id));
  assert.strictEqual(+(await balance(uid) - before).toFixed(2), WALLET);
  assert.strictEqual(await journalCount(ref), 3);
  assert.strictEqual((await ledgerRows(ref)).length, 1);
  assert.strictEqual(await foCount(ref), 1);
});

/* ------------------------------------------------------------------ */

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    try {
      await s.fn();
      console.log(`PASS ${s.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}\n     ${(e.stack || e.message).split('\n').slice(0, 5).join('\n     ')}`);
    }
  }
  console.log(`RESULT: ${scenarios.length - failed} passed, ${failed} failed of ${scenarios.length}`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})();
