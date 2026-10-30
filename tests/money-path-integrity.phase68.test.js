'use strict';
/**
 * Phase 68 — money-path integrity (non-AzamPay services).
 *
 * Runs against a disposable Postgres database only (name must match
 * /^phase68_amount_guard_[a-z0-9_]+$/ and PHASE68_TEST_DB must equal DB_NAME).
 * SMS and audit transport are stubbed: no network, no provider call.
 *
 * Covered:
 *   E. engine primitives (creditWallet, debitWallet, internalTransfer, postJournal)
 *   F. field partner pool funding (fieldPartnerService.fundPartner)
 *   B. BAP partner pool funding (bapService.fundPartner)
 *   S. SACCOS investment redemption (saccosInvestmentsService.redeemInvestment)
 *
 * Each scenario uses fresh rows and fresh references so scenarios cannot
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

function stubModule(rel, exportsObj) {
  const p = path.join(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

stubModule('src/services/smsService.js', { sendSMS: async () => ({ success: true }) });
stubModule('src/services/auditService.js', { logAudit: async () => {}, logAction: async () => {} });

const pool = require(path.join(ROOT, 'src/config/db'));
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const fieldPartner = require(path.join(ROOT, 'src/services/fieldPartnerService'));
const bap = require(path.join(ROOT, 'src/services/bapService'));
const saccosInvestments = require(path.join(ROOT, 'src/services/saccosInvestmentsService'));

const uniq = (p) => `${p}-MPI-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const shortRef = (p) => `${p}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;

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
  overrides.set('email', `mpi-${suffix}@mpi.invalid`);
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

async function createFieldPartner() {
  const { rows } = await pool.query(
    `INSERT INTO field_partners (name, country_code, risk_rating, active, available_balance)
     VALUES ($1, 'TZ', 'LOW', TRUE, 0) RETURNING id`,
    [uniq('FP')]
  );
  return rows[0].id;
}

async function createBapPartner() {
  const { rows } = await pool.query(
    `INSERT INTO partners (name, contact_email, phone, status, balance)
     VALUES ($1, $2, $3, 'ACTIVE', 0) RETURNING id`,
    [uniq('BAP'), `${uniq('bap')}@mpi.invalid`, `255${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`]
  );
  return rows[0].id;
}

async function createSaccosFixture(userId) {
  const { rows: org } = await pool.query(
    `INSERT INTO saccos (code, name, country_code, status, created_by, config)
     VALUES ($1, $2, 'TZ', 'ACTIVE', $3, '{}'::jsonb) RETURNING id`,
    [shortRef('SC'), uniq('SACCOS'), userId]
  );
  const saccosId = org[0].id;
  const { rows: mem } = await pool.query(
    `INSERT INTO saccos_members (saccos_id, user_id, role, member_number, status, membership_category, admission_date, accepted_at)
     VALUES ($1, $2, 'MEMBER', '0001', 'ACTIVE', 'REGULAR', CURRENT_DATE, NOW()) RETURNING id`,
    [saccosId, userId]
  );
  const { rows: prod } = await pool.query(
    `INSERT INTO saccos_investment_products (saccos_id, reference_id, name, min_amount, max_amount, annual_rate_percent, term_months, status, created_by)
     VALUES ($1, $2, 'Term', 0, NULL, 10, 12, 'ACTIVE', $3) RETURNING id`,
    [saccosId, shortRef('INVP'), userId]
  );
  const { rows: inv } = await pool.query(
    `INSERT INTO saccos_investments
       (saccos_id, product_id, member_id, reference_id, amount, annual_rate_percent, term_months, expected_interest, status, maturity_date, subscribed_at)
     VALUES ($1, $2, $3, $4, 1000, 10, 12, 100, 'ACTIVE', CURRENT_DATE - INTERVAL '1 day', NOW())
     RETURNING id`,
    [saccosId, prod[0].id, mem[0].id, shortRef('INV')]
  );
  return { saccosId, membershipId: mem[0].id, investmentId: inv[0].id };
}

const balance = async (uid) => parseFloat((await pool.query(
  `SELECT wallet_balance FROM users WHERE id = $1`, [uid]
)).rows[0].wallet_balance);

const journalCount = async (ref) => (await pool.query(
  `SELECT count(*)::int AS n FROM journal_entries WHERE reference_id = $1`, [ref]
)).rows[0].n;

const journalLines = async (ref) => (await pool.query(
  `SELECT la.account_code, je.direction, je.amount::text AS amount
     FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id
    WHERE je.reference_id = $1 ORDER BY la.account_code, je.direction`, [ref]
)).rows;

const foOf = async (ref) => (await pool.query(
  `SELECT operation_type, status, user_id, amount::text AS amount
     FROM financial_operations WHERE reference_id = $1`, [ref]
)).rows[0];

const foCount = async (ref) => (await pool.query(
  `SELECT count(*)::int AS n FROM financial_operations WHERE reference_id = $1`, [ref]
)).rows[0].n;

const fieldPartnerBalance = async (id) => parseFloat((await pool.query(
  `SELECT available_balance FROM field_partners WHERE id = $1`, [id]
)).rows[0].available_balance);

const bapBalance = async (id) => parseFloat((await pool.query(
  `SELECT balance FROM partners WHERE id = $1`, [id]
)).rows[0].balance);

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

/* ------------------------------------------------------------------ *
 * E. Engine primitives
 * ------------------------------------------------------------------ */

