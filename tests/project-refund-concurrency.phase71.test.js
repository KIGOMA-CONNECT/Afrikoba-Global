#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step E0b: investment refund concurrency
 *   forceCloseFunding (action REFUND)  src/services/projectFinanceService.js
 *   refundInvestment                   src/services/projectService.js
 *
 *  a.  Two PARALLEL forceCloseFunding REFUND calls on one project: each
 *      investor refunded exactly once.
 *  b.  Two PARALLEL refundInvestment calls for one investment: refunded once.
 *  c1. refundInvestment (held before COMMIT) vs forceCloseFunding, same
 *      EXPIRED project: each investor refunded once.
 *  c2. forceCloseFunding (held before COMMIT) vs refundInvestment: same.
 *  d.  A real lock wait over the production lock_timeout (3 s) on both paths,
 *      and forced 40P01 / 55P03 at the credit stage: ValidityError 409
 *      FUNDING_REFUND_IN_PROGRESS, logger.warn with stage, nothing refunded;
 *      a non-mapped code (40001) propagates as-is.
 *  e.  Row count of the CONFIRMED -> REFUNDED update differs from 1 ->
 *      409 FUNDING_REFUND_STATE_CHANGED and full rollback (both paths).
 *  f.  HTTP: real routes + i18n + errorHandler via supertest: status, full
 *      body, code reaches the client (both paths, both 409 codes).
 *  g.  Every case checks, per investor: wallet balance, CREDIT operations,
 *      journal rows, transactions PROJECT_REFUND, investment status and
 *      refund_reference; and the project status / amount_raised / escrow.
 *  h.  Another writer holding one investment row (without the project lock)
 *      and cancelling it: that investment is not refunded.
 *  i.  Deadlock, deterministic: two refunds on different projects sharing an
 *      investor, barrier at creditWallet FOR UPDATE (both paths).
 *  k.  refundInvestment audit: one audit_logs PROJECT_REFUND row per refund,
 *      a single call under 1000 ms, and a forced audit failure rolls the whole
 *      refund back (audit written on the refund's own client).
 *  s.  Static: lock order project -> investments ORDER BY id -> users
 *      ORDER BY id, status re-checked under lock, rowCount checked, mapping.
 *
 * Real synchronisation: call1 is held just before its COMMIT (after it
 * refunded inside its open transaction) until a backend blocked by call1 is
 * seen in pg_stat_activity (pg_blocking_pids), or GATE_LIMIT_MS passes.
 * axios is stubbed: no real network. Run with a connection logger preload.
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix>.
 * Usage:
 *   DB_NAME=phase71_financial_audit_<suffix> DB_USER=... DB_PASSWORD=... \
 *     node tests/project-refund-concurrency.phase71.test.js [--only=a,b,...]
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
  console.log('\nWATCHDOG: test process exceeded 240 s; exiting with failure.');
  process.exit(1);
}, 240000).unref();

require('axios');
const axiosPath = require.resolve('axios');
const httpCalls = [];
require.cache[axiosPath].exports = {
  post: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.post not expected'); },
  get: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.get not expected'); },
};

const pool = require('../src/config/db');
const projectFinance = require('../src/services/projectFinanceService');
const projectService = require('../src/services/projectService');

const FINANCE_FILE = path.join(__dirname, '..', 'src', 'services', 'projectFinanceService.js');
const PROJECT_FILE = path.join(__dirname, '..', 'src', 'services', 'projectService.js');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function progress(msg) { console.log(`  · ${msg}`); }
const r2 = (n) => Math.round(Number(n) * 100) / 100;

