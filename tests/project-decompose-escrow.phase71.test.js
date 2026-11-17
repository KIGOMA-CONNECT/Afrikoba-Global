#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Remediation OBS-6 (+ OBS-1a guard): decompose and escrow
 *   POST /social/projects/:id/decompose  (src/routes/socialFundRoutes.js)
 *   decomposeProject                     (src/services/projectIntelligenceService.js)
 *   controlled escrow projection         (projectService.invest -> projectFinance.onFundingReceived)
 *
 * decomposeProject used to (a) run for ANY authenticated user on ANY project id,
 * existing or not, and (b) INSERT controlled_project_accounts with
 * escrow_balance = the caller's total_budget. Escrow must come only from verified
 * funding (investments debited from wallets), never from a request amount.
 * Who may decompose follows the owner-approved E0d rule for project-finance
 * writes: the project owner or ADMIN / MODERATOR / EXPERT.
 *
 *  1. HTTP stranger -> 403; no decomposition row, no escrow row.
 *  2. Non-existent project -> 404; no rows.
 *  3. Owner decomposes an unfunded project with total_budget 999999 -> 200 with the
 *     4-phase template, and NO escrow row is created.
 *  4. Expert (ADMIN, not owner) -> 200. Invalid budgets (0, -5, 'abc', missing) -> 400.
 *  5. Verified funding: two investments -> escrow remaining = escrow_balance =
 *     amount_raised = sum CONFIRMED = PROJECT ledger credits; decompose by the owner
 *     afterwards leaves escrow unchanged.
 *  6. Duplicate funding: same unique_reference twice -> one debit; repeated
 *     onFundingReceived -> escrow unchanged.
 *  7. Concurrent investments by two investors -> amount_raised and escrow = sum.
 *  8. Failed investment (insufficient wallet) -> rollback: no investment,
 *     transaction or journal; escrow and amount_raised unchanged.
 *  9. Static: guard precedes BEGIN; decompose no longer writes
 *     controlled_project_accounts; the route passes req.user.id and req.user.role.
 *
 * axios is stubbed: no network. Requires a DISPOSABLE database named
 * phase71_financial_audit_<suffix>.
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
  console.log('\nWATCHDOG: test process exceeded 90 s; exiting with failure.');
  process.exit(1);
}, 90000).unref();

require('axios');
const axiosPath = require.resolve('axios');
const httpCalls = [];
require.cache[axiosPath].exports = {
  post: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.post not expected'); },
  get: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.get not expected'); },
};
const smsService = require('../src/services/smsService');
smsService.sendSMS = async () => ({ success: true, simulated: true });

const pool = require('../src/config/db');
const intel = require('../src/services/projectIntelligenceService');
const projectService = require('../src/services/projectService');
const projectFinance = require('../src/services/projectFinanceService');