scenario('E1 creditWallet is idempotent on the reference', async () => {
  const uid = await freshUser();
  const ref = uniq('CR');

  const c1 = await pool.connect();
  await c1.query('BEGIN');
  const r1 = await fin.creditWallet({ client: c1, userId: uid, amount: 500, reference: ref, fromAccount: 'SUSPENSE' });
  await c1.query('COMMIT');
  c1.release();
  assert.strictEqual(r1.credited, 500);

  const c2 = await pool.connect();
  await c2.query('BEGIN');
  const r2 = await fin.creditWallet({ client: c2, userId: uid, amount: 500, reference: ref, fromAccount: 'SUSPENSE' });
  await c2.query('COMMIT');
  c2.release();
  assert.strictEqual(r2.dedup, true, 'replay was not deduped');

  assert.strictEqual(await balance(uid), 500, 'wallet credited twice');
  assert.strictEqual(await journalCount(ref), 2, 'journal posted twice');
  assert.strictEqual(await foCount(ref), 1, 'operation row duplicated');
  const op = await foOf(ref);
  assert.strictEqual(op.status, 'SUCCESS');
});

scenario('E2 creditWallet rolls back with the surrounding transaction', async () => {
  const uid = await freshUser();
  const ref = uniq('CR');
  const before = await balance(uid);

  const c = await pool.connect();
  await c.query('BEGIN');
  await fin.creditWallet({ client: c, userId: uid, amount: 700, reference: ref, fromAccount: 'SUSPENSE' });
  await c.query('ROLLBACK');
  c.release();

  assert.strictEqual(await balance(uid), before, 'rollback leaked a wallet credit');
  assert.strictEqual(await journalCount(ref), 0, 'rollback leaked a journal row');
  assert.strictEqual(await foCount(ref), 0, 'rollback leaked an operation row');
});

scenario('E3 debitWallet refuses insufficient funds with no residue', async () => {
  const uid = await freshUser();
  const ref = uniq('DB');
  const before = await balance(uid);

  const c = await pool.connect();
  await c.query('BEGIN');
  await assert.rejects(
    fin.debitWallet({ client: c, userId: uid, amount: before + 100, reference: ref, toAccount: 'SUSPENSE' }),
    /Salio lako halitoshi/
  );
  await c.query('ROLLBACK');
  c.release();

  assert.strictEqual(await balance(uid), before, 'wallet changed on a refused debit');
  assert.strictEqual(await journalCount(ref), 0, 'journal residue after a refused debit');
  assert.strictEqual(await foCount(ref), 0, 'operation residue after a refused debit');
});

scenario('E4 internalTransfer is idempotent and aggregate-neutral', async () => {
  const a = await freshUser();
  const b = await freshUser();
  const ref = uniq('TR');

  const c1 = await pool.connect();
  await c1.query('BEGIN');
  await fin.creditWallet({ client: c1, userId: a, amount: 1000, reference: uniq('FUND'), fromAccount: 'SUSPENSE' });
  await c1.query('COMMIT');
  c1.release();

  const beforeA = await balance(a);
  const beforeB = await balance(b);

  const c2 = await pool.connect();
  await c2.query('BEGIN');
  await fin.internalTransfer({ client: c2, fromUserId: a, toUserId: b, amount: 400, reference: ref });
  await c2.query('COMMIT');
  c2.release();

  const c3 = await pool.connect();
  await c3.query('BEGIN');
  const replay = await fin.internalTransfer({ client: c3, fromUserId: a, toUserId: b, amount: 400, reference: ref });
  await c3.query('COMMIT');
  c3.release();
  assert.strictEqual(replay.dedup, true, 'transfer replay was not deduped');

  assert.strictEqual(await balance(a), beforeA - 400, 'sender debited twice');
  assert.strictEqual(await balance(b), beforeB + 400, 'recipient credited twice');
  assert.strictEqual(await journalCount(ref), 2, 'transfer journal posted twice');
});