const BUSY_MESSAGE = 'Urejeshaji wa uwekezaji haukukamilika kwa sababu ya shughuli nyingine zinazoendelea. Hakuna kilichorejeshwa. Jaribu tena baadaye.';
const CHANGED_MESSAGE = 'Hali ya uwekezaji imebadilika wakati wa kurejesha; hakuna kilichorejeshwa, jaribu tena.';
const FC_STATUS_MESSAGE = 'Urefu wa urejeshaji unaruhusu hali ya FUNDING/PUBLISHED/EXPIRED tu.';
const RI_NOT_EXPIRED = 'Mradi haujaexpira; not yet eligible for refund.';

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label, role) {
  seq += 1;
  const phone = `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const u = await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71E0b ${label} ${tag} ${seq}`, phone]
  );
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, u.rows[0].id]);
  return u.rows[0].id;
}
// investments: [[investorId, amount], ...] -> returns investment ids (same order)
async function makeFundedProject(status, investments) {
  const owner = await makeUser('owner');
  const total = r2(investments.reduce((s, [, a]) => s + a, 0));
  const p = (await pool.query(
    `INSERT INTO projects (owner_user_id, name, status, capital_required, amount_raised)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [owner, `P71E0b project ${tag} ${++seq}`, status, total * 4, total])).rows[0].id;
  await pool.query(
    `INSERT INTO controlled_project_accounts (project_id, remaining_balance, escrow_balance, status)
     VALUES ($1, $2, $2, 'ACTIVE')`, [p, total]);
  const ids = [];
  for (const [inv, amt] of investments) {
    ids.push((await pool.query(
      `INSERT INTO project_investments (project_id, investor_user_id, amount, status, unique_reference)
       VALUES ($1, $2, $3, 'CONFIRMED', $4) RETURNING id`,
      [p, inv, amt, `P71E0b-${tag}-${p}-u${inv}-${++seq}`])).rows[0].id);
  }
  return { projectId: p, owner, total, investmentIds: ids };
}

// Per-investor refund evidence (users are fresh per case, so per-user counts
// are exact) + investment and project state.
async function snapshot(projectId, investors, investmentIds) {
  const s = { wallets: {}, credits: {}, creditRefs: {}, journal: {}, refundTxns: {}, inv: {} };
  for (const id of investors) {
    s.wallets[id] = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [id])).rows[0].wallet_balance);
    const ops = (await pool.query(
      `SELECT reference_id FROM financial_operations
        WHERE user_id = $1 AND operation_type = 'CREDIT' AND status = 'SUCCESS' AND reference_id LIKE 'PREF-%'
        ORDER BY id`, [id])).rows.map((r) => r.reference_id);
    s.credits[id] = ops.length;
    s.creditRefs[id] = ops;
    s.journal[id] = ops.length === 0 ? 0 : (await pool.query(
      'SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id = ANY($1::text[])', [ops])).rows[0].c;
    s.refundTxns[id] = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'PROJECT_REFUND'`, [id])).rows[0].c;
  }
  for (const iid of investmentIds) {
    s.inv[iid] = (await pool.query(
      'SELECT status, refund_reference, investor_user_id FROM project_investments WHERE id = $1', [iid])).rows[0];
  }
  s.project = (await pool.query('SELECT status, amount_raised FROM projects WHERE id = $1', [projectId])).rows[0];
  s.project.amount_raised = Number(s.project.amount_raised);
  s.escrow = (await pool.query(
    'SELECT remaining_balance, status FROM controlled_project_accounts WHERE project_id = $1', [projectId])).rows[0];
  s.escrow.remaining_balance = Number(s.escrow.remaining_balance);
  s.notes = {};
  for (const id of investors) {
    s.notes[id] = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND title = 'Uwekezaji umerudishwa'`, [id])).rows[0].c;
  }
  return s;
}
function show(label, s, investors) {
  const w = investors.map((id) => `${id}:w=${s.wallets[id]} cr=${s.credits[id]} j=${s.journal[id]} tx=${s.refundTxns[id]}`).join(' ');
  const i = Object.entries(s.inv).map(([k, v]) => `${k}=${v.status}`).join(',');
  progress(`${label}: ${w} | inv ${i} | project ${s.project.status} raised=${s.project.amount_raised} escrow=${s.escrow.remaining_balance}/${s.escrow.status}`);
}
// Each investor refunded exactly once: wallet +amount, 1 CREDIT, 1 journal
// pair, 1 PROJECT_REFUND transaction, investment REFUNDED and its
// refund_reference equal to the single credit reference (not overwritten).
function expectRefundedOnce(tagLabel, before, after, rows) {
  for (const { investor, amount, investmentId } of rows) {
    const d = r2(after.wallets[investor] - before.wallets[investor]);
    expect(d === amount, `${tagLabel}: investor ${investor} wallet +${amount} exactly once`, `delta=${d}`);
    expect(after.credits[investor] - before.credits[investor] === 1, `${tagLabel}: investor ${investor} has exactly 1 CREDIT operation`, after.credits[investor] - before.credits[investor]);
    expect(after.journal[investor] - before.journal[investor] === 2, `${tagLabel}: investor ${investor} has exactly 1 DR/CR journal pair`, after.journal[investor] - before.journal[investor]);
    expect(after.refundTxns[investor] - before.refundTxns[investor] === 1, `${tagLabel}: investor ${investor} has exactly 1 PROJECT_REFUND transaction`, after.refundTxns[investor] - before.refundTxns[investor]);
    const inv = after.inv[investmentId];
    expect(inv.status === 'REFUNDED', `${tagLabel}: investment ${investmentId} REFUNDED`, inv.status);
    expect(after.creditRefs[investor].length === 1 && inv.refund_reference === after.creditRefs[investor][0],
      `${tagLabel}: investment ${investmentId} refund_reference = the single credit reference (not overwritten)`,
      `${inv.refund_reference} vs ${JSON.stringify(after.creditRefs[investor])}`);
  }
}
function expectNothingRefunded(tagLabel, before, after, investors, investmentIds) {
  const moved = investors.filter((id) => after.wallets[id] !== before.wallets[id] || after.credits[id] !== before.credits[id]
    || after.journal[id] !== before.journal[id] || after.refundTxns[id] !== before.refundTxns[id]);
  expect(moved.length === 0, `${tagLabel}: no wallet, CREDIT, journal or PROJECT_REFUND change`, JSON.stringify(moved));
  const changed = investmentIds.filter((iid) => after.inv[iid].status !== before.inv[iid].status || after.inv[iid].refund_reference !== before.inv[iid].refund_reference);
  expect(changed.length === 0, `${tagLabel}: investments unchanged (still CONFIRMED, no refund_reference)`, JSON.stringify(changed));
  expect(after.project.status === before.project.status && after.project.amount_raised === before.project.amount_raised
    && after.escrow.remaining_balance === before.escrow.remaining_balance && after.escrow.status === before.escrow.status,
  `${tagLabel}: project status, amount_raised and escrow unchanged`,
  `${before.project.status}/${before.project.amount_raised}/${before.escrow.remaining_balance} -> ${after.project.status}/${after.project.amount_raised}/${after.escrow.remaining_balance}`);
}

// ---- pool interception (same approach as the E0 suite) ----------------------
// Production pool settings kept (lock_timeout 3000 ms, idle-in-transaction
// 8000 ms); only statement_timeout tightened to 15 s. Raw client patched once
// (no Proxy: src/config/db.js rebinds client.query).
const STATEMENT_TIMEOUT = '15s';
const clientErrors = [];
const realPool = pool._getPool();
let hook = null;
let afterHook = null;
function instrument(c) {
  if (c.__p71Instrumented) return c;
  c.__p71Instrumented = true;
  const orig = c.query.bind(c);
  c.__p71Orig = orig;
  c.query = function (...args) {
    if (typeof args[args.length - 1] === 'function' || (!hook && !afterHook)) return orig(...args);
    const text = args[0];
    const sql = typeof text === 'string' ? text : (text && text.text) || '';
    return (async () => {
      if (hook) await hook(c, sql);
      try {
        const res = await orig(...args);
        if (afterHook) afterHook(c, sql, res);
        return res;
      } catch (e) {
        if (afterHook) afterHook(c, sql, e);
        throw e;
      }
    })();
  };
  return c;
}
const interceptingPool = new Proxy(realPool, {
  get(t, p) {
    if (p === 'connect') {
      return async (...a) => {
        const c = await t.connect(...a);
        instrument(c);
        if (!c.__p71ErrorListener) {
          c.__p71ErrorListener = true;
          c.on('error', (e) => clientErrors.push(`${e.code || ''} ${e.message}`));
        }
        await c.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
        return c;
      };
    }
    const v = t[p];
    return typeof v === 'function' ? v.bind(t) : v;
  },
});

let diag = null;
async function diagClient() {
  if (diag) return diag;
  const { Client } = require('pg');
  diag = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  diag.on('error', (e) => clientErrors.push(`diag ${e.code || ''} ${e.message}`));
  await diag.connect();
  await diag.query(`SET statement_timeout = '5s'`);
  return diag;
}
// Another connection holding row locks (the "other writer" in section h).
async function writerClient() {
  const { Client } = require('pg');
  const w = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  w.on('error', (e) => clientErrors.push(`writer ${e.code || ''} ${e.message}`));
  await w.connect();
  await w.query(`SET statement_timeout = '10s'`);
  return w;
}
// A backend of this database blocked by `pid` (pg_blocking_pids). Excludes
// the fire-and-forget notification inserts of forceCloseFunding's loop: their
// FK check (KEY SHARE on users) waits on the refund's own users lock.
async function backendBlockedBy(pid) {
  const d = await diagClient();
  const r = await d.query(
    `SELECT pid, wait_event, left(regexp_replace(query, '\\s+', ' ', 'g'), 80) AS q
       FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))
        AND query NOT ILIKE '%INSERT INTO notifications%'`, [pid]);
  return r.rows[0] || null;
}
async function dumpWaits(title) {
  try {
    const d = await diagClient();
    const act = await d.query(
      `SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
              left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS query
         FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY pid`);
    console.log(`  [diag] ${title}`);
    for (const r of act.rows) console.log(`    pid=${r.pid} state=${r.state} wait=${r.wait_event_type || '-'}/${r.wait_event || '-'} blocked_by=${JSON.stringify(r.blocked_by)} q=${r.query}`);
  } catch (e) {
    console.log(`  [diag] ${title}: diagnostics failed: ${e.message}`);
  }
}

const GATE_LIMIT_MS = 2500; // fallback release; below the 3 s lock_timeout
const SECTION_LIMIT_MS = 30000;
const ADMIN_ROLE = 'ADMIN';
const isInvestmentUpdate = (sql) => /^\s*UPDATE\s+project_investments\s+SET\s+refund_reference/i.test(sql);

// call1 is held just before COMMIT, once it has run the refund UPDATE on
// project_investments in its transaction. call2 starts then; the gate opens
// when a backend blocked by call1 is seen (or GATE_LIMIT_MS / holdMs pass).
async function raceHeld(name, call1, call2, { holdMs = null } = {}) {
  let call1Client = null;
  let gateReached;
  const reached = new Promise((r) => { gateReached = r; });
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const touched = new WeakSet();
  let held = false;
  hook = async (client, sql) => {
    if (isInvestmentUpdate(sql) && !call1Client) call1Client = client;
    if (isInvestmentUpdate(sql)) touched.add(client);
    if (!held && client === call1Client && touched.has(client) && /^\s*COMMIT\b/i.test(sql)) {
      held = true;
      progress(`${name}: call1 held before COMMIT (pid ${client.processID})`);
      gateReached();
      await gate;
    }
  };
  pool._setPool(interceptingPool);
  let res1;
  let res2;
  let reason = 'not reached';
  let call2Ms = 0;
  let timer;
  let timedOut = false;
  try {
    const work = (async () => {
      const p1 = safe(call1);
      const first = await Promise.race([reached.then(() => 'gate'), p1.then(() => 'done')]);
      expect(first === 'gate', `${name}: call1 held before COMMIT after refunding in its transaction`, first);
      const t0 = Date.now();
      const p2 = safe(call2).then((r) => { call2Ms = Date.now() - t0; return r; });
      if (holdMs !== null) {
        res2 = await Promise.race([p2, sleep(holdMs).then(() => null)]);
        reason = res2 ? `call2 returned after ${call2Ms} ms while call1 was held` : `held ${holdMs} ms`;
        if (!res2) {
          const w = call1Client && await backendBlockedBy(call1Client.processID);
          reason += w ? ` (call2 pid ${w.pid} still blocked: ${w.wait_event})` : '';
        }
      } else {
        while (Date.now() - t0 < GATE_LIMIT_MS) {
          const w = call1Client && await backendBlockedBy(call1Client.processID);
          if (w) { reason = `call2 (pid ${w.pid}) blocked by call1 on ${w.wait_event}: ${w.q}`; break; }
          const done2 = await Promise.race([p2.then(() => true), sleep(25).then(() => false)]);
          if (done2) { reason = 'call2 finished while call1 was held'; break; }
        }
        if (reason === 'not reached') reason = `gate limit ${GATE_LIMIT_MS} ms elapsed`;
      }
      progress(`${name}: ${reason}; gate released`);
      releaseGate();
      res1 = await p1;
      res2 = res2 || await p2;
    })();
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), SECTION_LIMIT_MS); });
    if (await Promise.race([work.then(() => 'done'), limit]) === 'timeout') {
      timedOut = true;
      await dumpWaits(`${name}: section limit reached`);
    }
  } finally {
    clearTimeout(timer);
    releaseGate();
    hook = null;
    pool._setPool(realPool);
  }
  if (timedOut) { bad(`${name}: timed out`); throw new Error('SECTION_TIMEOUT'); }
  // A supertest response is printed as status + body only (never headers or tokens).
  const fmt = (r) => (r.error ? `${r.err.statusCode || '-'} ${r.err.code || '-'} ${r.error}`
    : (r.value && r.value.status !== undefined && r.value.body !== undefined ? `HTTP ${r.value.status} ${JSON.stringify(r.value.body)}` : JSON.stringify(r.value)));
  progress(`${name}: call1 -> ${fmt(res1)}`);
  progress(`${name}: call2 -> ${fmt(res2)} (after ${call2Ms} ms)`);
  return { res1, res2, reason, call2Ms };
}
const forceRefund = (adminId, projectId) => () => projectFinance.forceCloseFunding(adminId, ADMIN_ROLE, projectId, { action: 'REFUND' });
const refundInv = (projectId, investmentId, investorId) => () => projectService.refundInvestment(projectId, investmentId, investorId);
function captureWarns() {
  const logger = require('../src/utils/logger');
  const real = logger.warn;
  const realError = logger.error;
  const warns = [];
  const errors = [];
  logger.warn = (scope, msg, meta) => { warns.push({ scope, msg: String(msg), meta }); };
  logger.error = (scope, msg) => { errors.push(`${scope}: ${msg}`); };
  return { warns, errors, restore: () => { logger.warn = real; logger.error = realError; } };
}
async function auditRows(investmentId) {
  return (await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'PROJECT_REFUND' AND entity_type = 'PROJECT_INVESTMENT' AND entity_id = $1`,
    [investmentId])).rows[0].c;
}

