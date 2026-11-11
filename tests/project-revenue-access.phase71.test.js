#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step E0d: who may process incoming project revenue
 *   POST /projects/:id/revenue/process-incoming  (src/routes/projectRoutes.js)
 *   processIncomingRevenue                       (src/services/projectFinanceService.js)
 *
 * Revenue processed here becomes PENDING investor entitlements that
 * payProjectDividends later pays into wallets, so only the project owner or
 * ADMIN / MODERATOR / EXPERT may run it. The check lives in the service.
 *
 *  1. HTTP, regular user (not owner, not investor): 403, and NOTHING is
 *     created: no project_revenue, financial_operations claim, transactions,
 *     journal_entries, waterfall_allocation_records or project_investor_payouts.
 *  2. HTTP, an investor of the project (not owner): 403, nothing created.
 *  3. HTTP, the owner: 201 with the current result (allocations, payouts).
 *  4. HTTP, ADMIN / MODERATOR / EXPERT (not owner): 201, same result.
 *  5. Service called directly without a role by a non-owner: 403 (the guard
 *     is in the service, not only in the route); with an expert role: allowed.
 *  6. Static: the guard runs before the rule lookup and before BEGIN; the
 *     route passes req.user.role.
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

const pool = require('../src/config/db');
const projectFinance = require('../src/services/projectFinanceService');

const FINANCE_FILE = path.join(__dirname, '..', 'src', 'services', 'projectFinanceService.js');
const ROUTES_FILE = path.join(__dirname, '..', 'src', 'routes', 'projectRoutes.js');
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

const FORBIDDEN = 'Huna ruhusa za mradi huu.';

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label, role) {
  seq += 1;
  const phone = `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71E0d ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  return id;
}
// ACTIVE project, ACTIVE waterfall rule (60 % dividend, 40 % owner residual),
// two CONFIRMED investors (600 + 400 of 1000 raised).
async function makeProject() {
  const owner = await makeUser('owner');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const p = (await pool.query(
    `INSERT INTO projects (owner_user_id, name, status, capital_required, amount_raised)
     VALUES ($1, $2, 'ACTIVE', 1000, 1000) RETURNING id`,
    [owner, `P71E0d project ${tag} ${++seq}`])).rows[0].id;
  for (const [inv, amt] of [[invA, 600], [invB, 400]]) {
    await pool.query(
      `INSERT INTO project_investments (project_id, investor_user_id, amount, status, unique_reference)
       VALUES ($1, $2, $3, 'CONFIRMED', $4)`, [p, inv, amt, `P71E0d-${tag}-${p}-u${inv}`]);
  }
  await pool.query(
    `INSERT INTO waterfall_allocation_rules (project_id, version, status, investor_dividend_percentage, owner_residual_percentage)
     VALUES ($1, 1, 'ACTIVE', 60, 40)`, [p]);
  return { projectId: p, owner, invA, invB };
}
// Everything processIncomingRevenue writes, for one project + reference.
async function footprint(projectId, ref) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows[0].c;
  return {
    revenue: await q('SELECT COUNT(*)::int AS c FROM project_revenue WHERE project_id = $1', [projectId]),
    claims: await q('SELECT COUNT(*)::int AS c FROM financial_operations WHERE reference_id = $1', [ref]),
    txns: await q('SELECT COUNT(*)::int AS c FROM transactions WHERE reference_id = $1', [ref]),
    journal: await q(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id = $1 OR reference_id LIKE $2`, [ref, `${ref}-%`]),
    allocations: await q('SELECT COUNT(*)::int AS c FROM waterfall_allocation_records WHERE project_id = $1', [projectId]),
    payouts: await q('SELECT COUNT(*)::int AS c FROM project_investor_payouts WHERE project_id = $1', [projectId]),
    entitlement: Number((await pool.query(
      'SELECT COALESCE(SUM(entitlement),0) AS s FROM project_investor_payouts WHERE project_id = $1', [projectId])).rows[0].s),
  };
}
const EMPTY = { revenue: 0, claims: 0, txns: 0, journal: 0, allocations: 0, payouts: 0, entitlement: 0 };

