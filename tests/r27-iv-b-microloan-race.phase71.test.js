#!/usr/bin/env node
'use strict';
/* R27 IV-B-1 / IV-B-2 — savingsCreditService.payInstallment / payoffLoan races.
 * Invariant checked every round: money actually debited from the borrower's wallet
 * == micro_loans.paid_amount, debited <= due_amount, and a fully paid loan is REPAID.
 *  [B-1] two different installments of one loan paid concurrently (10 rounds)
 *  [B-2] payoffLoan racing payInstallment (10 rounds)
 *  [B-3] the same installment paid twice concurrently: one success, debited once (10 rounds)
 *  [B-4] sequential path unchanged: pay 1 of 2, then payoff the rest; response shapes kept.
 * Adapted from the independent review's iv-b-microloan-race.test.js (evidence, not trusted).
 * Requires a DISPOSABLE database phase71_financial_audit_<suffix> on 127.0.0.1:55481.
 */
const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55481') {
  console.error('REFUSING: disposable r26-ci-db (127.0.0.1:55481, phase71_financial_audit_*) only'); process.exit(2);
}
const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = { post: async () => { throw new Error('net off'); }, get: async () => { throw new Error('net off'); }, create() { return this; }, defaults: { headers: { common: {} } }, interceptors: { request: { use() {} }, response: { use() {} } } };
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const credit = require(path.join(ROOT, 'src/services/savingsCreditService'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const num = async (s, p) => Number(Object.values(await q1(s, p))[0]);
let seq = 0;
async function borrower(fund) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R27B ${seq}`, `2559${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fin.creditWallet({ client: c, userId: u.id, amount: fund, reference: `R27B-F-${u.id}-${Date.now()}`, description: 'fund' }); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  return u.id;
}
async function activeLoan(userId, n, inst) {
  const due = n * inst;
  const l = await q1(`INSERT INTO micro_loans (user_id, amount, interest_rate, term_months, status, approved_at, disbursed_at, due_amount, monthly_installment, paid_amount)
                      VALUES ($1,$2,0,$3,'ACTIVE',NOW(),NOW(),$2,$4,0) RETURNING id`, [userId, due, n, inst]);
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push((await q1(`INSERT INTO loan_installments (loan_id, sequence, due_date, amount) VALUES ($1,$2,CURRENT_DATE + $2::int, $3) RETURNING id`, [l.id, i, inst])).id);
  return { id: l.id, ids, due };
}
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);
const loanRow = (id) => q1('SELECT paid_amount::float AS paid, due_amount::float AS due, status FROM micro_loans WHERE id=$1', [id]);
const ROUNDS = 10;

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[B-1] concurrent payInstallment on two different installments');
  let bad = []; let raw500 = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const u = await borrower(100000);
    const L = await activeLoan(u, 2, 3000);
    const w0 = await wallet(u);
    const res = await Promise.allSettled(L.ids.map((iid) => credit.payInstallment(u, L.id, iid)));
    const debited = w0 - (await wallet(u));
    const row = await loanRow(L.id);
    raw500 += res.filter((x) => x.status === 'rejected' && !(x.reason && x.reason.statusCode)).length;
    if (row.paid !== debited || debited > L.due || (debited === L.due && row.status !== 'REPAID')) bad.push({ debited, row, res: res.map((x) => x.status) });
  }
  check(`debited == paid_amount <= due, REPAID when fully paid (${ROUNDS} rounds)`, bad.length === 0, { bad: bad.length, sample: bad.slice(0, 2) });
  check('no untyped (500) errors', raw500 === 0, raw500);

  console.log('\n[B-2] payoffLoan racing payInstallment');
  bad = [];
  for (let r = 0; r < ROUNDS; r++) {
    const u = await borrower(100000);
    const L = await activeLoan(u, 3, 2000);
    const w0 = await wallet(u);
    const res = await Promise.allSettled([credit.payoffLoan(u, L.id), credit.payInstallment(u, L.id, L.ids[0])]);
    const debited = w0 - (await wallet(u));
    const row = await loanRow(L.id);
    if (debited > L.due || row.paid !== debited || (debited === L.due && row.status !== 'REPAID')) bad.push({ debited, due: L.due, row, res: res.map((x) => x.status) });
  }
  check(`never charged more than due; paid_amount == debited; REPAID kept (${ROUNDS} rounds)`, bad.length === 0, { bad: bad.length, sample: bad.slice(0, 2) });

  console.log('\n[B-3] same installment paid twice concurrently');
  bad = [];
  for (let r = 0; r < ROUNDS; r++) {
    const u = await borrower(100000);
    const L = await activeLoan(u, 2, 3000);
    const w0 = await wallet(u);
    const res = await Promise.allSettled([credit.payInstallment(u, L.id, L.ids[0]), credit.payInstallment(u, L.id, L.ids[0])]);
    const debited = w0 - (await wallet(u));
    const row = await loanRow(L.id);
    const ok = res.filter((x) => x.status === 'fulfilled').length;
    if (ok !== 1 || debited !== 3000 || row.paid !== 3000 || row.status !== 'ACTIVE') bad.push({ ok, debited, row });
  }
  check(`exactly one success, debited 3000 once, paid_amount 3000 (${ROUNDS} rounds)`, bad.length === 0, { bad: bad.length, sample: bad.slice(0, 2) });

  console.log('\n[B-4] sequential path unchanged');
  {
    const u = await borrower(100000);
    const L = await activeLoan(u, 2, 3000);
    const w0 = await wallet(u);
    const r1 = await credit.payInstallment(u, L.id, L.ids[0]);
    check('payInstallment response shape/values', r1.success === true && r1.paid === 3000 && r1.remaining === 3000 && r1.status === 'ACTIVE', r1);
    const again = await credit.payInstallment(u, L.id, L.ids[0]).then(() => null, (e) => e);
    check('paying a PAID installment again: 404, nothing debited', again && again.statusCode === 404 && w0 - (await wallet(u)) === 3000, again && again.statusCode);
    const r2 = await credit.payoffLoan(u, L.id);
    check('payoffLoan response shape/values', r2.success === true && r2.paid === 3000 && r2.status === 'REPAID' && r2.waived_count === 1, r2);
    const row = await loanRow(L.id);
    check('loan REPAID, paid 6000, debited 6000', row.status === 'REPAID' && row.paid === 6000 && w0 - (await wallet(u)) === 6000, row);
    const e3 = await credit.payoffLoan(u, L.id).then(() => null, (e) => e);
    check('payoff of a REPAID loan: 404', e3 && e3.statusCode === 404, e3 && e3.statusCode);
  }

  console.log('\n[B-5] deterministic: payoff paused inside its debit while an installment is paid');
  {
    const u = await borrower(100000);
    const L = await activeLoan(u, 3, 2000);
    const w0 = await wallet(u);
    const orig = fin.debitWallet;
    let instDone; const instFinished = new Promise((r) => { instDone = r; });
    fin.debitWallet = async (args) => {
      if (String(args.reference).endsWith(':PAYOFF')) {
        // Unlocked payoff: the installment completes meanwhile (stale remaining).
        // Locked payoff: the installment waits on the loan lock; continue after 1.5s.
        await Promise.race([instFinished, new Promise((r) => setTimeout(r, 1500))]);
      }
      return orig(args);
    };
    let res;
    try {
      const pPay = credit.payoffLoan(u, L.id);
      await new Promise((r) => setTimeout(r, 200)); // payoff has read/locked the loan
      const pInst = credit.payInstallment(u, L.id, L.ids[0]).finally(() => instDone());
      res = await Promise.allSettled([pPay, pInst]);
    } finally { fin.debitWallet = orig; }
    const debited = w0 - (await wallet(u));
    const row = await loanRow(L.id);
    check('payoff + installment: debited == due (6000), never more', debited === 6000, { debited, res: res.map((x) => x.status === 'fulfilled' ? 'ok' : x.reason.message) });
    check('loan REPAID with paid_amount == debited', row.status === 'REPAID' && row.paid === debited, row);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