// ---------------------------------------------------------------------------
async function testForceCloseTwice() {
  section('a. Two parallel forceCloseFunding REFUND calls on one project');
  const admin = await makeUser('admin', 'ADMIN');
  const [x, y, z] = [await makeUser('x'), await makeUser('y'), await makeUser('z')];
  const pr = await makeFundedProject('FUNDING', [[x, 100], [y, 250.5], [z, 40]]);
  const rows = [{ investor: x, amount: 100 }, { investor: y, amount: 250.5 }, { investor: z, amount: 40 }]
    .map((r, k) => ({ ...r, investmentId: pr.investmentIds[k] }));
  const before = await snapshot(pr.projectId, [x, y, z], pr.investmentIds);
  show('before', before, [x, y, z]);
  const { res1, res2 } = await raceHeld('a', forceRefund(admin, pr.projectId), forceRefund(admin, pr.projectId));
  const after = await snapshot(pr.projectId, [x, y, z], pr.investmentIds);
  show('after ', after, [x, y, z]);
  expectRefundedOnce('a', before, after, rows);
  expect(after.project.status === 'CANCELLED' && after.project.amount_raised === 0, 'a: project CANCELLED, amount_raised 0', JSON.stringify(after.project));
  expect(after.escrow.remaining_balance === 0 && after.escrow.status === 'CLOSED', 'a: escrow 0 and CLOSED', JSON.stringify(after.escrow));
  expect(!res1.error && res1.value.refunded_count === 3, 'a: call1 refunds 3 investments', res1.error || JSON.stringify(res1.value));
  expect(!!res2.error && res2.err.statusCode === 400 && res2.error === FC_STATUS_MESSAGE,
    'a: call2 refuses with the existing 400 status message (project no longer refundable), refunds nothing',
    res2.error ? `${res2.err.statusCode} ${res2.err.code} ${res2.error}` : JSON.stringify(res2.value));
}

