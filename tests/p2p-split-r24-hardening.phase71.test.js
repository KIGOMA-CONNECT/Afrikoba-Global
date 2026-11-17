#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R24: P2P revenue + split technical hardening
 *   src/services/splitPaymentService.js, src/routes/adminRoutes.js
 *
 *  R24-01  keyed revenue reference must fit journal_entries.reference_id
 *          (VARCHAR(50)) for every project id (R22 used 40 hex -> 51+ chars
 *          once the project id has 4+ digits).
 *  R24-02  revenue amount must be representable by the wallet column
 *          (NUMERIC(15,2)); sub-cent / oversized amounts are rejected with 400
 *          and nothing is mutated (ledger NUMERIC(19,4) would otherwise keep
 *          a different amount than project_business_wallets).
 *  R24-03  error semantics: unknown project 404, nothing to split 409,
 *          malformed :projectId 400 (was 500 / NaN / parseInt prefix).
 *  R24-04  owner (OP) credit dedup fails closed (no run recorded while the
 *          owner was not credited by this run).
 *  R24-05  INVESTMENT_PAYOUT rows carry meta.split_reference.
 *  R24-06  revenue without Idempotency-Key is logged (observability only).
 *  R24-07  read-only split integrity checker (payout invariants), detects
 *          planted anomalies, writes nothing.
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix>.
 * axios is stubbed: no real network.
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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

setTimeout(() => {
  console.log('\nWATCHDOG: test process exceeded 150 s; exiting with failure.');
  process.exit(1);
}, 150000).unref();

require('axios');
const axiosPath = require.resolve('axios');
const httpCalls = [];
require.cache[axiosPath].exports = {
  post: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.post not expected'); },
  get: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.get not expected'); },
};