// ---- HTTP harness: the REAL route behind the REAL i18n + errorHandler --------
let app;
function httpApp() {
  if (app) return app;
  const express = require('express');
  const { i18n } = require('../src/i18n/middleware');
  const projectRoutes = require('../src/routes/projectRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use(i18n);
  app.use('/api/v1', projectRoutes);
  app.use(errorHandler);
  return app;
}
async function tokenFor(id) {
  const u = (await pool.query('SELECT id, role, phone_number, auth_version FROM users WHERE id = $1', [id])).rows[0];
  return require('../src/middleware/auth').signToken(u);
}
async function postRevenue(userId, projectId, ref) {
  const request = require('supertest');
  const logger = require('../src/utils/logger');
  const realError = logger.error;
  logger.error = () => {};
  try {
    return await request(httpApp())
      .post(`/api/v1/projects/${projectId}/revenue/process-incoming`)
      .set('Authorization', `Bearer ${await tokenFor(userId)}`)
      .send({ amount: 1000, revenue_type: 'SALES', unique_reference: ref, description: 'E0d test revenue' });
  } finally { logger.error = realError; }
}
const show = (res) => `${res.status} ${JSON.stringify(res.body)}`;

// Expected result of a successful run (unchanged by E0d): 1000 split 60/40,
// DIVIDEND 600 shared 360/240 between the investors.
function expectProcessed(label, res, fp, ref) {
  expect(res.status === 201 && res.body.success === true && res.body.revenue_id === ref && res.body.amount === 1000,
    `${label}: 201 success, revenue_id = unique_reference, amount 1000`, show(res));
  const alloc = JSON.stringify(res.body.allocations);
  expect(alloc === JSON.stringify([{ step: 'DIVIDEND', amount: 600, pct: 60 }, { step: 'OWNER_RESIDUAL', amount: 400, pct: 40 }]),
    `${label}: allocations DIVIDEND 600 (60 %), OWNER_RESIDUAL 400 (40 %)`, alloc);
  expect(fp.revenue === 1 && fp.claims === 1 && fp.txns === 1, `${label}: 1 project_revenue, 1 claim, 1 transaction`, JSON.stringify(fp));
  expect(fp.journal === 6, `${label}: 6 journal rows (revenue pair + 2 waterfall pairs)`, fp.journal);
  expect(fp.allocations === 2 && fp.payouts === 2 && fp.entitlement === 600,
    `${label}: 2 waterfall allocations, 2 PENDING payouts totalling 600`, JSON.stringify(fp));
}

// ---------------------------------------------------------------------------
async function testRegularUser() {
  section('1. HTTP: regular user (not owner, not investor) -> 403, nothing created');
  const pr = await makeProject();
  const stranger = await makeUser('stranger');
  const ref = `P71E0d-${tag}-s1-${pr.projectId}`;
  const res = await postRevenue(stranger, pr.projectId, ref);
  const fp = await footprint(pr.projectId, ref);
  progress(`regular user: HTTP ${show(res)}; footprint ${JSON.stringify(fp)}`);
  expect(res.status === 403, 'regular user: HTTP 403', res.status);
  expect(res.body.success === false && res.body.message === FORBIDDEN, `regular user: body says "${FORBIDDEN}"`, JSON.stringify(res.body));
  expect(JSON.stringify(fp) === JSON.stringify(EMPTY),
    'regular user: no project_revenue, claim, transaction, journal, waterfall allocation or payout created', JSON.stringify(fp));
}

async function testInvestor() {
  section('2. HTTP: investor of the project (not owner) -> 403, nothing created');
  const pr = await makeProject();
  const ref = `P71E0d-${tag}-s2-${pr.projectId}`;
  const res = await postRevenue(pr.invA, pr.projectId, ref);
  const fp = await footprint(pr.projectId, ref);
  progress(`investor: HTTP ${show(res)}; footprint ${JSON.stringify(fp)}`);
  expect(res.status === 403 && res.body.message === FORBIDDEN, 'investor: HTTP 403 with the same message', show(res));
  expect(JSON.stringify(fp) === JSON.stringify(EMPTY), 'investor: nothing created', JSON.stringify(fp));
}

async function testOwner() {
  section('3. HTTP: the owner -> 201, current result');
  const pr = await makeProject();
  const ref = `P71E0d-${tag}-s3-${pr.projectId}`;
  const res = await postRevenue(pr.owner, pr.projectId, ref);
  const fp = await footprint(pr.projectId, ref);
  progress(`owner: HTTP ${show(res)}; footprint ${JSON.stringify(fp)}`);
  expectProcessed('owner', res, fp, ref);
  const per = (await pool.query(
    'SELECT investor_user_id, entitlement, status FROM project_investor_payouts WHERE project_id = $1 ORDER BY investor_user_id', [pr.projectId])).rows;
  expect(per.length === 2 && Number(per.find((r) => r.investor_user_id === pr.invA).entitlement) === 360
    && Number(per.find((r) => r.investor_user_id === pr.invB).entitlement) === 240 && per.every((r) => r.status === 'PENDING'),
  'owner: entitlements 360 / 240 PENDING (by investment share)', JSON.stringify(per));
  // Replay with the same unique_reference is still a 409 (unchanged).
  const again = await postRevenue(pr.owner, pr.projectId, ref);
  expect(again.status === 409, 'owner: replay with the same unique_reference -> 409 (unchanged)', show(again));
}

async function testExperts() {
  section('4. HTTP: ADMIN / MODERATOR / EXPERT (not owner) -> 201, same result');
  for (const role of ['ADMIN', 'MODERATOR', 'EXPERT']) {
    const pr = await makeProject();
    const actor = await makeUser(role.toLowerCase(), role);
    const ref = `P71E0d-${tag}-s4-${role}-${pr.projectId}`;
    const res = await postRevenue(actor, pr.projectId, ref);
    const fp = await footprint(pr.projectId, ref);
    progress(`${role}: HTTP ${show(res)}`);
    expectProcessed(role, res, fp, ref);
  }
}

async function testServiceGuard() {
  section('5. Service called directly: the guard is in the service');
  const pr = await makeProject();
  const stranger = await makeUser('stranger');
  const ref = `P71E0d-${tag}-s5-${pr.projectId}`;
  const r = await safe(() => projectFinance.processIncomingRevenue(stranger, pr.projectId,
    { amount: 1000, revenue_type: 'SALES', unique_reference: ref }));
  const fp = await footprint(pr.projectId, ref);
  progress(`service, non-owner, no role: ${r.error ? `${r.err.statusCode} ${r.error}` : JSON.stringify(r.value)}`);
  expect(!!r.err && r.err.statusCode === 403 && r.error === FORBIDDEN, 'service: non-owner without a role -> 403', r.error || JSON.stringify(r.value));
  expect(JSON.stringify(fp) === JSON.stringify(EMPTY), 'service: nothing created', JSON.stringify(fp));
  const spoof = await safe(() => projectFinance.processIncomingRevenue(stranger, pr.projectId,
    { amount: 1000, revenue_type: 'SALES', unique_reference: `${ref}-spoof`, actorRole: 'ADMIN', role: 'ADMIN' }));
  expect(!!spoof.err && spoof.err.statusCode === 403, 'service: a role inside the options object is ignored (403)', spoof.error || JSON.stringify(spoof.value));
  const expert = await makeUser('expert', 'EXPERT');
  const r2 = await safe(() => projectFinance.processIncomingRevenue(expert, pr.projectId,
    { amount: 1000, revenue_type: 'SALES', unique_reference: `${ref}-x` }, 'EXPERT'));
  expect(!r2.error && r2.value.revenue_id === `${ref}-x`, 'service: expert role (4th argument) allowed', r2.error);
}

function testStatic() {
  section('6. Static: guard in the service before the rule lookup and BEGIN; route passes the role');
  const src = fs.readFileSync(FINANCE_FILE, 'utf8');
  const start = src.indexOf('async function processIncomingRevenue(');
  const fn = src.slice(start, src.indexOf('\n}\n', start));
  const guard = fn.search(/if \(p\.owner_user_id !== userId && !isExpert\(actorRole\)\)/);
  expect(start >= 0 && guard > 0, 'service: owner-or-expert guard present');
  // Remediation OBS-7c renamed the lookup to getAllocationRule (FROZEN terms); either name counts.
  const ruleLookup = fn.search(/get(Effective|Allocation)Rule\(/);
  expect(guard > 0 && ruleLookup > guard && guard < fn.indexOf("client.query('BEGIN')"),
    'service: guard runs before the rule lookup and before BEGIN');
  expect(/async function processIncomingRevenue\(userId, projectId, \{ amount, revenue_type, unique_reference, description \} = \{\}, actorRole = null\)/.test(src),
    'service: role is a separate argument (not read from the request options)');
  const routes = fs.readFileSync(ROUTES_FILE, 'utf8');
  expect(/processIncomingRevenue\(req\.user\.id, parseInt\(req\.params\.id, 10\), \{ amount, revenue_type, unique_reference, description \}, req\.user\.role\)/.test(routes),
    'route: passes req.user.role from the authenticated user');
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
      for (const t of [testRegularUser, testInvestor, testOwner, testExperts, testServiceGuard, testStatic]) {
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
