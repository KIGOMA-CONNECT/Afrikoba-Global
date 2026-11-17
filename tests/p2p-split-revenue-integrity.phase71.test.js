#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R22: P2P revenue + split integrity
 *   recordProjectRevenue / runSplitPayment / runDueSplitPayments
 *     (src/services/splitPaymentService.js)
 *   POST /admin/projects/:projectId/revenue | /split  (src/routes/adminRoutes.js)
 *
 * Findings covered (PHASE-1-READ-ONLY-FINANCIAL-INTEGRITY-VERIFICATION.md):
 *  B6-2  investor with several EQUAL ACTIVE investment rows: every row's
 *        pro-rata share is paid (one credit per investor, the sum of the rows),
 *        and exactly one SUCCESS INVESTMENT_PAYOUT row per credited investor.
 *  B6-3  investor with UNEQUAL rows: the split completes (no
 *        OPERATION_SHAPE_MISMATCH rollback) and pays the sum.
 *  B6-2b a reused investor reference (dedup) fails closed: the split rolls back,
 *        no SUCCESS row without a credit, nothing mutated.
 *  B6-4  a failure late in the split (outbox conflict) rolls everything back.
 *  C4B-5 two concurrent splits of the same period: one pays, one is duplicate.
 *  C4B-4 revenue declaration with an idempotency key is recorded once
 *        (sequential + concurrent replay); a reused key with another amount is
 *        rejected; without a key the current behaviour is unchanged.
 *  C4B-7 revenue declaration and split write an audit_logs row inside the same
 *        transaction, with the actor (admin id, or NULL + trigger CRON).
 *  C4B-11 zero-amount legs are skipped (no invalid-journal failure); a negative
 *        leg (rules > 100 %) is rejected with nothing mutated.
 *  Reconciliation: Δ SUM(users.wallet_balance) == Δ journal CUSTOMER_WALLET,
 *        SUSPENSE nets to zero for a fully paid project, invariants hold.
 *
 * axios is stubbed: no real network. Run with a connection logger preload.
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix>.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

setTimeout(() => {
  console.log('\nWATCHDOG: test process exceeded 120 s; exiting with failure.');
  process.exit(1);
}, 120000).unref();

require('axios');
const axiosPath = require.resolve('axios');
const httpCalls = [];
require.cache[axiosPath].exports = {
  post: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.post not expected'); },
  get: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.get not expected'); },
};

const pool = require('../src/config/db');
const split = require('../src/services/splitPaymentService');
const { enqueueOutbox } = require('../src/services/outboxService');

const SPLIT_FILE = path.join(__dirname, '..', 'src', 'services', 'splitPaymentService.js');
const ROUTES_FILE = path.join(__dirname, '..', 'src', 'routes', 'adminRoutes.js');
const tag = crypto.randomBytes(4).toString('hex');
let seq = 0;

