#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R25: cross-service transaction integrity
 *
 *  R25-02  businessService.repayLoan: concurrent repayments must not debit the
 *          business more than the loan is credited (lost update on paid_amount).
 *  R25-03  familyService.processRoundUps: concurrent runs must round up each
 *          transfer once (no double debit, one roundup_log row per transfer).
 *  R25-04  cardService.authorizeCard: the daily / per-transaction limits and
 *          the card state are evaluated under the card row lock inside the
 *          authorization transaction (no concurrent limit bypass); declines
 *          are still recorded.
 *  R25-05  networkService.processBulkBatch: a failed item leaves no
 *          SUCCESS transaction / ledger effect (per-item savepoint), and
 *          concurrent processing runs the batch exactly once.
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix> on
 * 127.0.0.1:55471. axios is stubbed: no real network.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55471') {
  console.error('REFUSING: DB_HOST/DB_PORT must be the disposable p71-ci-db (127.0.0.1:55471).');
  process.exit(2);
}

const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = {
  post: async () => { throw new Error('network disabled in test'); },
  get: async () => { throw new Error('network disabled in test'); },
};
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const business = require(path.join(ROOT, 'src/services/businessService'));
const card = require(path.join(ROOT, 'src/services/cardService'));
const network = require(path.join(ROOT, 'src/services/networkService'));
const family = require(path.join(ROOT, 'src/services/familyService'));

let passed = 0; let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
async function section(fn) {
  try { await fn(); } catch (e) { failed++; console.log(`  ✗ section aborted — ${e.message}`); }
}
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const num = async (sql, p) => Number(Object.values(await q1(sql, p))[0]);
let seq = 0;
async function user(label) {
  seq++;
  const phone = `2555${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R25T ${label} ${seq}`, phone])).id;
  return { id, phone };
}
async function fund(userId, amount) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fin.creditWallet({ client: c, userId, amount, reference: `R25T-FUND-${userId}-${seq}-${Date.now()}`, description: 'test funding' });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);
const locked = (id) => num('SELECT locked_balance FROM users WHERE id=$1', [id]);
async function expectReject(fn) { try { await fn(); return null; } catch (e) { return e; } }
const ok = (r) => r.filter((x) => x.status === 'fulfilled').length;
const errs = (r) => r.filter((x) => x.status === 'rejected').map((x) => `${x.reason.statusCode || ''}:${x.reason.code || ''}:${x.reason.message.slice(0, 50)}`);