async function testRefundInvestmentTwice() {
  section('b. Two parallel refundInvestment calls for one investment');
  const x = await makeUser('x');
  const y = await makeUser('y');
  const pr = await makeFundedProject('EXPIRED', [[x, 300], [y, 80]]);
  const [ix] = pr.investmentIds;
  const before = await snapshot(pr.projectId, [x, y], pr.investmentIds);
  show('before', before, [x, y]);
  const { res1, res2 } = await raceHeld('b', refundInv(pr.projectId, ix, x), refundInv(pr.projectId, ix, x));
  const after = await snapshot(pr.projectId, [x, y], pr.investmentIds);
  show('after ', after, [x, y]);
  expectRefundedOnce('b', before, after, [{ investor: x, amount: 300, investmentId: ix }]);
  expect(after.wallets[y] === before.wallets[y] && after.inv[pr.investmentIds[1]].status === 'CONFIRMED', 'b: the other investor untouched');
  expect(after.project.status === 'EXPIRED' && after.project.amount_raised === r2(pr.total - 300),
    'b: project still EXPIRED, amount_raised reduced by 300 once', JSON.stringify(after.project));
  expect(after.escrow.remaining_balance === r2(pr.total - 300), 'b: escrow reduced by 300 once', after.escrow.remaining_balance);
  expect(!res1.error && res1.value.amount === 300, 'b: call1 refunds 300', res1.error || JSON.stringify(res1.value));
  const audits = await auditRows(ix);
  expect(audits === 1, 'b: exactly one audit_logs PROJECT_REFUND row for the investment', audits);
  expect(!!res2.error && res2.err.statusCode === 400 && res2.error === 'Hali ya uwekezaji (REFUNDED) hairuhusu kurejeshwa.',
    'b: call2 refuses with the existing 400 status message, refunds nothing',
    res2.error ? `${res2.err.statusCode} ${res2.err.code} ${res2.error}` : JSON.stringify(res2.value));
}

async function testRefundThenForceClose() {
  section('c1. refundInvestment (held) vs forceCloseFunding, same EXPIRED project');
  const admin = await makeUser('admin', 'ADMIN');
  const x = await makeUser('x');
  const y = await makeUser('y');
  const pr = await makeFundedProject('EXPIRED', [[x, 300], [y, 120]]);
  const [ix, iy] = pr.investmentIds;
  const before = await snapshot(pr.projectId, [x, y], pr.investmentIds);
  show('before', before, [x, y]);
  const { res1, res2 } = await raceHeld('c1', refundInv(pr.projectId, ix, x), forceRefund(admin, pr.projectId));
  const after = await snapshot(pr.projectId, [x, y], pr.investmentIds);
  show('after ', after, [x, y]);
  expectRefundedOnce('c1', before, after, [{ investor: x, amount: 300, investmentId: ix }, { investor: y, amount: 120, investmentId: iy }]);
  expect(after.project.status === 'CANCELLED', 'c1: project CANCELLED', after.project.status);
  expect(!res1.error && res1.value.amount === 300, 'c1: refundInvestment refunds 300', res1.error || JSON.stringify(res1.value));
  expect(!res2.error && res2.value.refunded_count === 1, 'c1: forceCloseFunding refunds only the remaining investment (1)', res2.error || JSON.stringify(res2.value));
}

async function testForceCloseThenRefund() {
  section('c2. forceCloseFunding (held) vs refundInvestment, same EXPIRED project');
  const admin = await makeUser('admin', 'ADMIN');
  const x = await makeUser('x');
  const y = await makeUser('y');
  const pr = await makeFundedProject('EXPIRED', [[x, 300], [y, 120]]);
  const [ix, iy] = pr.investmentIds;
  const before = await snapshot(pr.projectId, [x, y], pr.investmentIds);
  show('before', before, [x, y]);
  const { res1, res2 } = await raceHeld('c2', forceRefund(admin, pr.projectId), refundInv(pr.projectId, ix, x));
  const after = await snapshot(pr.projectId, [x, y], pr.investmentIds);
  show('after ', after, [x, y]);
  expectRefundedOnce('c2', before, after, [{ investor: x, amount: 300, investmentId: ix }, { investor: y, amount: 120, investmentId: iy }]);
  expect(after.project.status === 'CANCELLED', 'c2: project CANCELLED', after.project.status);
  expect(!res1.error && res1.value.refunded_count === 2, 'c2: forceCloseFunding refunds 2', res1.error || JSON.stringify(res1.value));
  expect(!!res2.error && res2.err.statusCode === 400 && res2.error === RI_NOT_EXPIRED,
    'c2: refundInvestment refuses with the existing 400 message (project no longer EXPIRED), refunds nothing',
    res2.error ? `${res2.err.statusCode} ${res2.err.code} ${res2.error}` : JSON.stringify(res2.value));
}