const SERVICE_FILE = path.join(__dirname, '..', 'src', 'services', 'projectIntelligenceService.js');
const ROUTES_FILE = path.join(__dirname, '..', 'src', 'routes', 'socialFundRoutes.js');
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
const show = (o) => JSON.stringify(o);
const FORBIDDEN = 'Huna ruhusa za mradi huu.';

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label, role, wallet = 0) {
  seq += 1;
  const phone = `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71DEC ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  if (wallet) await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [wallet, id]);
  return id;
}
async function makeProject(status = 'FUNDING', capital = 10000) {
  const owner = await makeUser('owner');
  const id = (await pool.query(
    `INSERT INTO projects (owner_user_id, name, status, capital_required, amount_raised)
     VALUES ($1, $2, $3, $4, 0) RETURNING id`,
    [owner, `P71DEC project ${tag} ${++seq}`, status, capital])).rows[0].id;
  return { projectId: id, owner };
}
async function rows(projectId) {
  const q = async (sql) => (await pool.query(sql, [projectId])).rows;
  const esc = await q('SELECT escrow_balance, remaining_balance, status FROM controlled_project_accounts WHERE project_id = $1');
  return {
    decomp: (await q('SELECT COUNT(*)::int AS c FROM project_decompositions WHERE project_id = $1'))[0].c,
    escrow: esc.length ? { escrow: Number(esc[0].escrow_balance), remaining: Number(esc[0].remaining_balance), status: esc[0].status } : null,
  };
}
async function funding(projectId) {
  const one = async (sql) => (await pool.query(sql, [projectId])).rows[0];
  const p = await one('SELECT amount_raised FROM projects WHERE id = $1');
  const inv = await one(`SELECT COALESCE(SUM(amount),0)::numeric AS s, COUNT(*)::int AS c FROM project_investments WHERE project_id = $1 AND status = 'CONFIRMED'`);
  const led = await one(
    `SELECT COALESCE(SUM(je.amount),0)::numeric AS s FROM journal_entries je
       JOIN ledger_accounts la ON la.id = je.account_id
      WHERE la.account_code = 'PROJECT_INVESTMENT_ACCOUNT' AND je.direction = 'CR'
        AND je.reference_id IN (SELECT unique_reference FROM project_investments WHERE project_id = $1)`);
  const txns = await one(`SELECT COUNT(*)::int AS c FROM transactions WHERE type = 'PROJECT_INVEST' AND (meta->>'project_id')::int = $1`);
  const esc = (await rows(projectId)).escrow;
  return { raised: Number(p.amount_raised), confirmed: Number(inv.s), invCount: inv.c, ledger: Number(led.s), txns: txns.c, escrow: esc };
}
const escrowMatches = (f, n) => f.escrow && f.escrow.remaining === n && f.escrow.escrow === n;

// ---- HTTP harness: the REAL route behind the REAL i18n + errorHandler --------
let app;
function httpApp() {
  if (app) return app;
  const express = require('express');
  const { i18n } = require('../src/i18n/middleware');
  const socialRoutes = require('../src/routes/socialFundRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use(i18n);
  app.use('/api/v1/social', socialRoutes);
  app.use(errorHandler);
  return app;
}
async function tokenFor(id) {
  const u = (await pool.query('SELECT id, role, phone_number, auth_version FROM users WHERE id = $1', [id])).rows[0];
  return require('../src/middleware/auth').signToken(u);
}
async function postDecompose(userId, projectId, body) {
  const request = require('supertest');
  const logger = require('../src/utils/logger');
  const realError = logger.error;
  logger.error = () => {};
  try {
    return await request(httpApp())
      .post(`/api/v1/social/projects/${projectId}/decompose`)
      .set('Authorization', `Bearer ${await tokenFor(userId)}`)
      .send(body);
  } finally { logger.error = realError; }
}
const res2s = (res) => `${res.status} ${JSON.stringify(res.body)}`;

// ---------------------------------------------------------------------------
async function testStranger() {
  section('1. HTTP stranger -> 403, nothing written');
  const pr = await makeProject();
  const stranger = await makeUser('stranger');
  const res = await postDecompose(stranger, pr.projectId, { project_name: 'X', total_budget: 999999 });
  expect(res.status === 403, 'stranger: HTTP 403', res2s(res));
  const r = await rows(pr.projectId);
  expect(r.decomp === 0 && r.escrow === null, 'stranger: no decomposition row, no escrow row', show(r));
}

async function testMissingProject() {
  section('2. Non-existent project -> 404, nothing written');
  const admin = await makeUser('admin', 'ADMIN');
  const missing = 900000000 + Math.floor(Math.random() * 1000000);
  const res = await postDecompose(admin, missing, { project_name: 'Ghost', total_budget: 5000 });
  expect(res.status === 404, 'missing project: HTTP 404', res2s(res));
  const r = await rows(missing);
  expect(r.decomp === 0 && r.escrow === null, 'missing project: no rows', show(r));
}

async function testOwnerNoEscrow() {
  section('3. Owner decomposes an unfunded project -> template, NO escrow');
  const pr = await makeProject();
  const res = await postDecompose(pr.owner, pr.projectId, { project_name: 'Shule', total_budget: 999999 });
  expect(res.status === 200 && res.body.success === true && Array.isArray(res.body.phases) && res.body.phases.length === 4,
    'owner: HTTP 200 with 4 phases', res2s(res));
  const costs = (res.body.phases || []).map((p) => Number(p.estimated_cost)).join(',');
  expect(costs === '99999.9,299999.7,349999.65,249999.75', 'owner: template split 10/30/35/25 of the budget (unchanged)', costs);
  const r = await rows(pr.projectId);
  expect(r.decomp === 4, 'owner: 4 decomposition rows', show(r));
  expect(r.escrow === null, 'owner: NO controlled_project_accounts row from the request amount', show(r));
}

async function testExpertAndValidation() {
  section('4. Expert allowed; invalid budgets -> 400 with no rows');
  const pr = await makeProject();
  for (const role of ['ADMIN', 'MODERATOR', 'EXPERT']) {
    const u = await makeUser(role.toLowerCase(), role);
    const res = await postDecompose(u, pr.projectId, { project_name: 'P', total_budget: 1000 });
    expect(res.status === 200 && res.body.phases && res.body.phases.length === 4, `${role} (not owner): HTTP 200`, res2s(res));
  }
  const pr2 = await makeProject();
  for (const b of [0, -5, 'abc', undefined, 'NaN', 'Infinity']) {
    const res = await postDecompose(pr2.owner, pr2.projectId, { project_name: 'P', total_budget: b });
    expect(res.status === 400, `budget ${JSON.stringify(b)}: HTTP 400`, res2s(res));
  }
  const r = await rows(pr2.projectId);
  expect(r.decomp === 0 && r.escrow === null, 'invalid budgets: no rows', show(r));
}

async function testVerifiedFunding() {
  section('5/6. Escrow comes from verified funding; duplicates do not double-credit');
  const pr = await makeProject('FUNDING', 10000);
  const a = await makeUser('invA', null, 5000);
  const b = await makeUser('invB', null, 5000);
  const refA = `P71DEC-${tag}-${pr.projectId}-a`;
  const r1 = await safe(() => projectService.invest(a, pr.projectId, { amount: 300, unique_reference: refA }));
  const r2 = await safe(() => projectService.invest(b, pr.projectId, { amount: 200, unique_reference: `P71DEC-${tag}-${pr.projectId}-b` }));
  expect(!r1.error && !r2.error, 'two investments succeed', r1.error || r2.error);
  const f = await funding(pr.projectId);
  expect(f.raised === 500 && f.confirmed === 500 && f.ledger === 500 && f.txns === 2, 'amount_raised = CONFIRMED = PROJECT ledger CR = 500; 2 transactions', show(f));
  expect(escrowMatches(f, 500), 'escrow remaining = escrow_balance = 500', show(f.escrow));

  const dec = await postDecompose(pr.owner, pr.projectId, { project_name: 'P', total_budget: 999999 });
  const f2 = await funding(pr.projectId);
  expect(dec.status === 200 && escrowMatches(f2, 500), 'owner decompose with budget 999999 leaves escrow at 500', `${dec.status} ${show(f2.escrow)}`);

  const walletA0 = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [a])).rows[0].wallet_balance);
  const dup = await safe(() => projectService.invest(a, pr.projectId, { amount: 300, unique_reference: refA }));
  const walletA1 = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [a])).rows[0].wallet_balance);
  const f3 = await funding(pr.projectId);
  expect(walletA1 === walletA0 && f3.raised === 500 && f3.ledger === 500 && f3.invCount === 2 && escrowMatches(f3, 500),
    'duplicate unique_reference: no second debit, raised/ledger/escrow stay 500', `${dup.error || show(dup.value)} ${show(f3)}`);

  await projectFinance.onFundingReceived({ projectId: pr.projectId, amount: 300, firstFunding: false });
  await projectFinance.onFundingReceived({ projectId: pr.projectId, amount: 300, firstFunding: false });
  const f4 = await funding(pr.projectId);
  expect(escrowMatches(f4, 500), 'repeated funding callback: escrow unchanged at 500', show(f4.escrow));
}

async function testConcurrentFunding() {
  section('7. Concurrent investments -> escrow = amount_raised = sum');
  const pr = await makeProject('FUNDING', 10000);
  const invs = [];
  for (let i = 0; i < 4; i++) invs.push(await makeUser(`c${i}`, null, 2000));
  const res = await Promise.all(invs.map((u, i) => safe(() =>
    projectService.invest(u, pr.projectId, { amount: 100 * (i + 1), unique_reference: `P71DEC-${tag}-${pr.projectId}-c${i}` }))));
  // A loser may be refused (e.g. existing lock_timeout); it must leave nothing behind.
  const okSum = res.reduce((s, x, i) => s + (x.error ? 0 : 100 * (i + 1)), 0);
  const okCount = res.filter((x) => !x.error).length;
  expect(okCount >= 1, `at least one concurrent investment succeeds (${okCount}/4)`, show(res.map((x) => x.error || 'OK')));
  const f = await funding(pr.projectId);
  expect(f.raised === okSum && f.confirmed === okSum && f.ledger === okSum && f.invCount === okCount && f.txns === okCount,
    `amount_raised = CONFIRMED = ledger = sum of successful investments (${okSum}); one row each`, show(f));
  expect(escrowMatches(f, okSum), `escrow = ${okSum} after concurrent funding`, show(f.escrow));
  for (let i = 0; i < invs.length; i++) {
    if (!res[i].error) continue;
    const w = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [invs[i]])).rows[0].wallet_balance);
    expect(w === 2000, `refused concurrent investor c${i}: wallet unchanged`, w);
  }
}

async function testRollback() {
  section('8. Failed investment -> full rollback');
  const pr = await makeProject('FUNDING', 10000);
  const rich = await makeUser('rich', null, 1000);
  await projectService.invest(rich, pr.projectId, { amount: 400, unique_reference: `P71DEC-${tag}-${pr.projectId}-r` });
  const before = await funding(pr.projectId);
  const poor = await makeUser('poor', null, 50);
  const ref = `P71DEC-${tag}-${pr.projectId}-p`;
  const r = await safe(() => projectService.invest(poor, pr.projectId, { amount: 300, unique_reference: ref }));
  expect(!!r.error, 'insufficient wallet: investment refused', r.error || show(r.value));
  const after = await funding(pr.projectId);
  const leftovers = (await pool.query(
    `SELECT (SELECT COUNT(*) FROM project_investments WHERE unique_reference = $1)::int AS inv,
            (SELECT COUNT(*) FROM transactions WHERE reference_id = $1)::int AS tx,
            (SELECT COUNT(*) FROM journal_entries WHERE reference_id = $1)::int AS je`, [ref])).rows[0];
  expect(leftovers.inv === 0 && leftovers.tx === 0 && leftovers.je === 0, 'no investment, transaction or journal row for the failed reference', show(leftovers));
  expect(after.raised === before.raised && escrowMatches(after, before.raised), 'amount_raised and escrow unchanged (400)', `${show(before)} -> ${show(after)}`);
  const wallet = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [poor])).rows[0].wallet_balance);
  expect(wallet === 50, 'failed investor wallet unchanged', wallet);
}

async function testStatic() {
  section('9. Static: guard placement, no escrow write, route wiring');
  const src = fs.readFileSync(SERVICE_FILE, 'utf8');
  const fn = src.slice(src.indexOf('async function decomposeProject'), src.indexOf('async function calculateWaterfall'));
  const iGuard = fn.indexOf('assertProjectWriter(');
  const iBegin = fn.indexOf("'BEGIN'");
  expect(iGuard > 0 && iBegin > iGuard, 'decompose: owner/expert guard precedes BEGIN', `${iGuard} / ${iBegin}`);
  expect(!/(INSERT\s+INTO|UPDATE)\s+controlled_project_accounts/i.test(fn), 'decompose: no INSERT/UPDATE of controlled_project_accounts', '');
  const routes = fs.readFileSync(ROUTES_FILE, 'utf8');
  const dec = routes.slice(routes.indexOf("'/projects/:id/decompose'"), routes.indexOf("'/projects/:id/waterfall'"));
  expect(/req\.user\.id/.test(dec) && /req\.user\.role/.test(dec), 'route passes req.user.id and req.user.role (not body)', dec.slice(0, 200));
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port`);
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);
    const silenced = console.error;
    console.error = () => {};
    try {
      for (const t of [testStranger, testMissingProject, testOwnerNoEscrow, testExpertAndValidation, testVerifiedFunding, testConcurrentFunding, testRollback, testStatic]) {
        const res = await safe(t);
        if (res.error) bad(`${t.name} aborted`, res.error);
      }
    } finally {
      console.error = silenced;
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
