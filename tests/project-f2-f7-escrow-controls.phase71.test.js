#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Remediation F2 + F7: escrow controls on money leaving
 * a project (owner decisions "F2 REFUND AND DISBURSEMENT CONTROLS" and
 * "F2 + F7").
 *
 *   F2a  Disbursement only when the project is ACTIVE
 *        (requestDisbursement; executeDisbursement under the project row lock).
 *   F2b  Refund rejected when the available escrow is insufficient; no
 *        GREATEST(..., 0) floor (refundInvestment, forceCloseFunding REFUND).
 *   F7a  Payroll is paid from PROJECT_INVESTMENT_ACCOUNT (investor capital),
 *        so it follows the escrow controls: ACTIVE only, only from THIS
 *        project's escrow, decremented under lock, fail-closed.
 *   F7b  Legacy computeDistribution (request-supplied gross_profit, paid from
 *        investor capital, no link to recorded revenue) is refused.
 *
 * Every rejected operation must leave wallets, escrow, investments, journal,
 * operations, transactions, payroll and distribution rows unchanged.
 *
 * axios and SMS are stubbed. Requires a DISPOSABLE database named
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
  console.log('\nWATCHDOG: test process exceeded 280 s; exiting with failure.');
  process.exit(1);
}, 280000).unref();

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
const pg = require('pg');
const projectService = require('../src/services/projectService');
const pf = require('../src/services/projectFinanceService');

const PROJECT_FILE = path.join(__dirname, '..', 'src', 'services', 'projectService.js');
const FINANCE_FILE = path.join(__dirname, '..', 'src', 'services', 'projectFinanceService.js');
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
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// ---- failure injection ------------------------------------------------------
let inject = null; // { re, label } -> next matching query throws
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function patched(...args) {
  const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  if (inject && inject.re.test(sql)) {
    const err = new Error(`TEST: injected failure at ${inject.label}`);
    inject = null;
    if (cb) { setImmediate(() => cb(err)); return undefined; }
    return Promise.reject(err);
  }
  return origQuery.apply(this, args);
};