let passed = 0;
let failed = 0;
const failures = [];
function ok(label) { passed++; console.log('  ✓ ' + label); }
function bad(label, extra) {
  failed++;
  failures.push(label);
  console.log('  ✗ ' + label + (extra !== undefined ? ' :: ' + extra : ''));
}
function expect(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function section(label) { console.log('\n--- ' + label + ' ---'); }
async function safe(fn) {
  try { return { value: await fn() }; } catch (e) { return { error: e.message || String(e), err: e }; }
}
function progress(msg) { console.log(`  · ${msg}`); }
const money = (v) => Math.round(Number(v) * 100) / 100;

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label, role) {
  seq += 1;
  const phone = `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71R22 ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  return id;
}
// P2P project with wallet + default 70/28/2 rules; investments = [[userId, shares], ...]
async function makeProject(investments, status = 'FUNDED') {
  const owner = await makeUser('owner');
  const p = (await pool.query(
    `INSERT INTO investment_projects
       (owner_user_id, title, sector, description, target_amount, raised_amount, share_price,
        roi_percentage, tenure_months, payback_start_months, status)
     VALUES ($1, $2, 'SMES', 'R22 test', 100000, 100000, 1000, 10, 12, 1, $3) RETURNING id`,
    [owner, `P71R22 ${tag} ${++seq}`, status])).rows[0].id;
  await pool.query('INSERT INTO project_business_wallets (project_id) VALUES ($1)', [p]);
  await pool.query('INSERT INTO project_settlement_rules (project_id) VALUES ($1)', [p]);
  for (const [uid, shares] of investments) {
    await pool.query(
      `INSERT INTO investments (project_id, investor_user_id, shares_bought, total_amount, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')`, [p, uid, shares, shares * 1000]);
  }
  return { projectId: p, owner };
}
async function balances(ids) {
  const r = await pool.query('SELECT id, wallet_balance FROM users WHERE id = ANY($1::int[])', [ids]);
  const out = {};
  for (const row of r.rows) out[row.id] = Number(row.wallet_balance);
  return out;
}
// Everything a split writes for one project.
async function splitFootprint(projectId) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows[0];
  return {
    runs: (await q('SELECT COUNT(*)::int AS c FROM revenue_split_runs WHERE project_id = $1', [projectId])).c,
    payouts: (await q(`SELECT COUNT(*)::int AS c FROM transactions WHERE type = 'INVESTMENT_PAYOUT' AND meta->>'project_id' = $1`, [String(projectId)])).c,
    splitJournal: (await q(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id LIKE $1`, [`SPLIT:${projectId}:%`])).c,
    splitOps: (await q(`SELECT COUNT(*)::int AS c FROM financial_operations WHERE reference_id LIKE $1 AND status = 'SUCCESS'`, [`SPLIT:${projectId}:%`])).c,
    collected: Number((await q('SELECT total_revenue_collected AS v FROM project_business_wallets WHERE project_id = $1', [projectId])).v),
    reserved: Number((await q('SELECT investor_reserved_balance AS v FROM project_business_wallets WHERE project_id = $1', [projectId])).v),
    outbox: (await q(`SELECT COUNT(*)::int AS c FROM outbox_events WHERE reference_id LIKE $1`, [`PROJECT_SPLIT_SMS:${projectId}:%`])).c,
  };
}
async function payoutsByInvestor(projectId) {
  const r = await pool.query(
    `SELECT user_id, COUNT(*)::int AS n, SUM(wallet_amount)::numeric AS s FROM transactions
      WHERE type = 'INVESTMENT_PAYOUT' AND meta->>'project_id' = $1 GROUP BY user_id`, [String(projectId)]);
  const out = {};
  for (const row of r.rows) out[row.user_id] = { n: row.n, s: Number(row.s) };
  return out;
}
// Net ledger balance (ASSET: DR-CR; LIABILITY: CR-DR) restricted to a reference pattern.
async function accountNet(code, refLike) {
  const r = await pool.query(
    `SELECT la.account_type,
            COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0) dr,
            COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0) cr
       FROM ledger_accounts la LEFT JOIN journal_entries je ON je.account_id = la.id
        AND ($2::text IS NULL OR je.reference_id LIKE $2)
      WHERE la.account_code = $1 GROUP BY la.account_type`, [code, refLike || null]);
  const { account_type: t, dr, cr } = r.rows[0];
  return money(t === 'ASSET' || t === 'EXPENSE' ? Number(dr) - Number(cr) : Number(cr) - Number(dr));
}
async function walletProjection() {
  return money((await pool.query('SELECT COALESCE(SUM(wallet_balance),0) AS v FROM users')).rows[0].v);
}
async function auditRows(action, projectId) {
  return (await pool.query(
    `SELECT user_id, action, entity_type, entity_id, meta FROM audit_logs
      WHERE action = $1 AND entity_id = $2 ORDER BY created_at`, [action, projectId])).rows;
}
const quiet = async (fn) => {
  const logger = require('../src/utils/logger');
  const real = logger.error;
  logger.error = () => {};
  try { return await fn(); } finally { logger.error = real; }
};

// ---------------------------------------------------------------------------
async function testEqualRows() {
  section('1. B6-2: investor with two EQUAL ACTIVE rows is paid for both rows');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const pr = await makeProject([[invA, 10], [invA, 10], [invB, 20]]);
  const walletBefore = await walletProjection();
  const ledgerBefore = await accountNet('CUSTOMER_WALLET');
  await split.recordProjectRevenue(pr.projectId, 1000, 'r22 s1');
  const before = await balances([pr.owner, invA, invB]);
  const r = await safe(() => split.runSplitPayment(pr.projectId, 1, 2031));
  const after = await balances([pr.owner, invA, invB]);
  const per = await payoutsByInvestor(pr.projectId);
  const fp = await splitFootprint(pr.projectId);
  progress(`result ${r.error || JSON.stringify(r.value)}; payouts ${JSON.stringify(per)}; footprint ${JSON.stringify(fp)}`);
  expect(!r.error && r.value.success === true, 'split succeeds', r.error);
  expect(money(after[pr.owner] - before[pr.owner]) === 700, 'owner credited 700 (70 %)', after[pr.owner] - before[pr.owner]);
  expect(money(after[invA] - before[invA]) === 140, 'investor A (10+10 of 40 shares) credited 140', after[invA] - before[invA]);
  expect(money(after[invB] - before[invB]) === 140, 'investor B (20 of 40 shares) credited 140', after[invB] - before[invB]);
  expect(per[invA] && per[invA].n === 1 && per[invA].s === 140, 'investor A: exactly one SUCCESS INVESTMENT_PAYOUT of 140', JSON.stringify(per[invA]));
  expect(per[invB] && per[invB].n === 1 && per[invB].s === 140, 'investor B: exactly one SUCCESS INVESTMENT_PAYOUT of 140', JSON.stringify(per[invB]));
  const paid = Object.values(per).reduce((s, x) => s + x.s, 0);
  expect(money(paid) === money(fp.reserved), 'Σ payout rows == investor_reserved_balance (280)', `${paid} vs ${fp.reserved}`);
  expect(await accountNet('SUSPENSE', `%:${pr.projectId}:%`) === 0, 'SUSPENSE nets to 0 for this project (REV + SPLIT refs)', await accountNet('SUSPENSE', `%:${pr.projectId}:%`));
  const dWallet = money((await walletProjection()) - walletBefore);
  const dLedger = money((await accountNet('CUSTOMER_WALLET')) - ledgerBefore);
  expect(dWallet === dLedger && dWallet === 980, 'reconciliation: Δ wallets == Δ journal CUSTOMER_WALLET == 980', `${dWallet} vs ${dLedger}`);
}

async function testUnequalRows() {
  section('2. B6-3: investor with UNEQUAL rows: split completes and pays the sum');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const pr = await makeProject([[invA, 10], [invA, 30], [invB, 40]]);
  await split.recordProjectRevenue(pr.projectId, 1000, 'r22 s2');
  const before = await balances([invA, invB]);
  const r = await safe(() => split.runSplitPayment(pr.projectId, 1, 2031));
  const after = await balances([invA, invB]);
  const fp = await splitFootprint(pr.projectId);
  progress(`result ${r.error || JSON.stringify(r.value)}; footprint ${JSON.stringify(fp)}`);
  expect(!r.error && r.value.success === true, 'split succeeds (no OPERATION_SHAPE_MISMATCH rollback)', r.error);
  expect(money(after[invA] - before[invA]) === 140 && money(after[invB] - before[invB]) === 140,
    'investors A (10+30) and B (40) each credited 140', `${after[invA] - before[invA]} / ${after[invB] - before[invB]}`);
  expect(fp.runs === 1 && fp.collected === 0, 'one split run recorded; collected revenue reset', JSON.stringify(fp));
}

async function testDedupFailsClosed() {
  section('3. B6-2b: a reused investor reference fails closed (no SUCCESS row without a credit)');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const pr = await makeProject([[invA, 20], [invB, 20]]);
  await split.recordProjectRevenue(pr.projectId, 1000, 'r22 s3');
  // Simulate a reference already claimed (e.g. a stray earlier operation).
  await pool.query(
    `INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status, attempts)
     VALUES ('CREDIT', $1, $2, 140, 'SUCCESS', 1)`, [`SPLIT:${pr.projectId}:2031-1:INV:${invA}`, invA]);
  const before = await balances([pr.owner, invA, invB]);
  const fpBefore = await splitFootprint(pr.projectId);
  const r = await safe(() => split.runSplitPayment(pr.projectId, 1, 2031));
  const after = await balances([pr.owner, invA, invB]);
  const fp = await splitFootprint(pr.projectId);
  progress(`result ${r.error || JSON.stringify(r.value)}; footprint ${JSON.stringify(fp)}`);
  expect(!!r.error, 'split is rejected', JSON.stringify(r.value));
  expect(JSON.stringify(before) === JSON.stringify(after), 'no wallet changed (owner, A, B)', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  expect(fp.payouts === 0 && fp.runs === 0 && fp.splitJournal === 0 && fp.outbox === 0,
    'no INVESTMENT_PAYOUT row, split run, SPLIT journal or outbox row', JSON.stringify(fp));
  expect(fp.collected === fpBefore.collected && fp.collected === 1000, 'collected revenue unchanged (1000)', fp.collected);
}

async function testLateFailureRollsBack() {
  section('4. B6-4: a failure late in the split rolls everything back');
  const invA = await makeUser('invA');
  const pr = await makeProject([[invA, 10]]);
  await split.recordProjectRevenue(pr.projectId, 1000, 'r22 s4');
  // A conflicting owner SMS outbox row makes the LAST step of the split throw.
  await enqueueOutbox({ eventType: 'PROJECT_SPLIT_SMS', aggregateId: String(pr.projectId),
    reference: `PROJECT_SPLIT_SMS:${pr.projectId}:2031-1:OWNER`, payload: { phone: 'x', body: 'conflict' } });
  const before = await balances([pr.owner, invA]);
  const r = await safe(() => split.runSplitPayment(pr.projectId, 1, 2031));
  const after = await balances([pr.owner, invA]);
  const fp = await splitFootprint(pr.projectId);
  progress(`result ${r.error || JSON.stringify(r.value)}; footprint ${JSON.stringify(fp)}`);
  expect(!!r.error && /payload conflict/.test(r.error), 'split fails on the late outbox conflict', r.error);
  expect(JSON.stringify(before) === JSON.stringify(after), 'owner and investor wallets unchanged', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  expect(fp.payouts === 0 && fp.runs === 0 && fp.splitJournal === 0 && fp.splitOps === 0 && fp.collected === 1000 && fp.outbox === 1,
    'no payout row, run, journal or operation; revenue still 1000; only the pre-existing outbox row', JSON.stringify(fp));
  expect((await auditRows('P2P_PROJECT_SPLIT_RUN', pr.projectId)).length === 0, 'no split audit row survives the rollback');
}

async function testConcurrentSplit() {
  section('5. C4B-5: two concurrent splits of the same period pay once');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const pr = await makeProject([[invA, 10], [invA, 10], [invB, 20]]);
  await split.recordProjectRevenue(pr.projectId, 1000, 'r22 s5');
  const before = await balances([pr.owner, invA, invB]);
  const rs = await Promise.all([1, 2].map(() => safe(() => split.runSplitPayment(pr.projectId, 2, 2031))));
  const after = await balances([pr.owner, invA, invB]);
  const fp = await splitFootprint(pr.projectId);
  progress(`results ${JSON.stringify(rs.map((x) => x.error || x.value))}; footprint ${JSON.stringify(fp)}`);
  const succ = rs.filter((x) => x.value && x.value.success === true).length;
  const dup = rs.filter((x) => x.value && x.value.duplicate === true).length;
  expect(succ === 1 && dup === 1, 'exactly one success and one duplicate', JSON.stringify(rs.map((x) => x.error || x.value)));
  expect(money(after[pr.owner] - before[pr.owner]) === 700 && money(after[invA] - before[invA]) === 140 && money(after[invB] - before[invB]) === 140,
    'owner 700, A 140, B 140 credited once', JSON.stringify({ before, after }));
  expect(fp.runs === 1 && fp.payouts === 2, 'one run, two payout rows', JSON.stringify(fp));
}

async function testRevenueIdempotency() {
  section('6. C4B-4: revenue declaration with an idempotency key is recorded once');
  const pr = await makeProject([]);
  const revJournal = async () => (await pool.query(
    `SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id LIKE $1`, [`REV:${pr.projectId}:%`])).rows[0].c;
  const r1 = await safe(() => split.recordProjectRevenue(pr.projectId, 500, 'k1', { idempotencyKey: `k1-${tag}` }));
  const r2 = await safe(() => split.recordProjectRevenue(pr.projectId, 500, 'k1', { idempotencyKey: `k1-${tag}` }));
  let fp = await splitFootprint(pr.projectId);
  progress(`r1 ${r1.error || 'ok'}; r2 ${r2.error || JSON.stringify({ replay: r2.value.replay })}; collected ${fp.collected}; REV journal rows ${await revJournal()}`);
  expect(!r1.error && !r2.error, 'both calls succeed', `${r1.error} / ${r2.error}`);
  expect(r2.value && r2.value.replay === true, 'second call reports replay=true', JSON.stringify(r2.value));
  expect(fp.collected === 500 && (await revJournal()) === 2, 'collected 500, one journal pair', `${fp.collected} / ${await revJournal()}`);
  const r3 = await safe(() => split.recordProjectRevenue(pr.projectId, 600, 'k1', { idempotencyKey: `k1-${tag}` }));
  fp = await splitFootprint(pr.projectId);
  expect(!!r3.err && r3.err.statusCode === 409 && fp.collected === 500, 'same key, different amount: 409, nothing changed', `${r3.error} / ${fp.collected}`);
  const conc = await Promise.all([1, 2, 3, 4, 5].map(() => safe(() => split.recordProjectRevenue(pr.projectId, 250, 'k3', { idempotencyKey: `k3-${tag}` }))));
  fp = await splitFootprint(pr.projectId);
  progress(`concurrent: ${JSON.stringify(conc.map((x) => x.error || (x.value.replay ? 'replay' : 'new')))}; collected ${fp.collected}`);
  expect(conc.every((x) => !x.error) && conc.filter((x) => !x.value.replay).length === 1, '5 concurrent same-key calls: one new, four replays', JSON.stringify(conc.map((x) => x.error || x.value.replay)));
  expect(fp.collected === 750 && (await revJournal()) === 4, 'collected 750, two journal pairs in total', `${fp.collected} / ${await revJournal()}`);
  const n1 = await safe(() => split.recordProjectRevenue(pr.projectId, 100, 'nokey'));
  const n2 = await safe(() => split.recordProjectRevenue(pr.projectId, 100, 'nokey'));
  fp = await splitFootprint(pr.projectId);
  expect(!n1.error && !n2.error && fp.collected === 950, 'without a key: behaviour unchanged (each call records; residual risk)', `${n1.error} / ${n2.error} / ${fp.collected}`);
  const bad1 = await safe(() => split.recordProjectRevenue(pr.projectId, 100, 'x', { idempotencyKey: 'x'.repeat(201) }));
  expect(!!bad1.err && bad1.err.statusCode === 400, 'over-long key rejected with 400', bad1.error);
}

// ---- HTTP harness: the REAL admin router behind the REAL i18n + errorHandler
let app;
function httpApp() {
  if (app) return app;
  const express = require('express');
  const { i18n } = require('../src/i18n/middleware');
  const adminRoutes = require('../src/routes/adminRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use(i18n);
  app.use('/api/v1/admin', adminRoutes);
  app.use(errorHandler);
  return app;
}
async function tokenFor(id) {
  const u = (await pool.query('SELECT id, role, phone_number, auth_version FROM users WHERE id = $1', [id])).rows[0];
  return require('../src/middleware/auth').signToken(u);
}
const show = (res) => `${res.status} ${JSON.stringify(res.body)}`;

async function testHttpAudit() {
  section('7. C4B-4 / C4B-7 over HTTP: Idempotency-Key honoured; audit row with the admin actor');
  const request = require('supertest');
  const invA = await makeUser('invA');
  const pr = await makeProject([[invA, 10]]);
  const admin = await makeUser('admin', 'ADMIN');
  const user = await makeUser('user');
  const key = `http-${tag}`;
  const post = async (uid, url, body, k) => quiet(async () => {
    let rq = request(httpApp()).post(url).set('Authorization', `Bearer ${await tokenFor(uid)}`);
    if (k) rq = rq.set('Idempotency-Key', k);
    return rq.send(body);
  });
  const denied = await post(user, `/api/v1/admin/projects/${pr.projectId}/revenue`, { amount: 1000 }, key);
  let fp = await splitFootprint(pr.projectId);
  expect(denied.status === 403 && fp.collected === 0, 'non-admin: 403, nothing recorded', `${show(denied)} / ${fp.collected}`);
  const a = await post(admin, `/api/v1/admin/projects/${pr.projectId}/revenue`, { amount: 1000, description: 'http' }, key);
  const b = await post(admin, `/api/v1/admin/projects/${pr.projectId}/revenue`, { amount: 1000, description: 'http' }, key);
  fp = await splitFootprint(pr.projectId);
  progress(`a ${a.status}; b ${show(b)}; collected ${fp.collected}`);
  expect(a.status === 200 && b.status === 200 && b.body.replay === true && fp.collected === 1000, 'same Idempotency-Key twice: 200/200, recorded once (1000)', `${show(b)} / ${fp.collected}`);
  const rev = await auditRows('P2P_PROJECT_REVENUE_RECORDED', pr.projectId);
  expect(rev.length === 1 && rev[0].user_id === admin && rev[0].entity_type === 'P2P_PROJECT' && Number(rev[0].meta.amount) === 1000 && !!rev[0].meta.referenceId,
    'revenue: one audit row (admin actor, amount, reference)', JSON.stringify(rev));
  const s = await post(admin, `/api/v1/admin/projects/${pr.projectId}/split`, {});
  const srows = await auditRows('P2P_PROJECT_SPLIT_RUN', pr.projectId);
  progress(`split ${show(s)}; audit ${JSON.stringify(srows)}`);
  expect(s.status === 200 && s.body.success === true, 'manual split: 200 success', show(s));
  expect(srows.length === 1 && srows[0].user_id === admin && srows[0].meta.details.trigger === 'MANUAL'
    && Number(srows[0].meta.details.totalRevenue) === 1000 && srows[0].meta.details.investorsPaid === 1,
  'split: one audit row (admin actor, trigger MANUAL, totals)', JSON.stringify(srows));
}

async function testZeroAndNegativeLegs() {
  section('8. C4B-11: zero legs skipped; negative leg rejected with nothing mutated');
  const invA = await makeUser('invA');
  const pr = await makeProject([[invA, 10]]);
  await split.recordProjectRevenue(pr.projectId, 0.01, 'tiny');
  const before = await balances([pr.owner, invA]);
  const r = await safe(() => split.runSplitPayment(pr.projectId, 3, 2031));
  const after = await balances([pr.owner, invA]);
  const fp = await splitFootprint(pr.projectId);
  progress(`tiny: ${r.error || JSON.stringify(r.value)}; footprint ${JSON.stringify(fp)}`);
  expect(!r.error && r.value.success === true, 'revenue 0.01: split succeeds (no invalid-journal failure)', r.error);
  expect(money(after[pr.owner] - before[pr.owner]) === 0.01 && after[invA] === before[invA], 'owner +0.01; investor share 0 not credited', JSON.stringify({ before, after }));
  expect(fp.runs === 1 && fp.payouts === 0 && fp.collected === 0, 'one run, no payout row, revenue reset', JSON.stringify(fp));
  const pf = (await pool.query(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id = $1`, [`SPLIT:${pr.projectId}:2031-3:PF`])).rows[0].c;
  expect(pf === 0, 'no zero-amount platform journal', pf);

  const pr2 = await makeProject([[invA, 10]]);
  await pool.query('UPDATE project_settlement_rules SET reinvestment_percentage = 80, investor_payout_percentage = 30 WHERE project_id = $1', [pr2.projectId]);
  await split.recordProjectRevenue(pr2.projectId, 1000, 'over100');
  const b2 = await balances([pr2.owner, invA]);
  const r2 = await safe(() => split.runSplitPayment(pr2.projectId, 3, 2031));
  const a2 = await balances([pr2.owner, invA]);
  const fp2 = await splitFootprint(pr2.projectId);
  progress(`rules 80/30/2: ${r2.error || JSON.stringify(r2.value)}; footprint ${JSON.stringify(fp2)}`);
  expect(!!r2.error, 'rules summing over 100 %: split rejected', JSON.stringify(r2.value));
  expect(JSON.stringify(b2) === JSON.stringify(a2) && fp2.runs === 0 && fp2.splitJournal === 0 && fp2.collected === 1000,
    'nothing mutated', JSON.stringify({ b2, a2, fp2 }));
}