const pool = require('../src/config/db');
const split = require('../src/services/splitPaymentService');
const logger = require('../src/utils/logger');

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
const quiet = async (fn) => {
  const real = { error: logger.error, warn: logger.warn };
  logger.error = () => {};
  logger.warn = () => {};
  try { return await fn(); } finally { logger.error = real.error; logger.warn = real.warn; }
};

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label, role) {
  seq += 1;
  const phone = `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71R24 ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  return id;
}
async function makeProject(investments, { minId = null, wallet = true } = {}) {
  const owner = await makeUser('owner');
  if (minId) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('investment_projects','id'),
                     GREATEST($1::bigint, (SELECT COALESCE(MAX(id),1) FROM investment_projects)))`, [minId]);
  }
  const p = (await pool.query(
    `INSERT INTO investment_projects
       (owner_user_id, title, sector, description, target_amount, raised_amount, share_price,
        roi_percentage, tenure_months, payback_start_months, status)
     VALUES ($1, $2, 'SMES', 'R24 test', 100000, 100000, 1000, 10, 12, 1, 'FUNDED') RETURNING id`,
    [owner, `P71R24 ${tag} ${++seq}`])).rows[0].id;
  if (wallet) await pool.query('INSERT INTO project_business_wallets (project_id) VALUES ($1)', [p]);
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
async function footprint(projectId) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows[0];
  return {
    runs: (await q('SELECT COUNT(*)::int AS c FROM revenue_split_runs WHERE project_id = $1', [projectId])).c,
    payouts: (await q(`SELECT COUNT(*)::int AS c FROM transactions WHERE type = 'INVESTMENT_PAYOUT' AND meta->>'project_id' = $1`, [String(projectId)])).c,
    splitJournal: (await q(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id LIKE $1`, [`SPLIT:${projectId}:%`])).c,
    revJournal: (await q(`SELECT COUNT(*)::int AS c, COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric AS dr
                            FROM journal_entries WHERE reference_id LIKE $1`, [`REV:${projectId}:%`])),
    collected: Number((await q('SELECT total_revenue_collected AS v FROM project_business_wallets WHERE project_id = $1', [projectId]) || {}).v),
    audits: (await q(`SELECT COUNT(*)::int AS c FROM audit_logs WHERE entity_type = 'P2P_PROJECT' AND entity_id = $1`, [projectId])).c,
    outbox: (await q(`SELECT COUNT(*)::int AS c FROM outbox_events WHERE reference_id LIKE $1`, [`PROJECT_SPLIT_SMS:${projectId}:%`])).c,
  };
}
const fpEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function tableCounts() {
  const r = await pool.query(`SELECT
     (SELECT COUNT(*) FROM transactions)::int AS t, (SELECT COUNT(*) FROM journal_entries)::int AS j,
     (SELECT COUNT(*) FROM financial_operations)::int AS f, (SELECT COUNT(*) FROM audit_logs)::int AS a,
     (SELECT COUNT(*) FROM reconciliation_exceptions)::int AS x, (SELECT COUNT(*) FROM revenue_split_runs)::int AS r`);
  return r.rows[0];
}

// ---- HTTP harness: REAL admin router + i18n + errorHandler ------------------
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
async function post(uid, url, body, key) {
  const request = require('supertest');
  return quiet(async () => {
    let rq = request(httpApp()).post(url).set('Authorization', `Bearer ${await tokenFor(uid)}`);
    if (key) rq = rq.set('Idempotency-Key', key);
    return rq.send(body || {});
  });
}

// ---------------------------------------------------------------------------
async function testKeyedReferenceLength() {
  section('1. R24-01: keyed revenue for a project id with 6 digits fits journal reference_id (VARCHAR(50))');
  const pr = await makeProject([], { minId: 123456 });
  progress(`projectId ${pr.projectId} (${String(pr.projectId).length} digits)`);
  const key = `len-${tag}`;
  const a = await quiet(() => safe(() => split.recordProjectRevenue(pr.projectId, 500, 'r24 len', { idempotencyKey: key })));
  const b = await quiet(() => safe(() => split.recordProjectRevenue(pr.projectId, 500, 'r24 len', { idempotencyKey: key })));
  let fp = await footprint(pr.projectId);
  progress(`a ${a.error || 'ok'}; b ${b.error || JSON.stringify({ replay: b.value.replay, reference: b.value.reference })}; fp ${JSON.stringify(fp)}`);
  expect(!a.error, 'first keyed declaration succeeds', a.error);
  expect(!b.error && b.value.replay === true, 'replay of the same key returns replay=true', b.error);
  expect(fp.collected === 500 && fp.revJournal.c === 2, 'recorded exactly once (500, one DR/CR pair)', JSON.stringify(fp));
  const ref = !b.error ? b.value.reference : '';
  expect(/^REV:\d+:K:[0-9a-f]{32}$/.test(ref) && ref.length <= 50, 'reference = REV:<id>:K:<32 hex>, length <= 50', `${ref} (${ref.length})`);
  const maxRefLen = `REV:${2147483647}:K:${'f'.repeat(32)}`.length;
  expect(maxRefLen <= 50, `largest possible keyed reference (int4 max id) is ${maxRefLen} chars <= 50`);

  const k2 = `len-conc-${tag}`;
  const pr2 = await makeProject([], { minId: 7654321 });
  const res = await quiet(() => Promise.all(Array.from({ length: 5 }, () => safe(() => split.recordProjectRevenue(pr2.projectId, 300, 'conc', { idempotencyKey: k2 })))));
  fp = await footprint(pr2.projectId);
  const errs = res.filter((r) => r.error).map((r) => r.error);
  const replays = res.filter((r) => !r.error && r.value.replay).length;
  progress(`7-digit id ${pr2.projectId}: errors ${JSON.stringify(errs)}; replays ${replays}; collected ${fp.collected}`);
  expect(errs.length === 0 && replays === 4 && fp.collected === 300 && fp.revJournal.c === 2, '5 concurrent calls, 7-digit id: 1 recorded + 4 replays', JSON.stringify(fp));
}

async function testAmountPrecision() {
  section('2. R24-02: revenue amounts must be representable by NUMERIC(15,2)');
  const pr = await makeProject([]);
  const before = await footprint(pr.projectId);
  for (const amt of [10.005, 0.001, '7.129', 1e13, 99999999999999]) {
    const r = await quiet(() => safe(() => split.recordProjectRevenue(pr.projectId, amt, 'prec')));
    const fp = await footprint(pr.projectId);
    progress(`amount ${amt}: ${r.error ? `${r.err.statusCode} ${r.error}` : 'ACCEPTED'}; collected ${fp.collected}; REV DR ${fp.revJournal.dr}`);
    expect(!!r.err && r.err.statusCode === 400 && fpEq(fp, before), `amount ${amt} rejected with 400, nothing mutated`, r.error || `ACCEPTED: wallet ${fp.collected} vs journal ${fp.revJournal.dr}`);
  }
  for (const amt of [10.5, '10.25', 1]) {
    const r = await quiet(() => safe(() => split.recordProjectRevenue(pr.projectId, amt, 'prec ok')));
    expect(!r.error, `amount ${amt} accepted`, r.error);
  }
  const fp = await footprint(pr.projectId);
  expect(money(fp.collected) === money(Number(fp.revJournal.dr)), 'wallet total_revenue_collected == Σ REV journal DR', `${fp.collected} vs ${fp.revJournal.dr}`);
  const pmax = await makeProject([]);
  const rmax = await quiet(() => safe(() => split.recordProjectRevenue(pmax.projectId, 9999999999999.99, 'max')));
  expect(!rmax.error, 'amount 9999999999999.99 (column max) accepted on an empty wallet', rmax.error);
  const before2 = await footprint(pmax.projectId);
  const rover = await quiet(() => safe(() => split.recordProjectRevenue(pmax.projectId, 1, 'overflow')));
  const after2 = await footprint(pmax.projectId);
  expect(!!rover.err && rover.err.statusCode === 422 && rover.err.code === 'REVENUE_TOTAL_OVERFLOW' && fpEq(before2, after2),
    'accumulated total beyond NUMERIC(15,2): 422 REVENUE_TOTAL_OVERFLOW, nothing mutated', `${rover.err && rover.err.statusCode} ${rover.error}`);

  const admin = await makeUser('admin', 'ADMIN');
  const pr2 = await makeProject([]);
  const h = await post(admin, `/api/v1/admin/projects/${pr2.projectId}/revenue`, { amount: '10.005' });
  const fp2 = await footprint(pr2.projectId);
  expect(h.status === 400 && fp2.collected === 0, 'HTTP amount "10.005": 400, nothing recorded', `${show(h)} / ${fp2.collected}`);
}

async function testErrorSemantics() {
  section('3. R24-03: error semantics (404 / 409 / 400 instead of 500)');
  const admin = await makeUser('admin', 'ADMIN');
  const missing = 2000000000;
  const s1 = await quiet(() => safe(() => split.runSplitPayment(missing, 1, 2031)));
  expect(s1.err && s1.err.statusCode === 404 && s1.err.code === 'PROJECT_NOT_FOUND', 'service: split of unknown project -> 404 PROJECT_NOT_FOUND', `${s1.err && s1.err.statusCode} ${s1.error}`);
  const pr = await makeProject([]);
  const s2 = await quiet(() => safe(() => split.runSplitPayment(pr.projectId, 1, 2031)));
  expect(s2.err && s2.err.statusCode === 409 && s2.err.code === 'NO_REVENUE_TO_SPLIT', 'service: split with nothing collected -> 409 NO_REVENUE_TO_SPLIT', `${s2.err && s2.err.statusCode} ${s2.error}`);
  const prNoWallet = await makeProject([], { wallet: false });
  const s3 = await quiet(() => safe(() => split.recordProjectRevenue(prNoWallet.projectId, 100, 'x')));
  expect(s3.err && s3.err.statusCode === 404, 'service: revenue for project without business wallet -> 404', `${s3.err && s3.err.statusCode} ${s3.error}`);

  const cases = [
    ['split', 'abc', 400], ['split', '12abc', 400], ['split', '0', 400], ['split', '99999999999', 400],
    ['revenue', 'abc', 400], ['revenue', '12abc', 400], ['revenue', '-5', 400],
    ['split', String(missing), 404], ['split', String(pr.projectId), 409],
  ];
  for (const [kind, id, want] of cases) {
    const before = await tableCounts();
    const r = await post(admin, `/api/v1/admin/projects/${id}/${kind}`, kind === 'revenue' ? { amount: 100 } : {});
    const after = await tableCounts();
    expect(r.status === want && fpEq(before, after), `HTTP ${kind} /projects/${id}: ${want}, nothing written`, `${show(r)}`);
  }
}

async function testOwnerDedupFailsClosed() {
  section('4. R24-04: owner (OP) credit dedup fails closed');
  const invA = await makeUser('invA');
  const pr = await makeProject([[invA, 10]]);
  await quiet(() => split.recordProjectRevenue(pr.projectId, 1000, 'op dedup'));
  // A pre-existing operation with the same reference and shape (as left by a
  // deleted run row or a reference collision) makes creditWallet dedup.
  await pool.query(
    `INSERT INTO financial_operations (operation_type, reference_id, user_id, amount, status, attempts)
     VALUES ('CREDIT', $1, $2, 700, 'SUCCESS', 1)`, [`SPLIT:${pr.projectId}:2031-2:OP`, pr.owner]);
  const before = await footprint(pr.projectId);
  const bal0 = await balances([pr.owner, invA]);
  const r = await quiet(() => safe(() => split.runSplitPayment(pr.projectId, 2, 2031)));
  const after = await footprint(pr.projectId);
  const bal1 = await balances([pr.owner, invA]);
  progress(`result ${r.error || JSON.stringify(r.value)}; before ${JSON.stringify(before)}; after ${JSON.stringify(after)}`);
  expect(r.err && r.err.statusCode === 409 && r.err.code === 'SPLIT_OWNER_ALREADY_CREDITED', 'split rejected 409 SPLIT_OWNER_ALREADY_CREDITED', r.error || JSON.stringify(r.value));
  expect(fpEq(before, after) && fpEq(bal0, bal1), 'nothing mutated (run, payouts, journal, wallets, outbox, audit, collected)', `${JSON.stringify(after)} / ${JSON.stringify(bal1)}`);
}

async function testSplitReferenceMeta() {
  section('5. R24-05: INVESTMENT_PAYOUT rows carry meta.split_reference');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const pr = await makeProject([[invA, 10], [invB, 30]]);
  await quiet(() => split.recordProjectRevenue(pr.projectId, 1000, 'meta'));
  const r = await quiet(() => safe(() => split.runSplitPayment(pr.projectId, 3, 2031)));
  expect(!r.error, 'split succeeds', r.error);
  const rows = (await pool.query(
    `SELECT user_id, meta FROM transactions WHERE type = 'INVESTMENT_PAYOUT' AND meta->>'project_id' = $1 ORDER BY user_id`,
    [String(pr.projectId)])).rows;
  const good = rows.length === 2 && rows.every((x) => x.meta.split_reference === `SPLIT:${pr.projectId}:2031-3:INV:${x.user_id}`
    && String(x.meta.project_id) === String(pr.projectId) && x.meta.period === '2031-3');
  expect(good, 'each payout row: split_reference = SPLIT:<p>:<y>-<m>:INV:<uid>; project_id/period kept', JSON.stringify(rows.map((x) => x.meta)));
}

async function testMissingKeyLogged() {
  section('6. R24-06: revenue without Idempotency-Key is logged (no behaviour change)');
  const pr = await makeProject([]);
  const seen = [];
  const real = logger.warn;
  logger.warn = (...args) => { seen.push(args); };
  try {
    await split.recordProjectRevenue(pr.projectId, 100, 'nokey', { actorUserId: null });
    await split.recordProjectRevenue(pr.projectId, 100, 'key', { idempotencyKey: `k-${tag}` });
  } finally { logger.warn = real; }
  const hits = seen.filter((a) => a[0] === 'REVENUE_NO_IDEMPOTENCY_KEY');
  const fp = await footprint(pr.projectId);
  progress(`warn calls ${JSON.stringify(seen)}`);
  expect(hits.length === 1 && hits[0][2] && hits[0][2].projectId === pr.projectId, 'exactly one REVENUE_NO_IDEMPOTENCY_KEY warning (with projectId) for the keyless call', JSON.stringify(seen));
  expect(fp.collected === 200, 'both declarations recorded (no behaviour change)', fp.collected);
}

async function testIntegrityChecker() {
  section('7. R24-07: read-only split integrity checker');
  expect(typeof split.verifySplitIntegrity === 'function', 'verifySplitIntegrity exported');
  if (typeof split.verifySplitIntegrity !== 'function') return;
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const pr = await makeProject([[invA, 10], [invB, 30]]);
  await quiet(() => split.recordProjectRevenue(pr.projectId, 1000, 'chk'));
  await quiet(() => split.runSplitPayment(pr.projectId, 4, 2031));
  const c0 = await tableCounts();
  const clean = await split.verifySplitIntegrity({ projectId: pr.projectId, periodMonth: 4, periodYear: 2031 });
  const c1 = await tableCounts();
  progress(`clean: ${JSON.stringify(clean)}`);
  expect(clean.ok === true && clean.anomalies.length === 0 && clean.runs === 1, 'clean split: ok, 0 anomalies');
  expect(fpEq(c0, c1), 'checker wrote nothing');
  const kinds = async () => (await split.verifySplitIntegrity({ projectId: pr.projectId })).anomalies.map((a) => a.type).sort();

  // a) duplicate payout row for investor A (legacy B6-2 shape: two SUCCESS rows, one credit)
  const dup = (await pool.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, 250, 0, 250, 'SUCCESS', 'INVESTMENT_PAYOUT', $3) RETURNING id`,
    [`R24DUP${tag}`, invA, JSON.stringify({ project_id: pr.projectId, period: '2031-4' })])).rows[0].id;
  let k = await kinds();
  expect(k.includes('PAYOUT_ROW_DUPLICATE'), 'detects duplicate payout rows for one credit (B6-2 legacy shape)', JSON.stringify(k));
  await pool.query('DELETE FROM transactions WHERE id = $1', [dup]);

  // b) payout row for a user who was not credited
  const stranger = await makeUser('stranger');
  const orphan = (await pool.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, 10, 0, 10, 'SUCCESS', 'INVESTMENT_PAYOUT', $3) RETURNING id`,
    [`R24ORP${tag}`, stranger, JSON.stringify({ project_id: pr.projectId, period: '2031-4' })])).rows[0].id;
  k = await kinds();
  expect(k.includes('PAYOUT_ROW_WITHOUT_CREDIT'), 'detects a SUCCESS payout row without a credit', JSON.stringify(k));
  await pool.query('DELETE FROM transactions WHERE id = $1', [orphan]);

  // c) payout row amount differs from the credit
  await pool.query(`UPDATE transactions SET wallet_amount = wallet_amount + 1 WHERE type = 'INVESTMENT_PAYOUT' AND user_id = $1 AND meta->>'project_id' = $2`, [invB, String(pr.projectId)]);
  k = await kinds();
  expect(k.includes('PAYOUT_AMOUNT_MISMATCH'), 'detects payout row amount != credit amount', JSON.stringify(k));
  await pool.query(`UPDATE transactions SET wallet_amount = wallet_amount - 1 WHERE type = 'INVESTMENT_PAYOUT' AND user_id = $1 AND meta->>'project_id' = $2`, [invB, String(pr.projectId)]);

  // d) credit without payout row
  const saved = (await pool.query(`DELETE FROM transactions WHERE type = 'INVESTMENT_PAYOUT' AND user_id = $1 AND meta->>'project_id' = $2 RETURNING *`, [invA, String(pr.projectId)])).rows[0];
  k = await kinds();
  expect(k.includes('PAYOUT_ROW_MISSING'), 'detects an investor credit without a payout row', JSON.stringify(k));
  await pool.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'INVESTMENT_PAYOUT', $4)`, [saved.reference_id, saved.user_id, saved.wallet_amount, saved.meta]);

  // e) run row legs disagree with the posted legs
  await pool.query('UPDATE revenue_split_runs SET operational_share = operational_share + 5 WHERE project_id = $1', [pr.projectId]);
  k = await kinds();
  expect(k.includes('RUN_LEG_MISMATCH'), 'detects run row leg != posted credit/journal leg', JSON.stringify(k));
  await pool.query('UPDATE revenue_split_runs SET operational_share = operational_share - 5 WHERE project_id = $1', [pr.projectId]);
  const back = await split.verifySplitIntegrity({ projectId: pr.projectId });
  expect(back.ok === true, 'after restoring the planted data: ok again', JSON.stringify(back.anomalies));

  // f) investor share not allocated (zero ACTIVE investors) is reported, not classified
  const pz = await makeProject([]);
  await quiet(() => split.recordProjectRevenue(pz.projectId, 1000, 'zero inv'));
  await quiet(() => split.runSplitPayment(pz.projectId, 4, 2031));
  const z = await split.verifySplitIntegrity({ projectId: pz.projectId });
  const un = z.anomalies.find((a) => a.type === 'INVESTOR_SHARE_UNALLOCATED');
  progress(`zero investors: ${JSON.stringify(z.anomalies)}`);
  expect(!!un && money(un.amount) === 280 && !('classification' in un), 'zero ACTIVE investors: INVESTOR_SHARE_UNALLOCATED 280 reported (no classification)', JSON.stringify(z.anomalies));
  // rounding within tolerance is not an anomaly: 3 equal investors, 100 revenue -> 28 / 3
  const i1 = await makeUser('r1'); const i2 = await makeUser('r2'); const i3 = await makeUser('r3');
  const prr = await makeProject([[i1, 1], [i2, 1], [i3, 1]]);
  await quiet(() => split.recordProjectRevenue(prr.projectId, 100, 'rounding'));
  await quiet(() => split.runSplitPayment(prr.projectId, 4, 2031));
  const rr = await split.verifySplitIntegrity({ projectId: prr.projectId });
  progress(`rounding: ${JSON.stringify(rr)}`);
  expect(rr.ok === true, 'rounding residual within 0.005 x investors is not an anomaly', JSON.stringify(rr.anomalies));
}