scenario('E5 internalTransfer refuses insufficient funds without moving either side', async () => {
  const a = await freshUser();
  const b = await freshUser();
  const ref = uniq('TR');
  const beforeA = await balance(a);
  const beforeB = await balance(b);

  const c = await pool.connect();
  await c.query('BEGIN');
  await assert.rejects(
    fin.internalTransfer({ client: c, fromUserId: a, toUserId: b, amount: beforeA + 50, reference: ref }),
    /Salio lako halitoshi/
  );
  await c.query('ROLLBACK');
  c.release();

  assert.strictEqual(await balance(a), beforeA);
  assert.strictEqual(await balance(b), beforeB);
  assert.strictEqual(await journalCount(ref), 0);
  assert.strictEqual(await foCount(ref), 0);
});

scenario('E6 postJournal rejects unbalanced lines', async () => {
  const ref = uniq('JE');
  const c = await pool.connect();
  await c.query('BEGIN');
  await assert.rejects(
    fin.postJournal({
      client: c,
      lines: [
        { accountCode: 'SUSPENSE', direction: 'DR', amount: 100 },
        { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: 90 },
      ],
      referenceId: ref,
      description: 'unbalanced probe',
    }),
    /unbalanced posting/
  );
  await c.query('ROLLBACK');
  c.release();
  assert.strictEqual(await journalCount(ref), 0);
});

scenario('E7 creditWallet rejects a replayed reference with a different amount', async () => {
  const uid = await freshUser();
  const ref = uniq('SHAPE');

  const c1 = await pool.connect();
  await c1.query('BEGIN');
  await fin.creditWallet({ client: c1, userId: uid, amount: 100, reference: ref, fromAccount: 'SUSPENSE' });
  await c1.query('COMMIT');
  c1.release();

  const c2 = await pool.connect();
  await c2.query('BEGIN');
  await assert.rejects(
    fin.creditWallet({ client: c2, userId: uid, amount: 200, reference: ref, fromAccount: 'SUSPENSE' }),
    (e) => e && e.code === 'OPERATION_SHAPE_MISMATCH' && e.mismatch.includes('amount')
  );
  await c2.query('ROLLBACK');
  c2.release();

  assert.strictEqual(await balance(uid), 100, 'wallet changed on a shape mismatch');
  assert.strictEqual(await journalCount(ref), 2, 'a second journal was posted on a shape mismatch');
  assert.strictEqual(await foCount(ref), 1, 'a second operation was created on a shape mismatch');
});

scenario('E8 creditWallet rejects a replayed reference with a different user', async () => {
  const a = await freshUser();
  const b = await freshUser();
  const ref = uniq('SHAPEUSER');

  const c1 = await pool.connect();
  await c1.query('BEGIN');
  await fin.creditWallet({ client: c1, userId: a, amount: 100, reference: ref, fromAccount: 'SUSPENSE' });
  await c1.query('COMMIT');
  c1.release();

  const c2 = await pool.connect();
  await c2.query('BEGIN');
  await assert.rejects(
    fin.creditWallet({ client: c2, userId: b, amount: 100, reference: ref, fromAccount: 'SUSPENSE' }),
    (e) => e && e.code === 'OPERATION_SHAPE_MISMATCH' && e.mismatch.includes('user_id')
  );
  await c2.query('ROLLBACK');
  c2.release();

  assert.strictEqual(await balance(b), 0, 'wallet of the wrong user was credited');
  assert.strictEqual(await journalCount(ref), 2, 'a second journal was posted on a shape mismatch');
});

scenario('E9 claimOperation shape validation is opt-in and precise', async () => {
  const a = await freshUser();
  const b = await freshUser();
  const ref = uniq('CLAIM');

  const c = await pool.connect();
  await c.query('BEGIN');
  const first = await fin.claimOperation({
    client: c, operationType: 'SHAPE_PROBE', reference: ref, userId: a, amount: 10, validateShape: true,
  });
  assert.strictEqual(first.claimed, true);

  const same = await fin.claimOperation({
    client: c, operationType: 'SHAPE_PROBE', reference: ref, userId: a, amount: 10, validateShape: true,
  });
  assert.strictEqual(same.claimed, false, 'same shape should dedup');

  await assert.rejects(
    fin.claimOperation({
      client: c, operationType: 'SHAPE_PROBE', reference: ref, userId: b, amount: 10, validateShape: true,
    }),
    (e) => e && e.code === 'OPERATION_SHAPE_MISMATCH' && e.mismatch.includes('user_id')
  );
  await assert.rejects(
    fin.claimOperation({
      client: c, operationType: 'OTHER_TYPE', reference: ref, userId: a, amount: 10, validateShape: true,
    }),
    (e) => e && e.code === 'OPERATION_SHAPE_MISMATCH' && e.mismatch.includes('operation_type')
  );
  await assert.rejects(
    fin.claimOperation({
      client: c, operationType: 'SHAPE_PROBE', reference: ref, userId: a, amount: 11, validateShape: true,
    }),
    (e) => e && e.code === 'OPERATION_SHAPE_MISMATCH' && e.mismatch.includes('amount')
  );

  await c.query('ROLLBACK');
  c.release();
  assert.strictEqual(await foCount(ref), 0, 'rolled-back probe left an operation row');
});