(async () => {
  const id = await q1('SELECT current_database() db, inet_server_addr() addr, inet_server_port() port');
  console.log(`DB identity: database=${id.db} server_addr=${id.addr} server_port=${id.port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  // ---------------------------------------------------------------- R25-02
  console.log('\n[1] R25-02 repayLoan: concurrent repayments debit = credit');
  await section(async () => {
    const o = await user('repay');
    const biz = await business.registerBusiness(o.id, { business_name: 'R25T repay' });
    await pool.query('UPDATE business_accounts SET balance = 20000 WHERE id=$1', [biz.id]);
    const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status, due_amount, paid_amount)
                           VALUES ($1,$2,10000,10,12,'DISBURSED',11000,0) RETURNING id`, [biz.id, o.id]);
    const r = await Promise.allSettled([1, 2, 3, 4, 5].map(() => business.repayLoan(o.id, loan.id, 1000)));
    const bal = await num('SELECT balance FROM business_accounts WHERE id=$1', [biz.id]);
    const paid = await num('SELECT paid_amount FROM business_loans WHERE id=$1', [loan.id]);
    check('5/5 repayments succeed', ok(r) === 5, errs(r));
    check('business debited 5,000', 20000 - bal === 5000, 20000 - bal);
    check('loan paid_amount 5,000 (no lost update)', paid === 5000, paid);
    check('5 repayment journals (10 lines, 5,000 each side)', (await num(`SELECT COUNT(*) FROM journal_entries WHERE reference_id LIKE $1`, [`BIZREPAY:${loan.id}:%`])) === 10
      && (await num(`SELECT COALESCE(SUM(amount),0) FROM journal_entries WHERE reference_id LIKE $1 AND direction='DR'`, [`BIZREPAY:${loan.id}:%`])) === 5000);
  });

  console.log('\n[2] R25-02 repayLoan: insufficient balance under concurrency never goes negative / never over-credits');
  await section(async () => {
    const o = await user('repay2');
    const biz = await business.registerBusiness(o.id, { business_name: 'R25T repay2' });
    await pool.query('UPDATE business_accounts SET balance = 2500 WHERE id=$1', [biz.id]);
    const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status, due_amount, paid_amount)
                           VALUES ($1,$2,10000,10,12,'DISBURSED',11000,0) RETURNING id`, [biz.id, o.id]);
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => business.repayLoan(o.id, loan.id, 1000)));
    const bal = await num('SELECT balance FROM business_accounts WHERE id=$1', [biz.id]);
    const paid = await num('SELECT paid_amount FROM business_loans WHERE id=$1', [loan.id]);
    check('exactly 2 of 4 succeed (balance 2,500)', ok(r) === 2, { ok: ok(r), errs: errs(r) });
    check('balance 500 and paid 2,000', bal === 500 && paid === 2000, { bal, paid });
    const other = await user('repay-intruder');
    const e = await expectReject(() => business.repayLoan(other.id, loan.id, 100));
    check('non-owner rejected 403, nothing changed', e && e.statusCode === 403 && (await num('SELECT paid_amount FROM business_loans WHERE id=$1', [loan.id])) === 2000, e && e.statusCode);
  });

  console.log('\n[3] R25-02 repayLoan: failure mid-transaction rolls back debit and paid_amount');
  await section(async () => {
    const o = await user('repay3');
    const biz = await business.registerBusiness(o.id, { business_name: 'R25T repay3' });
    await pool.query('UPDATE business_accounts SET balance = 5000 WHERE id=$1', [biz.id]);
    const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status, due_amount, paid_amount)
                           VALUES ($1,$2,10000,10,12,'DISBURSED',11000,0) RETURNING id`, [biz.id, o.id]);
    const orig = fin.postJournal;
    fin.postJournal = async () => { throw new Error('injected journal failure'); };
    let e;
    try { e = await expectReject(() => business.repayLoan(o.id, loan.id, 1000)); } finally { fin.postJournal = orig; }
    check('repayment failed', !!e);
    check('balance and paid unchanged', (await num('SELECT balance FROM business_accounts WHERE id=$1', [biz.id])) === 5000
      && (await num('SELECT paid_amount FROM business_loans WHERE id=$1', [loan.id])) === 0);
  });

  // ---------------------------------------------------------------- R25-03
  console.log('\n[4] R25-03 processRoundUps: concurrent runs round each transfer once');
  await section(async () => {
    const o = await user('round'); await fund(o.id, 10000);
    for (let i = 0; i < 3; i++) {
      await pool.query(`INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
                        VALUES ($1,$2,1500,0,1500,'SUCCESS','TRANSFER','{}')`, [`R25T-T-${o.id}-${i}`, o.id]);
    }
    await family.createRoundupRule(o.id, { round_to: 1000 });
    const before = await wallet(o.id);
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => family.processRoundUps(o.id)));
    const debited = before - (await wallet(o.id));
    const logs = await num('SELECT COUNT(*) FROM roundup_log WHERE user_id=$1', [o.id]);
    const dup = await num('SELECT COUNT(*) FROM (SELECT transaction_id FROM roundup_log WHERE user_id=$1 GROUP BY 1 HAVING COUNT(*)>1) x', [o.id]);
    const total = await num('SELECT total_roundup FROM roundup_rules WHERE user_id=$1', [o.id]);
    check('all runs complete', ok(r) === 4, errs(r));
    check('wallet debited exactly 1,500', debited === 1500, debited);
    check('3 roundup_log rows, no duplicates', logs === 3 && dup === 0, { logs, dup });
    check('rule total_roundup 1,500', total === 1500, total);
    const again = await family.processRoundUps(o.id);
    check('re-run rounds nothing', again.roundup_saved === 0, again);
  });

  // ---------------------------------------------------------------- R25-04
  console.log('\n[5] R25-04 authorizeCard: concurrent auths respect the daily limit');
  await section(async () => {
    const o = await user('card'); await fund(o.id, 10000);
    const iss = await card.issueCard(o.id, { daily_limit: 1000, per_txn_limit: 1000 });
    const r = await Promise.allSettled([1, 2, 3, 4, 5].map(() => card.authorizeCard(o.id, iss.card.id, { merchant_name: 'R25T', amount: 600, cvv: iss.cvv })));
    const held = await num(`SELECT COALESCE(SUM(amount),0) FROM card_transactions WHERE card_id=$1 AND status='AUTH_HOLD'`, [iss.card.id]);
    const declined = await num(`SELECT COUNT(*) FROM card_transactions WHERE card_id=$1 AND status='DECLINED' AND declined_reason='OVER_DAILY_LIMIT'`, [iss.card.id]);
    check('exactly 1 of 5 authorized', ok(r) === 1, { ok: ok(r), errs: errs(r) });
    check('AUTH_HOLD total 600 (≤ limit 1,000)', held === 600, held);
    check('4 declines recorded as OVER_DAILY_LIMIT', declined === 4, declined);
    check('locked balance 600, wallet 9,400', (await locked(o.id)) === 600 && (await wallet(o.id)) === 9400, { locked: await locked(o.id), wallet: await wallet(o.id) });
  });

  console.log('\n[6] R25-04 authorizeCard: decline paths still recorded, nothing held');
  await section(async () => {
    const o = await user('card2'); await fund(o.id, 500);
    const iss = await card.issueCard(o.id, { daily_limit: 100000, per_txn_limit: 2000 });
    const cases = [
      [{ amount: 100, cvv: '000' }, 'INVALID_CVV'],
      [{ amount: 5000, cvv: iss.cvv }, 'OVER_TRANSACTION_LIMIT'],
      [{ amount: 1000, cvv: iss.cvv }, 'INSUFFICIENT_FUNDS'],
    ];
    for (const [d, reason] of cases) {
      const e = await expectReject(() => card.authorizeCard(o.id, iss.card.id, { merchant_name: 'R25T', ...d }));
      const n = await num(`SELECT COUNT(*) FROM card_transactions WHERE card_id=$1 AND status='DECLINED' AND declined_reason=$2`, [iss.card.id, reason]);
      check(`${reason}: rejected and DECLINED row recorded`, !!e && n === 1, { err: e && e.message, n });
    }
    await card.freezeCard(o.id, iss.card.id, true);
    const eF = await expectReject(() => card.authorizeCard(o.id, iss.card.id, { merchant_name: 'R25T', amount: 100, cvv: iss.cvv }));
    check('frozen card: rejected and DECLINED CARD_FROZEN recorded', !!eF && (await num(`SELECT COUNT(*) FROM card_transactions WHERE card_id=$1 AND declined_reason='CARD_FROZEN'`, [iss.card.id])) === 1);
    check('nothing held', (await locked(o.id)) === 0 && (await wallet(o.id)) === 500);
    const intruder = await user('card-intruder');
    const eO = await expectReject(() => card.authorizeCard(intruder.id, iss.card.id, { merchant_name: 'R25T', amount: 1, cvv: iss.cvv }));
    check('non-owner rejected', !!eO, eO && eO.message);
    const ok1 = await card.authorizeCard(o.id, (await card.issueCard(o.id, {})).card.id, { merchant_name: 'x', amount: 1, cvv: '1' }).catch((x) => x);
    check('fresh card with wrong cvv still declined (sanity)', ok1 instanceof Error);
  });

  // ---------------------------------------------------------------- R25-05
  console.log('\n[7] R25-05 processBulkBatch: failed items leave no SUCCESS record or ledger effect');
  await section(async () => {
    const s = await user('bulk'); await fund(s.id, 10000);
    const rc = await user('bulk-r');
    const b = await network.createBulkBatch(s.id, { batch_name: 'R25T bulk', recipients: [
      { phone: rc.phone, amount: 100 }, { phone: rc.phone, amount: -50 }, { phone: rc.phone, amount: 0 }, { phone: '255000000001', amount: 10 }] });
    const res = await network.processBulkBatch(b.id, s.id);
    const items = (await pool.query('SELECT status FROM bulk_payment_items WHERE batch_id=$1 ORDER BY id', [b.id])).rows.map((x) => x.status);
    const succTx = await num(`SELECT COUNT(*) FROM transactions WHERE type='BULK_PAYMENT' AND status='SUCCESS' AND (meta->>'batch_id')::int=$1`, [b.id]);
    check('result 1 success / 3 failed', res.success === 1 && res.failed === 3, res);
    check('items SUCCESS,FAILED,FAILED,FAILED', JSON.stringify(items) === '["SUCCESS","FAILED","FAILED","FAILED"]', items);
    check('exactly 1 SUCCESS BULK_PAYMENT transaction', succTx === 1, succTx);
    check('sender 9,900 / recipient 100', (await wallet(s.id)) === 9900 && (await wallet(rc.id)) === 100);
    check('no financial_operations claim left for failed items', (await num(`SELECT COUNT(*) FROM financial_operations WHERE reference_id IN (SELECT 'NET:'||id||':TR' FROM bulk_payment_items WHERE batch_id=$1 AND status='FAILED')`, [b.id])) === 0);
    check('batch COMPLETED', (await q1('SELECT status FROM bulk_payment_batches WHERE id=$1', [b.id])).status === 'COMPLETED');
  });

  console.log('\n[8] R25-05 processBulkBatch: concurrent processing runs once; records consistent');
  await section(async () => {
    const s = await user('bulk2'); await fund(s.id, 10000);
    const r1 = await user('b2r1'); const r2 = await user('b2r2'); const r3 = await user('b2r3');
    const b = await network.createBulkBatch(s.id, { batch_name: 'R25T bulk2', recipients: [
      { phone: r1.phone, amount: 100 }, { phone: r2.phone, amount: 200 }, { phone: r3.phone, amount: 300 }] });
    const r = await Promise.allSettled([1, 2, 3].map(() => network.processBulkBatch(b.id, s.id)));
    const vals = r.map((x) => (x.status === 'fulfilled' ? x.value : { err: x.reason.message }));
    const ran = vals.filter((v) => v.success === 3).length;
    const already = vals.filter((v) => v.message === 'Batch tayari imechakatwa.').length;
    const succTx = await num(`SELECT COUNT(*) FROM transactions WHERE type='BULK_PAYMENT' AND status='SUCCESS' AND (meta->>'batch_id')::int=$1`, [b.id]);
    const items = (await pool.query('SELECT status FROM bulk_payment_items WHERE batch_id=$1 ORDER BY id', [b.id])).rows.map((x) => x.status);
    check('exactly one run processed the batch; others got the existing "already processed" reply', ran === 1 && already === 2, vals);
    check('sender debited 600 once', 10000 - (await wallet(s.id)) === 600);
    check('3 SUCCESS BULK_PAYMENT transactions (no duplicates)', succTx === 3, succTx);
    check('all items SUCCESS', items.every((x) => x === 'SUCCESS'), items);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.log('FATAL', e.stack || e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