async function testConfigSetting() {
  section('9. R24-09: PUT /admin/config/:key (four-eyes thresholds): validation + atomic audit with old/new value');
  const admin = await makeUser('admin', 'ADMIN');
  const request = require('supertest');
  const put = async (key, body) => quiet(async () => request(httpApp()).put(`/api/v1/admin/config/${encodeURIComponent(key)}`)
    .set('Authorization', `Bearer ${await tokenFor(admin)}`).send(body));
  const val = async (key) => {
    const r = await pool.query('SELECT value FROM config_settings WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  };
  const K = 'HIGH_VALUE_TRANSFER_THRESHOLD';
  const start = await val(K);
  const audits = async () => (await pool.query(
    `SELECT user_id, meta FROM audit_logs WHERE action = 'CONFIG_SET' AND meta->>'key' = $1 ORDER BY id`, [K])).rows;
  const a0 = (await audits()).length;
  for (const body of [{}, { value: null }, { value: 'abc' }, { value: '0' }, { value: '-5' }, { value: '1e20' }, { value: '12abc' }]) {
    const r = await put(K, body);
    expect(r.status === 400 && (await val(K)) === start && (await audits()).length === a0,
      `threshold ${JSON.stringify(body)}: 400, value unchanged, no audit`, `${show(r)} / stored ${await val(K)}`);
  }
  const okRes = await put(K, { value: '7500000' });
  const rows = await audits();
  const last = rows[rows.length - 1];
  progress(`ok ${show(okRes)}; audit ${JSON.stringify(last)}`);
  expect(okRes.status === 200 && (await val(K)) === '7500000', 'valid threshold 7500000 stored');
  expect(rows.length === a0 + 1 && last.user_id === admin && last.meta.oldValue === start && last.meta.newValue === '7500000',
    'one CONFIG_SET audit row with actor, oldValue and newValue', JSON.stringify(last));
  const badKey = await put('bad key!', { value: '1' });
  expect(badKey.status === 400, 'malformed key rejected with 400', show(badKey));
  const other = await put(`R24_FLAG_${tag.toUpperCase()}`, { value: 'on' });
  expect(other.status === 200, 'non-threshold key with a string value still accepted (unchanged behaviour)', show(other));
}

function testStatic() {
  section('8. Static: wiring');
  const src = fs.readFileSync(SPLIT_FILE, 'utf8');
  const routes = fs.readFileSync(ROUTES_FILE, 'utf8');
  expect(/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/.test(src), 'checker runs in a READ ONLY snapshot transaction');
  expect(!/verifySplitIntegrity/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'jobs', 'runAll.js'), 'utf8')), 'checker is NOT scheduled (owner decision)');
  expect(/parseProjectId\(req\.params\.projectId\)[\s\S]{0,400}recordProjectRevenue/.test(routes), 'revenue route validates :projectId');
  expect(/parseProjectId\(req\.params\.projectId\)[\s\S]{0,400}runSplitPayment/.test(routes), 'split route validates :projectId');
  expect(/GROUP BY i\.investor_user_id/.test(src) && /if \(res\.dedup\)/.test(src), 'R22 I-1 aggregation and investor dedup guard unchanged (blocked: OD-4 / Q-I1a)');
  expect(/router\.put\('\/config\/:key'[\s\S]{0,1500}writeAudit\(\{\s*client/.test(routes), 'config route writes its audit row with the transaction client');
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port`);
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);
    const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean).map(Number);
    const all = [testKeyedReferenceLength, testAmountPrecision, testErrorSemantics, testOwnerDedupFailsClosed,
      testSplitReferenceMeta, testMissingKeyLogged, testIntegrityChecker, testStatic, testConfigSetting];
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