async function testCronAudit() {
  section('9. C4B-7 cron trigger: audit row with NULL actor and trigger CRON');
  const invA = await makeUser('invA');
  const pr = await makeProject([[invA, 10]]);
  await split.recordProjectRevenue(pr.projectId, 1000, 'cron');
  const res = await quiet(() => split.runDueSplitPayments());
  const rows = await auditRows('P2P_PROJECT_SPLIT_RUN', pr.projectId);
  progress(`processed includes project: ${res.processed.includes(pr.projectId)}; audit ${JSON.stringify(rows)}`);
  expect(res.processed.includes(pr.projectId), 'cron run processed the project');
  expect(rows.length === 1 && rows[0].user_id === null && rows[0].meta.details.trigger === 'CRON', 'one audit row, actor NULL, trigger CRON', JSON.stringify(rows));
}

async function testInvariants() {
  section('10. Ledger invariants after all sections');
  const inv = (await pool.query('SELECT check_name, ok FROM fn_financial_invariants()')).rows;
  progress(JSON.stringify(inv));
  expect(inv.length > 0 && inv.every((x) => x.ok), 'fn_financial_invariants: every check ok', JSON.stringify(inv));
}

function testStatic() {
  section('11. Static: aggregation, fail-closed dedup, actor + key wiring');
  const src = fs.readFileSync(SPLIT_FILE, 'utf8');
  expect(/GROUP BY i\.investor_user_id/.test(src), 'service: investors aggregated per investor_user_id');
  expect(/if \(res\.dedup\)/.test(src), 'service: dedup on an investor credit fails closed');
  const routes = fs.readFileSync(ROUTES_FILE, 'utf8');
  expect(/recordProjectRevenue\([\s\S]{0,200}actorUserId: req\.user\.id, idempotencyKey: req\.get\('Idempotency-Key'\)/.test(routes),
    'route: revenue passes the authenticated actor and the Idempotency-Key header');
  expect(/runSplitPayment\([\s\S]{0,200}actorUserId: req\.user\.id, trigger: 'MANUAL'/.test(routes), 'route: manual split passes the actor and trigger MANUAL');
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port`);
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);
    const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean).map(Number);
    const all = [testEqualRows, testUnequalRows, testDedupFailsClosed, testLateFailureRollsBack, testConcurrentSplit,
      testRevenueIdempotency, testHttpAudit, testZeroAndNegativeLegs, testCronAudit, testInvariants, testStatic];
    for (const [i, t] of all.entries()) {
      if (only.length && !only.includes(i + 1)) continue;
      const res = await safe(t);
      if (res.error) bad(`${t.name} aborted`, res.error);
    }
    expect(httpCalls.length === 0, 'no real provider HTTP call', httpCalls.length);
  } catch (e) {
    bad('unexpected error', e && e.stack || e);
  } finally {
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})();