// ---- fixtures ---------------------------------------------------------------
const people = {};
async function makeUser(label, role, wallet = 0) {
  seq += 1;
  const phone = `2554${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71F2 ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  if (wallet) await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [wallet, id]);
  return id;
}
const seededDrift = new Set(); // projects whose escrow was deliberately broken (legacy state)
const allProjects = new Set();
async function makeProject({ capital = 10000, status = 'FUNDING' } = {}) {
  const owner = await makeUser('owner');
  const id = (await pool.query(
    `INSERT INTO projects (owner_user_id, name, status, capital_required, amount_raised)
     VALUES ($1, $2, $3, $4, 0) RETURNING id`,
    [owner, `P71F2 project ${tag} ${++seq}`, status, capital])).rows[0].id;
  allProjects.add(id);
  return { projectId: id, owner };
}
const ref = (pid, s) => `P71F2-${tag}-${pid}-${s}`;
const invest = (u, pid, amount, s) => projectService.invest(u, pid, { amount, unique_reference: ref(pid, s) });
async function wallet(u) { return Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [u])).rows[0].wallet_balance); }
async function seedRequest(pid, amount, requestedBy, s) {
  return (await pool.query(
    `INSERT INTO project_disbursements (project_id, amount, status, requested_by, unique_reference)
     VALUES ($1, $2, 'AUTHORIZED', $3, $4) RETURNING id`,
    [pid, amount, requestedBy, ref(pid, s)])).rows[0].id;
}
async function expire(pid) {
  await pool.query(`UPDATE projects SET funding_deadline = NOW() - interval '1 day' WHERE id = $1`, [pid]);
  await projectService.expireUnfundedProjects();
}
// Legacy shortfall (as left by a pre-F2 disbursement while FUNDING): escrow below what investors paid.
async function seedShortfall(pid, remaining, disbursed) {
  seededDrift.add(pid);
  await pool.query('UPDATE controlled_project_accounts SET remaining_balance = $2, disbursed_total = $3 WHERE project_id = $1', [pid, remaining, disbursed]);
}

// Everything a rejected operation must not change.
async function snap(pid, users = []) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const p = await one('SELECT status, amount_raised FROM projects WHERE id = $1', [pid]);
  const e = await one('SELECT escrow_balance, remaining_balance, disbursed_total, status FROM controlled_project_accounts WHERE project_id = $1', [pid]);
  const inv = (await pool.query('SELECT id, status, refund_reference FROM project_investments WHERE project_id = $1 ORDER BY id', [pid])).rows
    .map((r) => `${r.id}:${r.status}:${r.refund_reference || '-'}`);
  const disb = (await pool.query('SELECT id, status FROM project_disbursements WHERE project_id = $1 ORDER BY id', [pid])).rows.map((r) => `${r.id}:${r.status}`);
  const counts = await one(`SELECT (SELECT COUNT(*) FROM journal_entries)::int AS je,
    (SELECT COUNT(*) FROM financial_operations)::int AS ops,
    (SELECT COUNT(*) FROM transactions)::int AS tx,
    (SELECT COUNT(*) FROM financial_audit_log)::int AS fal,
    (SELECT COUNT(*) FROM project_payroll)::int AS payroll,
    (SELECT COUNT(*) FROM project_distributions)::int AS dist,
    (SELECT COUNT(*) FROM project_reserves WHERE project_id = $1)::int AS reserves`, [pid]);
  const w = [];
  for (const u of users) w.push(await wallet(u));
  return {
    project: p.status, raised: Number(p.amount_raised),
    escrow: e ? { gross: Number(e.escrow_balance), remaining: Number(e.remaining_balance), disbursed: Number(e.disbursed_total), status: e.status } : null,
    inv, disb, counts, wallets: w,
  };
}

// Per-project reconciliation:
//   paid_in (CONFIRMED + REFUNDED) - refunded - disbursed_total - payroll = escrow remaining
//   PROJECT_INVESTMENT_ACCOUNT net over this project's references       = escrow remaining
async function recon(pid) {
  const one = async (sql) => (await pool.query(sql, [pid])).rows[0];
  const inv = await one(`SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('CONFIRMED','REFUNDED')),0)::numeric AS paid_in,
                                COALESCE(SUM(amount) FILTER (WHERE status = 'REFUNDED'),0)::numeric AS refunded,
                                COALESCE(SUM(amount) FILTER (WHERE status = 'CONFIRMED'),0)::numeric AS confirmed
                           FROM project_investments WHERE project_id = $1`);
  const pay = await one('SELECT COALESCE(SUM(amount),0)::numeric AS s FROM project_payroll WHERE project_id = $1');
  const p = await one('SELECT status, amount_raised FROM projects WHERE id = $1');
  const e = await one('SELECT remaining_balance, disbursed_total FROM controlled_project_accounts WHERE project_id = $1');
  const led = await one(
    `SELECT COALESCE(SUM(CASE WHEN je.direction = 'CR' THEN je.amount ELSE -je.amount END),0)::numeric AS net
       FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id
      WHERE la.account_code = 'PROJECT_INVESTMENT_ACCOUNT'
        AND je.reference_id IN (
          SELECT unique_reference FROM project_investments WHERE project_id = $1
          UNION SELECT refund_reference FROM project_investments WHERE project_id = $1 AND refund_reference IS NOT NULL
          UNION SELECT unique_reference FROM project_disbursements WHERE project_id = $1 AND status = 'RELEASED'
          UNION SELECT unique_reference FROM project_payroll WHERE project_id = $1)`);
  const remaining = e ? Number(e.remaining_balance) : 0;
  const disbursed = e ? Number(e.disbursed_total) : 0;
  const expected = r2(Number(inv.paid_in) - Number(inv.refunded) - disbursed - Number(pay.s));
  return {
    project: p.status, raised: Number(p.amount_raised), confirmed: Number(inv.confirmed), paidIn: Number(inv.paid_in),
    refunded: Number(inv.refunded), disbursed, payroll: Number(pay.s), remaining, expected, ledger: Number(led.net),
  };
}
const reconciles = (r) => r.remaining >= 0 && r.expected === r.remaining && r.ledger === r.remaining;

// ACTIVE project funded with `amount` by one investor (capital == amount -> ACTIVE on invest).
async function activeProject(amount = 1000) {
  const pr = await makeProject({ capital: amount });
  const investor = await makeUser('investor', null, amount);
  await invest(investor, pr.projectId, amount, 'fund');
  return { ...pr, investor };
}

// HTTP harness (real projectRoutes + i18n + errorHandler)
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

// ===========================================================================
async function testDisbursementRequiresActive() {
  section('1. F2a: disbursement only when the project is ACTIVE');
  // 1a. requestDisbursement on a FUNDING project with a CONFIRMED investment.
  const pr = await makeProject();
  const a = await makeUser('A', null, 1000);
  await invest(a, pr.projectId, 1000, 'a');
  const ms = (await pool.query(`INSERT INTO project_milestones (project_id, phase, name, budget) VALUES ($1,'P1','M1',600) RETURNING id`, [pr.projectId])).rows[0].id;
  const r1 = await safe(() => pf.requestDisbursement(pr.owner, pr.projectId, { milestone_id: ms, amount: 600, unique_reference: ref(pr.projectId, 'req') }));
  const rows = (await pool.query('SELECT COUNT(*)::int c FROM project_disbursements WHERE project_id = $1', [pr.projectId])).rows[0].c;
  expect(r1.err && r1.err.statusCode === 409 && r1.err.code === 'DISBURSEMENT_PROJECT_NOT_ACTIVE' && rows === 0,
    '1a: requestDisbursement on a FUNDING project refused (409), no request row', r1.error || show(r1.value));

  // 1b. A legacy AUTHORIZED request (created before F2) on a FUNDING project cannot be executed.
  const exec = await makeUser('executor', 'ADMIN');
  const reqId = await seedRequest(pr.projectId, 600, pr.owner, 'legacy');
  const before = await snap(pr.projectId, [pr.owner, a]);
  const r2x = await safe(() => pf.executeDisbursement(exec, pr.projectId, reqId));
  const after = await snap(pr.projectId, [pr.owner, a]);
  expect(r2x.err && r2x.err.statusCode === 409 && r2x.err.code === 'DISBURSEMENT_PROJECT_NOT_ACTIVE',
    '1b: executeDisbursement on a FUNDING project refused (409)', r2x.error || show(r2x.value));
  expect(show(after) === show(before), '1b: nothing changed (owner wallet, escrow, request AUTHORIZED, journal, operations)', `${show(before)} -> ${show(after)}`);

  // 1c. EXPIRED project: execute refused.
  await expire(pr.projectId);
  const before2 = await snap(pr.projectId, [pr.owner, a]);
  const r3 = await safe(() => pf.executeDisbursement(exec, pr.projectId, reqId));
  expect(r3.err && r3.err.code === 'DISBURSEMENT_PROJECT_NOT_ACTIVE' && show(await snap(pr.projectId, [pr.owner, a])) === show(before2),
    '1c: executeDisbursement on an EXPIRED project refused, nothing changed', r3.error || show(r3.value));

  // 1d. ACTIVE project: the full workflow (request -> review -> approve -> execute) works.
  const ap = await activeProject(1000);
  const expert = await makeUser('expert', 'EXPERT');
  const approver = await makeUser('approver', 'ADMIN');
  const ms2 = (await pool.query(`INSERT INTO project_milestones (project_id, phase, name, budget) VALUES ($1,'P1','M1',400) RETURNING id`, [ap.projectId])).rows[0].id;
  const rq = await safe(() => pf.requestDisbursement(ap.owner, ap.projectId, { milestone_id: ms2, amount: 400, unique_reference: ref(ap.projectId, 'req') }));
  const rid = (await pool.query('SELECT id FROM project_disbursements WHERE project_id = $1', [ap.projectId])).rows[0];
  expect(!rq.error && !!rid, '1d: requestDisbursement on an ACTIVE project accepted', rq.error);
  if (rid) {
    await pf.reviewDisbursement(expert, ap.projectId, rid.id, { decision: 'APPROVE' });
    await pf.approveDisbursement(approver, ap.projectId, rid.id);
    const ex = await safe(() => pf.executeDisbursement(exec, ap.projectId, rid.id));
    const rc = await recon(ap.projectId);
    expect(!ex.error && (await wallet(ap.owner)) === 400 && rc.remaining === 600 && rc.disbursed === 400,
      '1d: execute on ACTIVE releases 400 (owner wallet 400, escrow 600, disbursed 400)', ex.error || show(rc));
    expect(reconciles(rc), '1d: reconciliation holds (paid_in - disbursed = escrow = ledger)', show(rc));
  }

  // 1e. COMPLETED project: execute refused.
  const cp = await activeProject(500);
  const reqC = await seedRequest(cp.projectId, 100, cp.owner, 'legacyC');
  await pf.completeProject({ projectId: cp.projectId, actorUserId: exec, actorRole: 'ADMIN' });
  const bC = await snap(cp.projectId, [cp.owner, cp.investor]);
  const rC = await safe(() => pf.executeDisbursement(exec, cp.projectId, reqC));
  expect(rC.err && rC.err.code === 'DISBURSEMENT_PROJECT_NOT_ACTIVE' && show(await snap(cp.projectId, [cp.owner, cp.investor])) === show(bC),
    '1e: executeDisbursement on a COMPLETED project refused, nothing changed', rC.error || show(rC.value));
}

async function testRefundInsufficientEscrow() {
  section('2. F2b: refund rejected when the available escrow is insufficient (no GREATEST floor)');
  // 2a. forceCloseFunding REFUND, single investor, legacy shortfall (escrow 400 of 1000).
  const pr = await makeProject();
  const a = await makeUser('A', null, 1000);
  await invest(a, pr.projectId, 1000, 'a');
  await seedShortfall(pr.projectId, 400, 600);
  const b1 = await snap(pr.projectId, [a, pr.owner]);
  const f1 = await safe(() => pf.forceCloseFunding(people.admin, 'ADMIN', pr.projectId, { action: 'REFUND' }));
  const a1 = await snap(pr.projectId, [a, pr.owner]);
  expect(f1.err && f1.err.statusCode === 409 && f1.err.code === 'FUNDING_REFUND_ESCROW_INSUFFICIENT',
    '2a: forceCloseFunding REFUND with escrow 400 < 1000 refused (409)', f1.error || show(f1.value));
  expect(show(a1) === show(b1), '2a: nothing changed (investor wallet, CONFIRMED, FUNDING, escrow 400, journal, operations)', `${show(b1)} -> ${show(a1)}`);

  // 2b. Two investors; the shortfall only bites on the second refund -> the whole REFUND rolls back.
  const pr2 = await makeProject();
  const x = await makeUser('X', null, 1000);
  const y = await makeUser('Y', null, 500);
  await invest(x, pr2.projectId, 1000, 'x');
  await invest(y, pr2.projectId, 500, 'y');
  await seedShortfall(pr2.projectId, 1200, 300);
  const b2 = await snap(pr2.projectId, [x, y]);
  const f2 = await safe(() => pf.forceCloseFunding(people.admin, 'ADMIN', pr2.projectId, { action: 'REFUND' }));
  const a2 = await snap(pr2.projectId, [x, y]);
  expect(f2.err && f2.err.code === 'FUNDING_REFUND_ESCROW_INSUFFICIENT' && show(a2) === show(b2),
    '2b: shortfall on the second refund -> no investor refunded, nothing changed (all-or-nothing)', `${f2.error} ${show(b2)} -> ${show(a2)}`);

  // 2c. Expiry refunds: the small refund fits, the large one is refused.
  const pr3 = await makeProject();
  const big = await makeUser('big', null, 1000);
  const small = await makeUser('small', null, 300);
  await invest(big, pr3.projectId, 1000, 'big');
  await invest(small, pr3.projectId, 300, 'small');
  await seedShortfall(pr3.projectId, 400, 900);
  await expire(pr3.projectId);
  const invs = (await pool.query('SELECT id, investor_user_id FROM project_investments WHERE project_id = $1 ORDER BY id', [pr3.projectId])).rows;
  const smallInv = invs.find((r) => r.investor_user_id === small).id;
  const bigInv = invs.find((r) => r.investor_user_id === big).id;
  const rs = await safe(() => projectService.refundInvestment(pr3.projectId, smallInv, small));
  expect(!rs.error && (await wallet(small)) === 300, '2c: refund 300 with escrow 400 succeeds (wallet back to 300)', rs.error);
  const esc = (await pool.query('SELECT remaining_balance FROM controlled_project_accounts WHERE project_id = $1', [pr3.projectId])).rows[0];
  expect(Number(esc.remaining_balance) === 100, '2c: escrow decremented exactly to 100', esc.remaining_balance);
  const b3 = await snap(pr3.projectId, [big, small]);
  const rb = await safe(() => projectService.refundInvestment(pr3.projectId, bigInv, big));
  const a3 = await snap(pr3.projectId, [big, small]);
  expect(rb.err && rb.err.statusCode === 409 && rb.err.code === 'FUNDING_REFUND_ESCROW_INSUFFICIENT',
    '2c: refund 1000 with escrow 100 refused (409)', rb.error || show(rb.value));
  expect(show(a3) === show(b3), '2c: refused refund changed nothing (CONFIRMED, wallet 0, escrow 100, journal)', `${show(b3)} -> ${show(a3)}`);

  // 2d. amount_raised drift below the refund is refused too (no floor on either projection).
  const pr4 = await makeProject();
  const d = await makeUser('D', null, 800);
  await invest(d, pr4.projectId, 800, 'd');
  seededDrift.add(pr4.projectId);
  await pool.query('UPDATE projects SET amount_raised = 500 WHERE id = $1', [pr4.projectId]);
  const b4 = await snap(pr4.projectId, [d]);
  const f4 = await safe(() => pf.forceCloseFunding(people.admin, 'ADMIN', pr4.projectId, { action: 'REFUND' }));
  expect(f4.err && f4.err.code === 'FUNDING_REFUND_ESCROW_INSUFFICIENT' && show(await snap(pr4.projectId, [d])) === show(b4),
    '2d: amount_raised 500 < refund 800 -> refused, nothing changed', f4.error || show(f4.value));

  // 2e. Consistent escrow: refunds still work and reconcile exactly.
  const pr5 = await makeProject();
  const e1 = await makeUser('E1', null, 700);
  const e2 = await makeUser('E2', null, 300);
  await invest(e1, pr5.projectId, 700, 'e1');
  await invest(e2, pr5.projectId, 300, 'e2');
  const f5 = await safe(() => pf.forceCloseFunding(people.admin, 'ADMIN', pr5.projectId, { action: 'REFUND' }));
  const rc5 = await recon(pr5.projectId);
  expect(!f5.error && (await wallet(e1)) === 700 && (await wallet(e2)) === 300 && rc5.remaining === 0 && rc5.project === 'CANCELLED',
    '2e: consistent escrow -> both refunded, escrow 0, CANCELLED', f5.error || show(rc5));
  expect(reconciles(rc5), '2e: reconciliation holds after refunds', show(rc5));
}

async function testConcurrency() {
  section('3. Concurrency: no double disbursement, refund or payroll');
  // 3a. Same investment refunded twice in parallel.
  const pr = await makeProject();
  const a = await makeUser('A', null, 600);
  await invest(a, pr.projectId, 600, 'a');
  await expire(pr.projectId);
  const invId = (await pool.query('SELECT id FROM project_investments WHERE project_id = $1', [pr.projectId])).rows[0].id;
  const res = await Promise.all([1, 2].map(() => safe(() => projectService.refundInvestment(pr.projectId, invId, a))));
  const refunds = (await pool.query(`SELECT COUNT(*)::int c FROM journal_entries WHERE reference_id IN (SELECT refund_reference FROM project_investments WHERE id = $1)`, [invId])).rows[0].c;
  const rc = await recon(pr.projectId);
  expect((await wallet(a)) === 600 && rc.remaining === 0 && rc.refunded === 600 && refunds === 2,
    '3a: parallel refundInvestment x2 -> refunded once (wallet 600, escrow 0, one balanced journal pair)', `${show(res.map((r) => r.error || 'OK'))} ${show(rc)} je=${refunds}`);
  expect(reconciles(rc), '3a: reconciliation holds', show(rc));

  // 3b. forceClose REFUND x2 in parallel.
  const pb = await makeProject();
  const b = await makeUser('B', null, 900);
  await invest(b, pb.projectId, 900, 'b');
  const fr = await Promise.all([1, 2].map(() => safe(() => pf.forceCloseFunding(people.admin, 'ADMIN', pb.projectId, { action: 'REFUND' }))));
  const rcb = await recon(pb.projectId);
  expect(fr.filter((r) => !r.error).length === 1 && (await wallet(b)) === 900 && rcb.refunded === 900 && rcb.remaining === 0,
    '3b: parallel forceClose REFUND x2 -> exactly one succeeds, refunded once', `${show(fr.map((r) => r.error || 'OK'))} ${show(rcb)}`);

  // 3c. Two different requests whose sum exceeds escrow, executed in parallel.
  const ap = await activeProject(1000);
  const ex1 = await makeUser('ex1', 'ADMIN');
  const ex2 = await makeUser('ex2', 'ADMIN');
  const q1 = await seedRequest(ap.projectId, 700, ap.owner, 'q1');
  const q2 = await seedRequest(ap.projectId, 600, ap.owner, 'q2');
  const ex = await Promise.all([safe(() => pf.executeDisbursement(ex1, ap.projectId, q1)), safe(() => pf.executeDisbursement(ex2, ap.projectId, q2))]);
  const rcc = await recon(ap.projectId);
  const ow = await wallet(ap.owner);
  expect(ex.filter((r) => !r.error).length === 1 && (ow === 700 || ow === 600) && rcc.remaining === r2(1000 - ow) && rcc.remaining >= 0,
    '3c: 700 + 600 against escrow 1000 in parallel -> exactly one released, escrow never negative', `${show(ex.map((r) => r.error || 'OK'))} owner=${ow} ${show(rcc)}`);
  expect(reconciles(rcc), '3c: reconciliation holds', show(rcc));

  // 3d. Same request executed twice in parallel.
  const ap2 = await activeProject(800);
  const q3 = await seedRequest(ap2.projectId, 300, ap2.owner, 'q3');
  const dd = await Promise.all([safe(() => pf.executeDisbursement(ex1, ap2.projectId, q3)), safe(() => pf.executeDisbursement(ex2, ap2.projectId, q3))]);
  const rcd = await recon(ap2.projectId);
  expect(dd.filter((r) => !r.error).length === 1 && (await wallet(ap2.owner)) === 300 && rcd.remaining === 500,
    '3d: same request executed x2 in parallel -> released once', `${show(dd.map((r) => r.error || 'OK'))} ${show(rcd)}`);

  // 3e. EXPIRED project with a legacy AUTHORIZED request: refund vs execute in parallel.
  const pe = await makeProject();
  const c = await makeUser('C', null, 1000);
  await invest(c, pe.projectId, 1000, 'c');
  const q4 = await seedRequest(pe.projectId, 600, pe.owner, 'q4');
  await expire(pe.projectId);
  const invC = (await pool.query('SELECT id FROM project_investments WHERE project_id = $1', [pe.projectId])).rows[0].id;
  const [refR, exR] = await Promise.all([
    safe(() => projectService.refundInvestment(pe.projectId, invC, c)),
    safe(() => pf.executeDisbursement(ex1, pe.projectId, q4)),
  ]);
  const rce = await recon(pe.projectId);
  const outTotal = r2((await wallet(c)) + (await wallet(pe.owner)));
  expect(!refR.error && exR.err && exR.err.code === 'DISBURSEMENT_PROJECT_NOT_ACTIVE' && outTotal === 1000,
    '3e: refund vs execute on an EXPIRED project -> refund OK, disbursement refused, total out = 1000 paid in', `${refR.error || 'OK'} / ${exR.error || 'OK'} out=${outTotal}`);
  expect(reconciles(rce), '3e: reconciliation holds', show(rce));

  // 3f. ACTIVE project: payroll vs completion in parallel -> total out == escrow.
  const pc = await activeProject(1000);
  const payee = await makeUser('payee');
  const [payR, compR] = await Promise.all([
    safe(() => projectService.recordPayroll(pc.owner, pc.projectId, { payee_user_id: payee, role: 'staff', amount: 300, unique_reference: ref(pc.projectId, 'pay') })),
    safe(() => pf.completeProject({ projectId: pc.projectId, actorUserId: people.admin, actorRole: 'ADMIN' })),
  ]);
  const total = r2((await wallet(payee)) + (await wallet(pc.investor)) + (await wallet(pc.owner)));
  const escF = (await pool.query('SELECT remaining_balance, status FROM controlled_project_accounts WHERE project_id = $1', [pc.projectId])).rows[0];
  expect(!compR.error && total === 1000 && Number(escF.remaining_balance) === 0,
    '3f: payroll vs completion in parallel -> total paid out = 1000 escrow, no double spend', `${payR.error || 'OK'} / ${compR.error || 'OK'} total=${total} escrow=${show(escF)}`);

  // 3g. Two payrolls whose sum exceeds escrow, in parallel.
  const pg2 = await activeProject(500);
  const p1 = await makeUser('p1');
  const p2 = await makeUser('p2');
  const pr2 = await Promise.all([
    safe(() => projectService.recordPayroll(pg2.owner, pg2.projectId, { payee_user_id: p1, role: 'a', amount: 400, unique_reference: ref(pg2.projectId, 'p1') })),
    safe(() => projectService.recordPayroll(pg2.owner, pg2.projectId, { payee_user_id: p2, role: 'b', amount: 300, unique_reference: ref(pg2.projectId, 'p2') })),
  ]);
  const rcg = await recon(pg2.projectId);
  const paid = r2((await wallet(p1)) + (await wallet(p2)));
  expect(pr2.filter((r) => !r.error).length === 1 && (paid === 400 || paid === 300) && rcg.remaining === r2(500 - paid),
    '3g: 400 + 300 payroll against escrow 500 in parallel -> exactly one paid', `${show(pr2.map((r) => r.error || 'OK'))} paid=${paid} ${show(rcg)}`);
  expect(reconciles(rcg), '3g: reconciliation holds', show(rcg));
}

async function testPayroll(xProject) {
  section('4. F7a: payroll follows the escrow controls');
  // 4a. Another project (X) holds investor money in the shared account. An
  //     unfunded DRAFT project (Y) cannot pay anyone with it.
  const y = await makeProject({ status: 'DRAFT' });
  const acc = await makeUser('accomplice');
  const b = await snap(y.projectId, [acc]);
  const bx = await recon(xProject.projectId);
  const r = await safe(() => projectService.recordPayroll(y.owner, y.projectId, { payee_user_id: acc, role: 'staff', amount: 900, unique_reference: ref(y.projectId, 'pay') }));
  expect(r.err && r.err.statusCode === 409 && r.err.code === 'PAYROLL_PROJECT_NOT_ACTIVE', '4a: payroll on a DRAFT project refused (409)', r.error || show(r.value));
  expect(show(await snap(y.projectId, [acc])) === show(b) && show(await recon(xProject.projectId)) === show(bx),
    '4a: nothing paid; project X escrow and ledger untouched', '');

  // 4b. FUNDING project refused.
  const r2b = await safe(() => projectService.recordPayroll(xProject.owner, xProject.projectId, { payee_user_id: acc, role: 'staff', amount: 100, unique_reference: ref(xProject.projectId, 'pay') }));
  expect(r2b.err && r2b.err.code === 'PAYROLL_PROJECT_NOT_ACTIVE' && show(await recon(xProject.projectId)) === show(bx), '4b: payroll on a FUNDING project refused, nothing changed', r2b.error || show(r2b.value));

  // 4c. ACTIVE project: paid from its own escrow; audit row inside the transaction.
  const ap = await activeProject(1000);
  const payee = await makeUser('payee');
  const ok1 = await safe(() => projectService.recordPayroll(ap.owner, ap.projectId, { payee_user_id: payee, role: 'staff', amount: 300, unique_reference: ref(ap.projectId, 'pay1') }));
  const rc = await recon(ap.projectId);
  const audit = (await pool.query(`SELECT COUNT(*)::int c FROM audit_logs WHERE action = 'PROJECT_PAYROLL' AND meta->>'referenceId' = $1`, [ref(ap.projectId, 'pay1')])).rows[0].c;
  expect(!ok1.error && (await wallet(payee)) === 300 && rc.remaining === 700 && rc.payroll === 300, '4c: ACTIVE payroll 300 paid from escrow (escrow 700)', ok1.error || show(rc));
  expect(audit === 1, '4c: PROJECT_PAYROLL audit row written', audit);
  expect(reconciles(rc), '4c: reconciliation holds (paid_in - payroll = escrow = ledger)', show(rc));

  // 4d. More than the escrow -> refused, nothing changed.
  const b4 = await snap(ap.projectId, [payee, ap.owner]);
  const r4 = await safe(() => projectService.recordPayroll(ap.owner, ap.projectId, { payee_user_id: payee, role: 'staff', amount: 701, unique_reference: ref(ap.projectId, 'pay2') }));
  expect(r4.err && r4.err.statusCode === 409 && r4.err.code === 'PAYROLL_ESCROW_INSUFFICIENT' && show(await snap(ap.projectId, [payee, ap.owner])) === show(b4),
    '4d: payroll 701 with escrow 700 refused, nothing changed', r4.error || show(r4.value));

  // 4e. Duplicate reference -> paid once.
  const b5 = await snap(ap.projectId, [payee]);
  const r5 = await safe(() => projectService.recordPayroll(ap.owner, ap.projectId, { payee_user_id: payee, role: 'staff', amount: 300, unique_reference: ref(ap.projectId, 'pay1') }));
  expect(r5.err && r5.err.statusCode === 409 && show(await snap(ap.projectId, [payee])) === show(b5), '4e: duplicate reference refused (409), paid once', r5.error || show(r5.value));

  // 4f. Not the owner -> 403, nothing changed.
  const stranger = await makeUser('stranger');
  const r6 = await safe(() => projectService.recordPayroll(stranger, ap.projectId, { payee_user_id: stranger, role: 'x', amount: 10, unique_reference: ref(ap.projectId, 'pay3') }));
  expect(r6.err && r6.err.statusCode === 403 && show(await snap(ap.projectId, [payee])) === show(b5), '4f: non-owner refused (403), nothing changed', r6.error || show(r6.value));

  // 4g. ACTIVE project with no escrow row (legacy) -> refused.
  const ne = await makeProject({ status: 'ACTIVE' });
  const r7 = await safe(() => projectService.recordPayroll(ne.owner, ne.projectId, { payee_user_id: payee, role: 'x', amount: 10, unique_reference: ref(ne.projectId, 'pay') }));
  expect(r7.err && r7.err.code === 'PAYROLL_ESCROW_INSUFFICIENT', '4g: ACTIVE project without an escrow row refused', r7.error || show(r7.value));

  // 4h. Failure injection at every write boundary of payroll -> full rollback.
  const boundaries = [
    ['project_payroll insert', /INSERT INTO project_payroll/i],
    ['escrow decrement', /UPDATE controlled_project_accounts/i],
    ['claim financial_operations', /INSERT INTO financial_operations/i],
    ['wallet credit', /UPDATE users SET wallet_balance/i],
    ['journal', /INSERT INTO journal_entries/i],
    ['balance audit', /INSERT INTO financial_audit_log/i],
    ['transactions row', /INSERT INTO transactions/i],
    ['audit_logs row', /INSERT INTO audit_logs/i],
    ['COMMIT', /^\s*COMMIT/i],
  ];
  for (const [label, re] of boundaries) {
    const before = await snap(ap.projectId, [payee, ap.owner]);
    inject = { re, label };
    const rr = await safe(() => projectService.recordPayroll(ap.owner, ap.projectId, { payee_user_id: payee, role: 'staff', amount: 50, unique_reference: ref(ap.projectId, `inj-${label.replace(/\W+/g, '')}`) }));
    const fired = inject === null;
    inject = null;
    expect(!!rr.error && fired && show(await snap(ap.projectId, [payee, ap.owner])) === show(before),
      `4h: ${label}: payroll failed and fully rolled back`, `fired=${fired} err=${rr.error || 'none'}`);
  }
  const rcEnd = await recon(ap.projectId);
  expect(reconciles(rcEnd), '4h: reconciliation still holds after all injected failures', show(rcEnd));

  // 4i. HTTP: the route returns the refusal.
  const request = require('supertest');
  const tok = await tokenFor(y.owner);
  const h = await request(httpApp()).post(`/api/v1/projects/${y.projectId}/payroll`).set('Authorization', `Bearer ${tok}`)
    .send({ payee_user_id: acc, role: 'staff', amount: 900, unique_reference: ref(y.projectId, 'http') });
  expect(h.status === 409 && (await wallet(acc)) === 0, '4i: POST /projects/:id/payroll on DRAFT -> 409, nothing paid', `${h.status} ${show(h.body)}`);
}

async function testDistribution(xProject) {
  section('5. F7b: legacy profit distribution without revenue evidence is refused');
  const inv = xProject.investor;
  const b = await snap(xProject.projectId, [inv, xProject.owner]);
  const r = await safe(() => projectService.computeDistribution(xProject.owner, xProject.projectId, { gross_profit: 5000, period_label: 'F7' }));
  expect(r.err && r.err.statusCode === 409 && r.err.code === 'PROJECT_DISTRIBUTION_UNSUPPORTED', '5a: computeDistribution refused (409)', r.error || show(r.value));
  expect(show(await snap(xProject.projectId, [inv, xProject.owner])) === show(b), '5a: nothing paid or written (wallets, distributions, reserves, journal)', '');
  const stranger = await makeUser('stranger');
  const r2s = await safe(() => projectService.computeDistribution(stranger, xProject.projectId, { gross_profit: 5000 }));
  expect(r2s.err && r2s.err.statusCode === 403, '5b: non-owner refused (403)', r2s.error);
  const request = require('supertest');
  const tok = await tokenFor(xProject.owner);
  const h = await request(httpApp()).post(`/api/v1/projects/${xProject.projectId}/distribution`).set('Authorization', `Bearer ${tok}`)
    .send({ gross_profit: 5000, period_label: 'F7' });
  expect(h.status === 409 && show(await snap(xProject.projectId, [inv, xProject.owner])) === show(b), '5c: POST /projects/:id/distribution -> 409, nothing paid', `${h.status} ${show(h.body)}`);
}

async function testReconciliationAll() {
  section('6. Reconciliation of every project in this run (deliberately drifted legacy seeds excluded)');
  const bad2 = [];
  let n = 0;
  for (const pid of allProjects) {
    if (seededDrift.has(pid)) continue;
    const rc = await recon(pid);
    if (rc.project === 'COMPLETED') continue; // completion returns escrow through its own settlement references
    n++;
    if (!reconciles(rc) || (rc.project !== 'CANCELLED' && rc.raised !== rc.confirmed)) bad2.push({ pid, ...rc });
  }
  expect(n > 0 && bad2.length === 0, `6: ${n} projects: paid_in - refunded - disbursed - payroll = escrow = ledger; raised = CONFIRMED`, show(bad2));
  const neg = (await pool.query('SELECT COUNT(*)::int c FROM controlled_project_accounts WHERE remaining_balance < 0')).rows[0].c;
  expect(neg === 0, '6: no escrow row has a negative remaining_balance', neg);
}

async function testStatic() {
  section('7. Static');
  const ps = fs.readFileSync(PROJECT_FILE, 'utf8');
  const fsrc = fs.readFileSync(FINANCE_FILE, 'utf8');
  const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  expect(!/GREATEST\s*\(/i.test(code(ps)) && !/GREATEST\s*\(/i.test(code(fsrc)), 'no GREATEST( in projectService / projectFinanceService code', '');
  const fnOf = (src, name) => { const i = src.indexOf(`async function ${name}(`); return src.slice(i, src.indexOf('\nasync function', i + 10)); };
  const ex = fnOf(fsrc, 'executeDisbursement');
  expect(ex.indexOf('FROM projects WHERE id = $1 FOR UPDATE') > 0 && ex.indexOf('FROM projects WHERE id = $1 FOR UPDATE') < ex.indexOf('FROM project_disbursements'),
    'executeDisbursement: project lock before the request lock', '');
  const pay = fnOf(ps, 'recordPayroll');
  const iP = pay.indexOf('FROM projects WHERE id = $1 FOR UPDATE');
  const iU = pay.indexOf('FROM users WHERE id = $1 FOR UPDATE');
  const iE = pay.indexOf('UPDATE controlled_project_accounts');
  const iC = pay.indexOf('creditWallet(');
  expect(iP > 0 && iU > iP && iE > iU && iC > iE, 'recordPayroll: project lock -> payee lock -> escrow decrement -> wallet credit', `${iP}/${iU}/${iE}/${iC}`);
  const dist = fnOf(ps, 'computeDistribution');
  expect(!/creditWallet|INSERT INTO|UPDATE /.test(dist), 'computeDistribution: moves no money and writes nothing', '');
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port`);
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);
    people.admin = await makeUser('admin', 'ADMIN');
    const silenced = console.error;
    console.error = () => {};
    try {
      // Project X: FUNDING, investor money in the shared PROJECT_INVESTMENT_ACCOUNT.
      const x = await makeProject();
      x.investor = await makeUser('X investor', null, 1000);
      await invest(x.investor, x.projectId, 1000, 'x');
      for (const t of [testDisbursementRequiresActive, testRefundInsufficientEscrow, testConcurrency,
        () => testPayroll(x), () => testDistribution(x), testReconciliationAll, testStatic]) {
        const res = await safe(t);
        if (res.error) bad(`${t.name || 'step'} aborted`, res.error);
        inject = null;
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