async function testLockTimeoutBoth() {
  section('d1. Real lock wait > lock_timeout (3 s) on both paths -> 409 FUNDING_REFUND_IN_PROGRESS');
  for (const kind of ['forceCloseFunding', 'refundInvestment']) {
    const admin = await makeUser('admin', 'ADMIN');
    const x = await makeUser('x');
    const pr = await makeFundedProject(kind === 'forceCloseFunding' ? 'FUNDING' : 'EXPIRED', [[x, 70]]);
    const [ix] = pr.investmentIds;
    const call = kind === 'forceCloseFunding' ? forceRefund(admin, pr.projectId) : refundInv(pr.projectId, ix, x);
    const cap = captureWarns();
    let out;
    try {
      out = await raceHeld(`d1 ${kind}`, call, call, { holdMs: 4500 });
    } finally { cap.restore(); }
    const { res1, res2, call2Ms } = out;
    const w = cap.warns.find((m) => m.meta && m.meta.projectId === pr.projectId);
    progress(`d1 ${kind}: logger.warn meta ${w ? JSON.stringify(w.meta) : 'none'}`);
    expect(!!res2.error && res2.err.statusCode === 409 && res2.err.code === 'FUNDING_REFUND_IN_PROGRESS' && res2.error === BUSY_MESSAGE,
      `d1 ${kind}: call2 -> 409 FUNDING_REFUND_IN_PROGRESS with the agreed message (not raw 55P03)`,
      res2.error ? `${res2.err.statusCode} ${res2.err.code} ${res2.error}` : JSON.stringify(res2.value));
    expect(call2Ms >= 2500 && call2Ms < 4500, `d1 ${kind}: call2 waited about the 3 s lock_timeout`, `${call2Ms} ms`);
    expect(!!w && w.meta.code === '55P03' && w.meta.stage === 'project-lock' && w.meta.path === kind,
      `d1 ${kind}: logger.warn code 55P03, stage project-lock, path ${kind}`, w && JSON.stringify(w.meta));
    expect(!res1.error, `d1 ${kind}: call1 refunds`, res1.error);
    const after = await snapshot(pr.projectId, [x], [ix]);
    expect(after.wallets[x] === 70 && after.credits[x] === 1 && after.refundTxns[x] === 1, `d1 ${kind}: investor refunded exactly once (+70)`,
      `w=${after.wallets[x]} cr=${after.credits[x]} tx=${after.refundTxns[x]}`);
    if (kind === 'forceCloseFunding') {
      // Evidence for backlog #25 (not fixed in E0b): call1 was held 4.5 s before
      // COMMIT; its in-loop createNotification (own connection) waits on the
      // investor's users row that call1 holds, hits lock_timeout after 3 s and
      // the "refunded" notification is lost although the refund committed.
      await sleep(300);
      const notes = (await snapshot(pr.projectId, [x], [ix])).notes[x];
      const notifErr = cap.errors.filter((m) => /NOTIFICATION/.test(m));
      progress(`d1 forceCloseFunding [#25 evidence]: refund committed, "refunded" notifications for the investor: ${notes}; logger.error: ${JSON.stringify(notifErr)}`);
    }
  }
}

// Forced error on the Nth `INSERT INTO financial_operations` (creditWallet's claim).
async function forcedAtCredit(kind, code, nth) {
  const admin = await makeUser('admin', 'ADMIN');
  const x = await makeUser('x');
  const y = await makeUser('y');
  const pr = await makeFundedProject(kind === 'forceCloseFunding' ? 'FUNDING' : 'EXPIRED', [[x, 60], [y, 90]]);
  const [ix] = pr.investmentIds;
  const call = kind === 'forceCloseFunding' ? forceRefund(admin, pr.projectId) : refundInv(pr.projectId, ix, x);
  const before = await snapshot(pr.projectId, [x, y], pr.investmentIds);
  let n = 0;
  hook = async (c, sql) => {
    if (/^\s*INSERT INTO financial_operations/i.test(sql) && ++n === nth) {
      const e = new Error(`TEST: forced ${code}`);
      e.code = code;
      e.table = 'financial_operations';
      e.routine = 'TEST';
      throw e;
    }
  };
  const cap = captureWarns();
  pool._setPool(interceptingPool);
  let r;
  try {
    r = await safe(call);
  } finally { hook = null; pool._setPool(realPool); cap.restore(); }
  const after = await snapshot(pr.projectId, [x, y], pr.investmentIds);
  const w = cap.warns.find((m) => m.meta && m.meta.projectId === pr.projectId);
  return { r, before, after, w, pr, x, y };
}

async function testForcedErrors() {
  section('d2. Forced 40P01 / 55P03 at stage "credit" -> 409, logged, full rollback; 40001 not mapped');
  const cases = [['forceCloseFunding', '40P01', 2], ['refundInvestment', '55P03', 1]];
  for (const [kind, code, nth] of cases) {
    const { r, before, after, w, pr, x, y } = await forcedAtCredit(kind, code, nth);
    progress(`d2 ${kind} ${code}: ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value)}; warn ${w ? JSON.stringify(w.meta) : 'none'}`);
    expect(!!r.error && r.err.statusCode === 409 && r.err.code === 'FUNDING_REFUND_IN_PROGRESS' && r.error === BUSY_MESSAGE,
      `d2 ${kind}: forced ${code} -> 409 FUNDING_REFUND_IN_PROGRESS`, r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value));
    expect(!!w && w.meta.code === code && w.meta.stage === 'credit' && w.meta.table === 'financial_operations' && w.meta.routine === 'TEST',
      `d2 ${kind}: logger.warn code ${code}, stage credit, table, routine`, w && JSON.stringify(w.meta));
    expectNothingRefunded(`d2 ${kind}`, before, after, [x, y], pr.investmentIds);
    const sent = (after.notes[x] - before.notes[x]) + (after.notes[y] - before.notes[y]);
    progress(`d2 ${kind}: "refunded" notifications sent although rolled back: ${sent} (backlog #25, not fixed in E0b)`);
  }
  const { r } = await forcedAtCredit('forceCloseFunding', '40001', 1);
  expect(!!r.err && r.err.code === '40001' && r.err.statusCode === undefined, 'd2: 40001 propagates unchanged (not mapped)',
    r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value));
}