/* ------------------------------------------------------------------ *
 * F. Field partner funding
 * ------------------------------------------------------------------ */

scenario('F1 fundPartner with the same reference funds the pool once', async () => {
  const partnerId = await createFieldPartner();
  const ref = uniq('FPF');

  const first = await fieldPartner.fundPartner({ partnerId, amount: 1000, reference: ref });
  assert.strictEqual(first.funded, 1000);

  const second = await fieldPartner.fundPartner({ partnerId, amount: 1000, reference: ref });
  assert.ok(second.dedup === true, 'replay was not deduped');

  assert.strictEqual(await fieldPartnerBalance(partnerId), 1000, 'partner pool funded twice');
  assert.strictEqual(await journalCount(ref), 2, 'funding journal posted twice');
  assert.strictEqual(await foCount(ref), 1, 'funding operation duplicated');
  const op = await foOf(ref);
  assert.strictEqual(op.operation_type, 'FIELD_PARTNER_FUNDING');
  assert.strictEqual(op.status, 'SUCCESS');
});

scenario('F2 fundPartner with different references funds twice (distinct events)', async () => {
  const partnerId = await createFieldPartner();
  await fieldPartner.fundPartner({ partnerId, amount: 300, reference: uniq('FPF') });
  await fieldPartner.fundPartner({ partnerId, amount: 200, reference: uniq('FPF') });
  assert.strictEqual(await fieldPartnerBalance(partnerId), 500);
});

/* ------------------------------------------------------------------ *
 * B. BAP partner funding
 * ------------------------------------------------------------------ */

scenario('B1 BAP fundPartner with the same reference funds the pool once', async () => {
  const adminId = await freshUser();
  const partnerId = await createBapPartner();
  const ref = uniq('BPF');

  await bap.fundPartner(adminId, partnerId, 800, ref);
  await bap.fundPartner(adminId, partnerId, 800, ref);

  assert.strictEqual(await bapBalance(partnerId), 800, 'BAP partner funded twice');
  assert.strictEqual(await journalCount(`${ref}:FND`), 2, 'BAP funding journal posted twice');
  assert.strictEqual(await foCount(`${ref}:FND`), 1, 'BAP funding operation duplicated');
});

/* ------------------------------------------------------------------ *
 * S. SACCOS investment redemption
 * ------------------------------------------------------------------ */

scenario('S1 redeemInvestment sequential double call credits once', async () => {
  const uid = await freshUser();
  const { saccosId, investmentId } = await createSaccosFixture(uid);

  const first = await saccosInvestments.redeemInvestment(uid, saccosId, investmentId);
  assert.strictEqual(first.total, 1100);

  let secondError = null;
  try {
    await saccosInvestments.redeemInvestment(uid, saccosId, investmentId);
  } catch (e) {
    secondError = e;
  }
  assert.ok(secondError, 'second redemption did not fail');
  assert.strictEqual(secondError.code, 'SACCOS_INV_STATE');

  assert.strictEqual(await balance(uid), 1100, 'sequential double redemption double-credited');
  assert.strictEqual(await journalCount(`SACCOS-INV-RED:${investmentId}`), 3, 'redemption journal posted twice');
});

scenario('S2 redeemInvestment concurrent calls credit once', async () => {
  const uid = await freshUser();
  const { saccosId, investmentId } = await createSaccosFixture(uid);

  const results = await Promise.allSettled([
    saccosInvestments.redeemInvestment(uid, saccosId, investmentId),
    saccosInvestments.redeemInvestment(uid, saccosId, investmentId),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.strictEqual(fulfilled.length, 2, 'both concurrent calls should resolve (one as a dedup)');
  assert.strictEqual(await balance(uid), 1100, 'concurrent redemption double-credited');
  assert.strictEqual(await journalCount(`SACCOS-INV-RED:${investmentId}`), 3, 'concurrent redemption journal posted twice');
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
      console.log(`FAIL ${s.name}\n     ${(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')}`);
    }
  }

  console.log(`RESULT: ${scenarios.length - failed} passed, ${failed} failed of ${scenarios.length}`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})();