async function testRowCountGuard() {
  section('e. CONFIRMED -> REFUNDED update changes 0 rows -> 409 FUNDING_REFUND_STATE_CHANGED, full rollback');
  for (const kind of ['forceCloseFunding', 'refundInvestment']) {
    const admin = await makeUser('admin', 'ADMIN');
    const x = await makeUser('x');
    const y = await makeUser('y');
    const pr = await makeFundedProject(kind === 'forceCloseFunding' ? 'FUNDING' : 'EXPIRED', [[x, 50], [y, 75]]);
    const target = kind === 'forceCloseFunding' ? pr.investmentIds[1] : pr.investmentIds[0];
    const call = kind === 'forceCloseFunding' ? forceRefund(admin, pr.projectId) : refundInv(pr.projectId, pr.investmentIds[0], x);
    const before = await snapshot(pr.projectId, [x, y], pr.investmentIds);
    // Inside the payout's own transaction (it holds the row lock), flip the
    // target investment away from CONFIRMED right before its refund UPDATE.
    // forceCloseFunding: the 2nd refund UPDATE (so the 1st investor was already
    // credited and must be rolled back); refundInvestment: its only UPDATE.
    // __p71Orig runs on the same connection without re-entering the hook.
    const injectAt = kind === 'forceCloseFunding' ? 2 : 1;
    let seen = 0;
    let injected = false;
    hook = async (c, sql) => {
      if (!injected && isInvestmentUpdate(sql) && ++seen === injectAt) {
        injected = true;
        await c.__p71Orig(`UPDATE project_investments SET status = 'CANCELLED' WHERE id = $1`, [target]);
        progress(`e ${kind}: investment ${target} flipped CONFIRMED -> CANCELLED in the same transaction before its refund UPDATE`);
      }
    };
    pool._setPool(interceptingPool);
    let r;
    try {
      r = await safe(call);
    } finally { hook = null; pool._setPool(realPool); }
    const after = await snapshot(pr.projectId, [x, y], pr.investmentIds);
    progress(`e ${kind}: ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value)}`);
    expect(injected, `e ${kind}: mismatch injected`);
    expect(!!r.error && r.err.statusCode === 409 && r.err.code === 'FUNDING_REFUND_STATE_CHANGED' && r.error === CHANGED_MESSAGE,
      `e ${kind}: 409 FUNDING_REFUND_STATE_CHANGED`, r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value));
    expectNothingRefunded(`e ${kind}`, before, after, [x, y], pr.investmentIds);
  }
}

// h. Another writer (no project lock) holds one investment row and cancels it.
async function testOtherWriter() {
  section('h. Another writer holds an investment row and cancels it: that investment is not refunded');
  for (const kind of ['forceCloseFunding', 'refundInvestment']) {
    const admin = await makeUser('admin', 'ADMIN');
    const [x, y, z] = [await makeUser('x'), await makeUser('y'), await makeUser('z')];
    const pr = await makeFundedProject(kind === 'forceCloseFunding' ? 'FUNDING' : 'EXPIRED', [[x, 10], [y, 20], [z, 30]]);
    const [ix, iy, iz] = pr.investmentIds;
    const target = kind === 'forceCloseFunding' ? iy : ix;
    const call = kind === 'forceCloseFunding' ? forceRefund(admin, pr.projectId) : refundInv(pr.projectId, ix, x);
    const before = await snapshot(pr.projectId, [x, y, z], pr.investmentIds);
    const w = await writerClient();
    let r;
    let reason = 'not seen';
    try {
      await w.query('BEGIN');
      await w.query('SELECT id FROM project_investments WHERE id = $1 FOR UPDATE', [target]);
      const wpid = (await w.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const p = safe(call);
      const t0 = Date.now();
      while (Date.now() - t0 < 2000) {
        const b = await backendBlockedBy(wpid);
        if (b) { reason = `refund blocked by the writer on ${b.wait_event}: ${b.q}`; break; }
        if (await Promise.race([p.then(() => true), sleep(25).then(() => false)])) { reason = 'refund finished first'; break; }
      }
      progress(`h ${kind}: ${reason}`);
      await w.query(`UPDATE project_investments SET status = 'CANCELLED' WHERE id = $1`, [target]);
      await w.query('COMMIT');
      r = await p;
    } finally {
      await w.query('ROLLBACK').catch(() => {});
      await w.end().catch(() => {});
    }
    const after = await snapshot(pr.projectId, [x, y, z], pr.investmentIds);
    progress(`h ${kind}: ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value)}`);
    show('after ', after, [x, y, z]);
    const victim = kind === 'forceCloseFunding' ? y : x;
    expect(after.wallets[victim] === before.wallets[victim] && after.credits[victim] === 0 && after.inv[target].status === 'CANCELLED',
      `h ${kind}: the cancelled investment ${target} is NOT refunded (wallet, CREDIT unchanged; stays CANCELLED)`,
      `w=${after.wallets[victim]} cr=${after.credits[victim]} status=${after.inv[target].status}`);
    if (kind === 'forceCloseFunding') {
      expect(!r.error && r.value.refunded_count === 2, 'h forceCloseFunding: refunds the 2 remaining CONFIRMED investments', r.error || JSON.stringify(r.value));
      expectRefundedOnce('h forceCloseFunding', before, after, [{ investor: x, amount: 10, investmentId: ix }, { investor: z, amount: 30, investmentId: iz }]);
    } else {
      expect(!!r.error && r.err.statusCode === 400 && r.error === 'Hali ya uwekezaji (CANCELLED) hairuhusu kurejeshwa.',
        'h refundInvestment: the existing 400 status message (re-checked under the lock), nothing refunded',
        r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value));
    }
  }
}

// i. Deadlock: two refunds on different projects sharing one investor, held
// at creditWallet's `SELECT wallet_balance ... FOR UPDATE` until both arrive.
async function testDeadlockBarrier() {
  section('i. Deadlock (deterministic): two refunds, different projects, shared investor, barrier at creditWallet FOR UPDATE');
  const BARRIER_MS = 2000;
  for (const kind of ['forceCloseFunding', 'refundInvestment']) {
    const admin = await makeUser('admin', 'ADMIN');
    const inv = await makeUser('shared');
    const pX = await makeFundedProject(kind === 'forceCloseFunding' ? 'FUNDING' : 'EXPIRED', [[inv, 11]]);
    const pY = await makeFundedProject(kind === 'forceCloseFunding' ? 'FUNDING' : 'EXPIRED', [[inv, 22]]);
    const calls = kind === 'forceCloseFunding'
      ? [forceRefund(admin, pX.projectId), forceRefund(admin, pY.projectId)]
      : [refundInv(pX.projectId, pX.investmentIds[0], inv), refundInv(pY.projectId, pY.investmentIds[0], inv)];
    const dl0 = Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
    let arrivals = 0;
    let releaseAll;
    const allArrived = new Promise((r) => { releaseAll = r; });
    let barrierOpen = true;
    let result = 'not reached';
    const seen = new WeakSet();
    hook = async (client, sql) => {
      if (/SELECT wallet_balance FROM users WHERE id = \$1 FOR UPDATE/.test(sql) && !seen.has(client)) {
        seen.add(client);
        if (!barrierOpen) { progress(`i ${kind}: late arrival after the barrier timed out: not counted`); return; }
        arrivals += 1;
        progress(`i ${kind}: barrier arrival ${arrivals} (pid ${client.processID})`);
        if (arrivals >= 2) { result = 'both refunds arrived holding KEY SHARE'; releaseAll(); return; }
        const t = await Promise.race([allArrived.then(() => 'all'), sleep(BARRIER_MS).then(() => 'timeout')]);
        if (t === 'timeout') { barrierOpen = false; result = `only one arrival within ${BARRIER_MS} ms (the other blocked earlier, on the users lock)`; }
      }
    };
    pool._setPool(interceptingPool);
    let res;
    try {
      res = await Promise.all(calls.map((c) => safe(c)));
    } finally { releaseAll(); hook = null; pool._setPool(realPool); }
    progress(`i ${kind}: ${result}`);
    for (const [k, r] of res.entries()) progress(`i ${kind}: call${k + 1} -> ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : 'ok'}`);
    await sleep(1200);
    const dl1 = Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
    const wal = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [inv])).rows[0].wallet_balance);
    expect(arrivals === 1, `i ${kind}: only one refund reached creditWallet while the other was held (users lock serialises them)`, result);
    expect(res.every((r) => !r.error), `i ${kind}: both refunds succeed: no 40P01 and no 409`, res.filter((r) => r.error).map((r) => `${r.err.code} ${r.error}`).join(' | '));
    expect(dl1 === dl0, `i ${kind}: pg_stat_database.deadlocks unchanged`, `${dl0} -> ${dl1}`);
    expect(wal === 33, `i ${kind}: shared investor refunded 11 + 22 = 33, each once`, wal);
  }
}

// k. refundInvestment audit: written on the refund's own client.
async function testRefundAudit() {
  section('k. refundInvestment audit: one audit_logs row, no 3 s self-wait, audit failure rolls the refund back');
  const x = await makeUser('x');
  const pr = await makeFundedProject('EXPIRED', [[x, 25]]);
  const [ix] = pr.investmentIds;
  const cap = captureWarns();
  const t0 = Date.now();
  let r;
  try { r = await safe(refundInv(pr.projectId, ix, x)); } finally { cap.restore(); }
  const ms = Date.now() - t0;
  progress(`k: one refundInvestment took ${ms} ms -> ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value)}; logger.error ${JSON.stringify(cap.errors)}`);
  expect(!r.error && r.value.amount === 25, 'k: refund succeeds', r.error);
  expect(ms < 1000, 'k: a single refundInvestment takes under 1000 ms (no lock_timeout wait for the audit)', `${ms} ms`);
  const a = await auditRows(ix);
  expect(a === 1, 'k: exactly one audit_logs PROJECT_REFUND row for the investment', a);
  expect(!cap.errors.some((m) => /AUDIT_LOG_FAILURE/.test(m)), 'k: no AUDIT_LOG_FAILURE logged', JSON.stringify(cap.errors));

  // Forced audit failure: the whole refund is rolled back, no money moves.
  const y = await makeUser('y');
  const pr2 = await makeFundedProject('EXPIRED', [[y, 35]]);
  const [iy] = pr2.investmentIds;
  const before = await snapshot(pr2.projectId, [y], [iy]);
  let fired = false;
  hook = async (c, sql) => {
    if (/^\s*INSERT INTO audit_logs/i.test(sql)) {
      fired = true;
      const e = new Error('TEST: forced audit_logs failure');
      e.code = '23514';
      throw e;
    }
  };
  const cap2 = captureWarns();
  pool._setPool(interceptingPool);
  let r2;
  try { r2 = await safe(refundInv(pr2.projectId, iy, y)); } finally { hook = null; pool._setPool(realPool); cap2.restore(); }
  const after = await snapshot(pr2.projectId, [y], [iy]);
  progress(`k: forced audit failure -> ${r2.error ? `${r2.err.statusCode} ${r2.err.code} ${r2.error}` : JSON.stringify(r2.value)}`);
  expect(fired, 'k: audit insert reached (on the refund connection) and forced to fail');
  expect(!!r2.err && r2.err.code === '23514', 'k: the audit error propagates (refund not reported as done)', r2.error || JSON.stringify(r2.value));
  expectNothingRefunded('k audit failure', before, after, [y], [iy]);
  expect(await auditRows(iy) === 0, 'k: no audit row kept');
}

// f. HTTP: the REAL routes behind the REAL i18n middleware and errorHandler.
function httpApp() {
  const express = require('express');
  const { i18n } = require('../src/i18n/middleware');
  const projectRoutes = require('../src/routes/projectRoutes');
  const { errorHandler } = require('../src/middleware/errorHandler');
  const app = express();
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
async function testHttp() {
  section('f. HTTP: real routes + errorHandler -> status, full body, code reaches the client');
  const request = require('supertest');
  const app = httpApp();
  const loggerH = require('../src/utils/logger');
  for (const kind of ['forceCloseFunding', 'refundInvestment']) {
    const admin = await makeUser('admin', 'ADMIN');
    const x = await makeUser('x');
    // (1) 409 FUNDING_REFUND_IN_PROGRESS: a service call holds the locks before COMMIT.
    const pr = await makeFundedProject(kind === 'forceCloseFunding' ? 'FUNDING' : 'EXPIRED', [[x, 45]]);
    const [ix] = pr.investmentIds;
    const token = await tokenFor(kind === 'forceCloseFunding' ? admin : x);
    const httpCall = kind === 'forceCloseFunding'
      ? () => request(app).post(`/api/v1/projects/${pr.projectId}/funding/force-close`).set('Authorization', `Bearer ${token}`).send({ action: 'REFUND' })
      : () => request(app).post(`/api/v1/projects/${pr.projectId}/investments/${ix}/refund`).set('Authorization', `Bearer ${token}`);
    const svcCall = kind === 'forceCloseFunding' ? forceRefund(admin, pr.projectId) : refundInv(pr.projectId, ix, x);
    const realError = loggerH.error;
    const realWarn = loggerH.warn;
    loggerH.error = () => {};
    loggerH.warn = () => {};
    let busy;
    try {
      const out = await raceHeld(`f ${kind} busy`, svcCall, () => httpCall().then((res) => res), { holdMs: 4500 });
      busy = out.res2.value;
    } finally { loggerH.error = realError; loggerH.warn = realWarn; }
    console.log(`  HTTP ${kind}: ${busy && busy.status} ${busy && JSON.stringify(busy.body)}`);
    expect(!!busy && busy.status === 409 && JSON.stringify(busy.body) === JSON.stringify({ success: false, code: 'FUNDING_REFUND_IN_PROGRESS', message: BUSY_MESSAGE }),
      `f ${kind}: 409 { success:false, code:"FUNDING_REFUND_IN_PROGRESS", message } reaches the client`, busy && `${busy.status} ${JSON.stringify(busy.body)}`);
    const afterBusy = await snapshot(pr.projectId, [x], [ix]);
    expect(afterBusy.wallets[x] === 45 && afterBusy.credits[x] === 1, `f ${kind}: investor refunded exactly once (+45)`, `w=${afterBusy.wallets[x]} cr=${afterBusy.credits[x]}`);

    // (2) 409 FUNDING_REFUND_STATE_CHANGED via the same route.
    const pr2 = await makeFundedProject(kind === 'forceCloseFunding' ? 'FUNDING' : 'EXPIRED', [[x, 15]]);
    const [ix2] = pr2.investmentIds;
    const httpCall2 = kind === 'forceCloseFunding'
      ? () => request(app).post(`/api/v1/projects/${pr2.projectId}/funding/force-close`).set('Authorization', `Bearer ${token}`).send({ action: 'REFUND' })
      : () => request(app).post(`/api/v1/projects/${pr2.projectId}/investments/${ix2}/refund`).set('Authorization', `Bearer ${token}`);
    let injected = false;
    hook = async (c, sql) => {
      if (!injected && isInvestmentUpdate(sql)) {
        injected = true;
        await c.__p71Orig(`UPDATE project_investments SET status = 'CANCELLED' WHERE id = $1`, [ix2]);
      }
    };
    loggerH.error = () => {};
    pool._setPool(interceptingPool);
    let changed;
    try {
      changed = await httpCall2();
    } finally { hook = null; pool._setPool(realPool); loggerH.error = realError; }
    console.log(`  HTTP ${kind}: ${changed.status} ${JSON.stringify(changed.body)}`);
    expect(injected && changed.status === 409 && JSON.stringify(changed.body) === JSON.stringify({ success: false, code: 'FUNDING_REFUND_STATE_CHANGED', message: CHANGED_MESSAGE }),
      `f ${kind}: 409 { success:false, code:"FUNDING_REFUND_STATE_CHANGED", message } reaches the client`, `${changed.status} ${JSON.stringify(changed.body)}`);
    const after2 = await snapshot(pr2.projectId, [x], [ix2]);
    expect(after2.inv[ix2].status === 'CONFIRMED' && after2.wallets[x] === 45, `f ${kind}: state-changed call refunded nothing (rolled back)`,
      `status=${after2.inv[ix2].status} w=${after2.wallets[x]}`);
  }
}

function fnBody(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  return src.slice(start, src.indexOf('\n}\n', start));
}
async function testStatic() {
  section('s. Static: lock order, status re-checked under lock, rowCount, 55P03/40P01 mapping, references unchanged');
  const fc = fnBody(fs.readFileSync(FINANCE_FILE, 'utf8'), 'async function forceCloseFunding(');
  const ri = fnBody(fs.readFileSync(PROJECT_FILE, 'utf8'), 'async function refundInvestment(');
  const refund = fc.slice(fc.indexOf('// REFUND action'));
  for (const [name, body] of [['forceCloseFunding', refund], ['refundInvestment', ri]]) {
    expect(body.length > 0, `${name}: found`);
    expect(/SELECT[^`'"]*FROM projects WHERE id = \$1 FOR UPDATE[\s\S]*?FROM project_investments[\s\S]*?ORDER BY id\s+FOR UPDATE[\s\S]*?SELECT id FROM users WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR UPDATE[\s\S]*?fin\.creditWallet/.test(body),
      `${name}: lock order project FOR UPDATE -> investments ORDER BY id FOR UPDATE -> users ORDER BY id FOR UPDATE -> creditWallet`);
    expect(/AND status = 'CONFIRMED'/.test(body.slice(body.indexOf('UPDATE project_investments'))), `${name}: refund UPDATE re-checks status = 'CONFIRMED'`);
    expect(/\.rowCount !== 1/.test(body) && /FUNDING_REFUND_STATE_CHANGED/.test(body), `${name}: rowCount checked -> FUNDING_REFUND_STATE_CHANGED`);
    expect(/!committed && e && \(e\.code === '55P03' \|\| e\.code === '40P01'\)[\s\S]{0,1400}FUNDING_REFUND_IN_PROGRESS[\s\S]{0,80}throw busy;\s*\}\s*throw e;/.test(body),
      `${name}: only 55P03 / 40P01 before COMMIT map to FUNDING_REFUND_IN_PROGRESS; other errors rethrown`);
    expect(/await client\.query\('COMMIT'\);\s*committed = true;/.test(body), `${name}: committed flag set right after COMMIT`);
    expect(/generateReference\('PREF'\)/.test(body), `${name}: refund reference format unchanged (generateReference('PREF'))`);
  }
  expect(/logAudit\(\{ eventType: 'PROJECT_REFUND'[^\n]*, client \}\)/.test(ri), "refundInvestment: logAudit runs on the refund's client");
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
      const all = {
        a: testForceCloseTwice, b: testRefundInvestmentTwice, c1: testRefundThenForceClose, c2: testForceCloseThenRefund,
        d1: testLockTimeoutBoth, d2: testForcedErrors, e: testRowCountGuard, h: testOtherWriter, i: testDeadlockBarrier,
        f: testHttp, k: testRefundAudit, s: testStatic,
      };
      const order = ['a', 'b', 'c1', 'c2', 'd1', 'd2', 'e', 'h', 'i', 'k', 'f', 's'];
      const only = (process.argv.find((x) => x.startsWith('--only=')) || '').slice(7);
      const chosen = (only ? only.split(',') : order).map((k) => all[k]).filter(Boolean);
      if (only) console.log(`(running sections ${only} only)`);
      for (const t of chosen) {
        const res = await safe(t);
        if (res.error) bad(`${t.name} aborted`, res.error);
      }
    } finally {
      console.error = silenced;
    }
    expect(httpCalls.length === 0, 'no real provider HTTP call', httpCalls.length);
    expect(clientErrors.length === 0, 'no connection terminated by the server (e.g. 25P03)', clientErrors.join(' | '));
  } catch (e) {
    bad('unexpected error', e && e.stack || e);
  } finally {
    if (diag) await diag.end().catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})();
