#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step E0c: completeProject under concurrency
 *   completeProject (src/services/projectFinanceService.js)
 *   POST /projects/:id/complete (src/routes/projectRoutes.js)
 *
 * Lock order after E0c (same family as E0b refunds and executeDisbursement):
 *   project FOR UPDATE -> CONFIRMED investments ORDER BY id FOR UPDATE
 *   -> users (investors + owner) ORDER BY id FOR UPDATE
 *   -> controlled_project_accounts FOR UPDATE -> creditWallet.
 *
 *  a. Two parallel completions, call1 held before COMMIT: call2 waits on the
 *     project row and is answered under the lock (already_completed) without
 *     a credit attempt or a settlement INSERT. Full reconciliation.
 *  b. Real lock wait > lock_timeout -> 409 PROJECT_COMPLETE_IN_PROGRESS,
 *     logger.warn stage project-lock; money moved once.
 *  c. Forced 40P01 / 55P03 at stage credit -> 409, full rollback; 40001 not mapped.
 *  d. Escrow / project UPDATE change 0 rows -> 409 PROJECT_COMPLETE_STATE_CHANGED,
 *     full rollback.
 *  e. Project cancelled by another writer between the pre-check and the lock:
 *     the existing 400 status message, nothing paid, status not overwritten.
 *  f1. N1: completion (by the owner) vs executeDisbursement on the same escrow:
 *      escrow leaves once (no money without a source), no deadlock.
 *  f2. N1: an escrow writer that takes no other lock: completion returns what
 *      is left after it, never the stale balance.
 *  g. Deadlock barrier: two completions, different projects, shared investor.
 *  n. N2 evidence (backlog #28, NOT fixed): an investor with two CONFIRMED
 *     investments is paid only the first; the second share is lost.
 *  h. HTTP: 409 PROJECT_COMPLETE_IN_PROGRESS reaches the client.
 *  p. pg_constraint: UNIQUE (project_id) on project_settlements.
 *  s. Static checks.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function progress(msg) { console.log(`  · ${msg}`); }
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const fmt = (r) => (r.error ? `${r.err.statusCode || '-'} ${r.err.code || '-'} ${r.error}`
  : (r.value && r.value.status !== undefined && r.value.body !== undefined ? `HTTP ${r.value.status} ${JSON.stringify(r.value.body)}`
    : JSON.stringify(r.value && { already_completed: r.value.already_completed, settlement: r.value.settlement && { returned_to_investors: Number(r.value.settlement.returned_to_investors), owner_received: Number(r.value.settlement.owner_received), escrow_balance: Number(r.value.settlement.escrow_balance) }, project: r.value.project && r.value.project.status })));

const BUSY_MESSAGE = 'Ukamilishaji wa mradi haukukamilika kwa sababu ya shughuli nyingine zinazoendelea. Hakuna kilichofanyika. Jaribu tena baadaye.';
const CHANGED_MESSAGE = 'Hali ya mradi imebadilika wakati wa kukamilisha; hakuna kilichofanyika, jaribu tena.';
const notActive = (s) => `Mradi lazima uwe ACTIVE kwa kukamilika. (sasa: ${s})`;

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label, role) {
  seq += 1;
  const phone = `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71E0c ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  return id;
}
// ACTIVE project, escrow = sum of the investments (unless given), investments
// CONFIRMED with participation_pct NULL (pro-rata by amount).
async function makeActiveProject(investments, { escrow = null } = {}) {
  const owner = await makeUser('owner');
  const total = r2(investments.reduce((s, [, a]) => s + a, 0));
  const esc = escrow === null ? total : escrow;
  const p = (await pool.query(
    `INSERT INTO projects (owner_user_id, name, status, capital_required, amount_raised)
     VALUES ($1, $2, 'ACTIVE', $3, $3) RETURNING id`,
    [owner, `P71E0c project ${tag} ${++seq}`, total])).rows[0].id;
  await pool.query(
    `INSERT INTO controlled_project_accounts (project_id, remaining_balance, escrow_balance, status)
     VALUES ($1, $2, $2, 'ACTIVE')`, [p, esc]);
  const ids = [];
  for (const [inv, amt] of investments) {
    ids.push((await pool.query(
      `INSERT INTO project_investments (project_id, investor_user_id, amount, status, unique_reference)
       VALUES ($1, $2, $3, 'CONFIRMED', $4) RETURNING id`,
      [p, inv, amt, `P71E0c-${tag}-${p}-u${inv}-${++seq}`])).rows[0].id);
  }
  return { projectId: p, owner, total, escrow: esc, investmentIds: ids };
}

// Everything completeProject writes, per user (users are fresh per case).
async function snapshot(projectId, users, investmentIds) {
  const like = `SETTLE-${projectId}-%`;
  const s = { wallets: {}, credits: {}, creditRefs: {}, txns: {}, journal: {}, inv: {} };
  for (const id of users) {
    s.wallets[id] = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [id])).rows[0].wallet_balance);
    const ops = (await pool.query(
      `SELECT reference_id FROM financial_operations
        WHERE user_id = $1 AND operation_type = 'CREDIT' AND status = 'SUCCESS' AND reference_id LIKE $2 ORDER BY id`,
      [id, like])).rows.map((r) => r.reference_id);
    s.credits[id] = ops.length;
    s.creditRefs[id] = ops;
    s.journal[id] = ops.length === 0 ? 0 : (await pool.query(
      'SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id = ANY($1::text[])', [ops])).rows[0].c;
    s.txns[id] = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'PROJECT_SETTLEMENT' AND reference_id LIKE $2`,
      [id, like])).rows[0].c;
  }
  for (const iid of investmentIds) {
    s.inv[iid] = (await pool.query('SELECT status FROM project_investments WHERE id = $1', [iid])).rows[0].status;
  }
  s.allOps = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM financial_operations WHERE reference_id LIKE $1`, [like])).rows[0].c;
  s.allTxns = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM transactions WHERE reference_id LIKE $1`, [like])).rows[0].c;
  s.allJournal = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id LIKE $1`, [like])).rows[0].c;
  s.settlements = (await pool.query(
    `SELECT id, summary->>'reference' AS reference, returned_to_investors, owner_received, escrow_balance
       FROM project_settlements WHERE project_id = $1`, [projectId])).rows;
  s.project = (await pool.query('SELECT status FROM projects WHERE id = $1', [projectId])).rows[0].status;
  const e = (await pool.query(
    'SELECT remaining_balance, status FROM controlled_project_accounts WHERE project_id = $1', [projectId])).rows[0];
  s.escrow = { balance: Number(e.remaining_balance), status: e.status };
  s.outbox = (await pool.query(
    `SELECT reference_id FROM outbox_events WHERE event_type = 'PROJECT_COMPLETED' AND aggregate_id = $1 ORDER BY id`,
    [String(projectId)])).rows.map((r) => r.reference_id);
  s.audit = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'PROJECT_COMPLETED' AND entity_type = 'PROJECT' AND entity_id = $1`,
    [projectId])).rows[0].c;
  return s;
}
function show(label, s, users) {
  const w = users.map((id) => `${id}:w=${s.wallets[id]} cr=${s.credits[id]} tx=${s.txns[id]} j=${s.journal[id]}`).join(' ');
  progress(`${label}: ${w} | ops=${s.allOps} txns=${s.allTxns} journal=${s.allJournal} | settlements=${s.settlements.length} | project ${s.project} | escrow ${s.escrow.balance}/${s.escrow.status} | inv ${Object.values(s.inv).join(',')} | outbox ${JSON.stringify(s.outbox)} | audit ${s.audit}`);
}
// paid: { userId: amount } for every user in `users` (0 = not paid).
function expectCompletedOnce(label, before, after, users, paid, investmentIds) {
  const paidUsers = users.filter((u) => (paid[u] || 0) > 0);
  for (const u of users) {
    const amt = paid[u] || 0;
    const d = r2(after.wallets[u] - before.wallets[u]);
    expect(d === amt, `${label}: user ${u} wallet +${amt}`, `delta=${d}`);
    const n = amt > 0 ? 1 : 0;
    expect(after.credits[u] - before.credits[u] === n && after.txns[u] - before.txns[u] === n && after.journal[u] - before.journal[u] === 2 * n,
      `${label}: user ${u} has ${n} CREDIT, ${n} PROJECT_SETTLEMENT transaction, ${2 * n} journal rows`,
      `cr=${after.credits[u] - before.credits[u]} tx=${after.txns[u] - before.txns[u]} j=${after.journal[u] - before.journal[u]}`);
  }
  expect(after.allOps === paidUsers.length && after.allTxns === paidUsers.length && after.allJournal === 2 * paidUsers.length,
    `${label}: project-wide ${paidUsers.length} financial_operations, ${paidUsers.length} transactions, ${2 * paidUsers.length} journal rows (SETTLE-${'<p>'}-*)`,
    `ops=${after.allOps} txns=${after.allTxns} journal=${after.allJournal}`);
  expect(after.settlements.length === 1, `${label}: exactly 1 project_settlements row`, after.settlements.length);
  const ref = after.settlements[0] && after.settlements[0].reference;
  const refsOk = paidUsers.every((u) => after.creditRefs[u].length === 1 && after.creditRefs[u][0].startsWith(`${ref}-`));
  expect(!!ref && refsOk, `${label}: every credit reference belongs to the single settlement reference ${ref}`, JSON.stringify(paidUsers.map((u) => after.creditRefs[u])));
  expect(after.project === 'COMPLETED', `${label}: project COMPLETED`, after.project);
  expect(after.escrow.balance === 0 && after.escrow.status === 'CLOSED', `${label}: escrow 0 and CLOSED`, JSON.stringify(after.escrow));
  expect(investmentIds.every((i) => after.inv[i] === 'CONFIRMED'), `${label}: investments unchanged (CONFIRMED)`, JSON.stringify(after.inv));
  expect(after.outbox.length === 1 && after.outbox[0] === `${ref}-outbox`, `${label}: exactly 1 PROJECT_COMPLETED outbox event, reference ${ref}-outbox`, JSON.stringify(after.outbox));
  expect(after.audit === 1, `${label}: exactly 1 audit_logs PROJECT_COMPLETED row`, after.audit);
}
function expectNothingDone(label, before, after, users, investmentIds) {
  const moved = users.filter((u) => after.wallets[u] !== before.wallets[u] || after.credits[u] !== before.credits[u]
    || after.txns[u] !== before.txns[u] || after.journal[u] !== before.journal[u]);
  expect(moved.length === 0, `${label}: no wallet, CREDIT, transaction or journal change`, JSON.stringify(moved));
  expect(after.allOps === before.allOps && after.allTxns === before.allTxns && after.allJournal === before.allJournal,
    `${label}: no SETTLE-* financial_operations, transactions or journal rows`, `ops=${after.allOps} txns=${after.allTxns} journal=${after.allJournal}`);
  expect(after.settlements.length === before.settlements.length, `${label}: no settlement row`, after.settlements.length);
  expect(after.escrow.balance === before.escrow.balance && after.escrow.status === before.escrow.status,
    `${label}: escrow unchanged`, `${JSON.stringify(before.escrow)} -> ${JSON.stringify(after.escrow)}`);
  expect(investmentIds.every((i) => after.inv[i] === before.inv[i]), `${label}: investments unchanged`);
  expect(after.outbox.length === before.outbox.length && after.audit === before.audit, `${label}: no outbox event, no audit row`,
    `outbox=${after.outbox.length} audit=${after.audit}`);
}

// ---- pool interception (same approach as the E0 / E0b suites) ---------------
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

function pgClient(timeout) {
  const { Client } = require('pg');
  const c = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  c.on('error', (e) => clientErrors.push(`aux ${e.code || ''} ${e.message}`));
  return c.connect().then(() => c.query(`SET statement_timeout = '${timeout}'`)).then(() => c);
}
let diag = null;
async function diagClient() {
  if (!diag) diag = await pgClient('5s');
  return diag;
}
// A backend of this database blocked by `pid`. Notification inserts (after
// COMMIT, own connection) are excluded.
async function backendBlockedBy(pid) {
  const d = await diagClient();
  const r = await d.query(
    `SELECT pid, wait_event, left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS q
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
async function deadlocks() {
  return Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
}

const GATE_LIMIT_MS = 2500; // fallback release; below the 3 s lock_timeout
const SECTION_LIMIT_MS = 30000;
const isSettlementInsert = (sql) => /^\s*INSERT INTO project_settlements/i.test(sql);
const isClaimInsert = (sql) => /^\s*INSERT INTO financial_operations/i.test(sql);

// call1 is held when it is about to run a statement matching `holdAt`, once it
// has run a statement matching `touch`. call2 starts then; the gate opens when
// a backend blocked by call1 is seen (or GATE_LIMIT_MS / holdMs pass). Every
// statement and error of the other clients is recorded (call2's trace).
async function raceHeld(name, call1, call2, { touch = isSettlementInsert, holdAt = /^\s*COMMIT\b/i, holdMs = null } = {}) {
  let call1Client = null;
  let gateReached;
  const reached = new Promise((r) => { gateReached = r; });
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  let touched = false;
  let held = false;
  let started2 = false;
  const trace2 = [];
  const errors2 = [];
  hook = async (client, sql) => {
    if (!call1Client && touch(sql)) { call1Client = client; touched = true; }
    if (started2 && client !== call1Client) trace2.push(sql.trim().split(/\s+/).slice(0, 6).join(' '));
    if (!held && touched && client === call1Client && holdAt.test(sql)) {
      held = true;
      progress(`${name}: call1 held (pid ${client.processID}) before: ${sql.trim().split(/\s+/).slice(0, 8).join(' ')}`);
      gateReached();
      await gate;
    }
  };
  afterHook = (client, sql, res) => {
    if (started2 && client !== call1Client && res instanceof Error) errors2.push(`${res.code} ${res.constraint || ''}`.trim());
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
      expect(first === 'gate', `${name}: call1 held at the gate`, first);
      const t0 = Date.now();
      started2 = true;
      const p2 = safe(call2).then((r) => { call2Ms = Date.now() - t0; return r; });
      if (holdMs !== null) {
        res2 = await Promise.race([p2, sleep(holdMs).then(() => null)]);
        reason = res2 ? `call2 returned after ${call2Ms} ms while call1 was held` : `held ${holdMs} ms`;
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
    afterHook = null;
    pool._setPool(realPool);
  }
  if (timedOut) { bad(`${name}: timed out`); throw new Error('SECTION_TIMEOUT'); }
  progress(`${name}: call1 -> ${fmt(res1)}`);
  progress(`${name}: call2 -> ${fmt(res2)} (after ${call2Ms} ms)`);
  return { res1, res2, reason, call2Ms, trace2, errors2 };
}
const complete = (projectId, actorUserId, actorRole = null) => () => projectFinance.completeProject({ projectId, actorUserId, actorRole });
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

// ---------------------------------------------------------------------------
async function testParallel() {
  section('a. Two parallel completions of one project (call1 held before COMMIT)');
  const admin = await makeUser('admin', 'ADMIN');
  const [x, y, z] = [await makeUser('x'), await makeUser('y'), await makeUser('z')];
  const pr = await makeActiveProject([[x, 100], [y, 250.5], [z, 40]]);
  const users = [x, y, z, pr.owner];
  const before = await snapshot(pr.projectId, users, pr.investmentIds);
  show('before', before, users);
  const { res1, res2, reason, trace2, errors2 } = await raceHeld('a', complete(pr.projectId, pr.owner), complete(pr.projectId, admin, 'ADMIN'));
  const after = await snapshot(pr.projectId, users, pr.investmentIds);
  show('after ', after, users);
  const keyOps = trace2.filter((s) => /^(INSERT INTO (financial_operations|project_settlements|transactions)|UPDATE (users|controlled_project_accounts|projects)|SELECT .*FOR UPDATE|SELECT \* FROM project_settlements|ROLLBACK|COMMIT)/i.test(s));
  progress(`a: call2 key statements (${trace2.length} total): ${JSON.stringify(keyOps)}`);
  progress(`a: call2 database errors: ${JSON.stringify(errors2)}`);
  expectCompletedOnce('a', before, after, users, { [x]: 100, [y]: 250.5, [z]: 40, [pr.owner]: 0 }, pr.investmentIds);
  expect(!res1.error && Number(res1.value.settlement.returned_to_investors) === 390.5 && res1.value.project.status === 'COMPLETED',
    'a: call1 completes, returns 390.5 to investors', fmt(res1));
  expect(/FROM projects WHERE id = \$1 FOR UPDATE/.test(reason), 'a: call2 waited on the project row lock (FOR UPDATE)', reason);
  expect(!res2.error && res2.value.already_completed === true && after.settlements[0] && res2.value.settlement.id === after.settlements[0].id,
    'a: call2 answered already_completed with the committed settlement', fmt(res2));
  expect(!trace2.some((s) => /^INSERT INTO financial_operations/i.test(s)), 'a: call2 made no credit attempt (no financial_operations claim)', JSON.stringify(trace2));
  expect(!trace2.some((s) => /^INSERT INTO project_settlements/i.test(s)) && !errors2.some((e) => e.startsWith('23505')),
    'a: call2 was answered under the lock: no settlement INSERT, no 23505', JSON.stringify(errors2));
}

async function testLockTimeout() {
  section('b. Real lock wait > lock_timeout (3 s) -> 409 PROJECT_COMPLETE_IN_PROGRESS');
  const admin = await makeUser('admin', 'ADMIN');
  const x = await makeUser('x');
  const pr = await makeActiveProject([[x, 70]]);
  const before = await snapshot(pr.projectId, [x, pr.owner], pr.investmentIds);
  const cap = captureWarns();
  let out;
  try {
    out = await raceHeld('b', complete(pr.projectId, pr.owner), complete(pr.projectId, admin, 'ADMIN'), { holdMs: 4500 });
  } finally { cap.restore(); }
  const { res1, res2, call2Ms } = out;
  const w = cap.warns.find((m) => m.meta && m.meta.projectId === pr.projectId);
  progress(`b: logger.warn meta ${w ? JSON.stringify(w.meta) : 'none'}`);
  expect(!!res2.error && res2.err.statusCode === 409 && res2.err.code === 'PROJECT_COMPLETE_IN_PROGRESS' && res2.error === BUSY_MESSAGE,
    'b: call2 -> 409 PROJECT_COMPLETE_IN_PROGRESS with the agreed message (not raw 55P03)', fmt(res2));
  expect(call2Ms >= 2500 && call2Ms < 4500, 'b: call2 waited about the 3 s lock_timeout', `${call2Ms} ms`);
  expect(!!w && w.meta.code === '55P03' && w.meta.stage === 'project-lock' && w.meta.path === 'completeProject',
    'b: logger.warn code 55P03, stage project-lock, path completeProject', w && JSON.stringify(w.meta));
  expect(!res1.error, 'b: call1 completes', fmt(res1));
  const after = await snapshot(pr.projectId, [x, pr.owner], pr.investmentIds);
  expectCompletedOnce('b', before, after, [x, pr.owner], { [x]: 70 }, pr.investmentIds);
}

async function forcedAtCredit(code, nth) {
  const admin = await makeUser('admin', 'ADMIN');
  const x = await makeUser('x');
  const y = await makeUser('y');
  const pr = await makeActiveProject([[x, 60], [y, 90]]);
  const users = [x, y, pr.owner];
  const before = await snapshot(pr.projectId, users, pr.investmentIds);
  let n = 0;
  hook = async (c, sql) => {
    if (isClaimInsert(sql) && ++n === nth) {
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
    r = await safe(complete(pr.projectId, admin, 'ADMIN'));
  } finally { hook = null; pool._setPool(realPool); cap.restore(); }
  const after = await snapshot(pr.projectId, users, pr.investmentIds);
  const w = cap.warns.find((m) => m.meta && m.meta.projectId === pr.projectId);
  return { r, before, after, w, pr, users };
}
async function testForcedErrors() {
  section('c. Forced 40P01 / 55P03 at stage credit -> 409, logged, full rollback; 40001 not mapped');
  for (const [code, nth] of [['40P01', 2], ['55P03', 1]]) {
    const { r, before, after, w, pr, users } = await forcedAtCredit(code, nth);
    progress(`c ${code}: ${fmt(r)}; warn ${w ? JSON.stringify(w.meta) : 'none'}`);
    expect(!!r.error && r.err.statusCode === 409 && r.err.code === 'PROJECT_COMPLETE_IN_PROGRESS' && r.error === BUSY_MESSAGE,
      `c: forced ${code} -> 409 PROJECT_COMPLETE_IN_PROGRESS`, fmt(r));
    expect(!!w && w.meta.code === code && w.meta.stage === 'credit' && w.meta.table === 'financial_operations' && w.meta.routine === 'TEST',
      `c: logger.warn code ${code}, stage credit, table, routine`, w && JSON.stringify(w.meta));
    expectNothingDone(`c ${code}`, before, after, users, pr.investmentIds);
    expect(after.project === 'ACTIVE', `c ${code}: project still ACTIVE`, after.project);
  }
  const { r } = await forcedAtCredit('40001', 1);
  expect(!!r.err && r.err.code === '40001' && r.err.statusCode === undefined, 'c: 40001 propagates unchanged (not mapped)', fmt(r));
}

async function testRowCount() {
  section('d. Escrow / project UPDATE change 0 rows -> 409 PROJECT_COMPLETE_STATE_CHANGED, full rollback');
  const cases = [
    ['escrow', /^\s*UPDATE controlled_project_accounts\s+SET remaining_balance = 0/i,
      (c, p) => c.__p71Orig('UPDATE controlled_project_accounts SET remaining_balance = remaining_balance - 1 WHERE project_id = $1', [p])],
    ['project', /^\s*UPDATE projects SET status = 'COMPLETED'/i,
      (c, p) => c.__p71Orig("UPDATE projects SET status = 'CANCELLED' WHERE id = $1", [p])],
  ];
  for (const [what, at, inject] of cases) {
    const admin = await makeUser('admin', 'ADMIN');
    const x = await makeUser('x');
    const y = await makeUser('y');
    const pr = await makeActiveProject([[x, 50], [y, 75]]);
    const users = [x, y, pr.owner];
    const before = await snapshot(pr.projectId, users, pr.investmentIds);
    // On the completion's own connection (it holds the row lock), change the
    // row right before its UPDATE; __p71Orig does not re-enter the hook.
    let injected = false;
    hook = async (c, sql) => {
      if (!injected && at.test(sql)) {
        injected = true;
        await inject(c, pr.projectId);
        progress(`d ${what}: row changed in the same transaction before the ${what} UPDATE`);
      }
    };
    pool._setPool(interceptingPool);
    let r;
    try {
      r = await safe(complete(pr.projectId, admin, 'ADMIN'));
    } finally { hook = null; pool._setPool(realPool); }
    const after = await snapshot(pr.projectId, users, pr.investmentIds);
    progress(`d ${what}: ${fmt(r)}`);
    show(`d ${what} after`, after, users);
    expect(injected, `d ${what}: change injected`);
    expect(!!r.error && r.err.statusCode === 409 && r.err.code === 'PROJECT_COMPLETE_STATE_CHANGED' && r.error === CHANGED_MESSAGE,
      `d ${what}: 409 PROJECT_COMPLETE_STATE_CHANGED`, fmt(r));
    expectNothingDone(`d ${what}`, before, after, users, pr.investmentIds);
    expect(after.project === 'ACTIVE', `d ${what}: project still ACTIVE (rolled back)`, after.project);
  }
}

async function testCancelledMeanwhile() {
  section('e. Project cancelled by another writer between the pre-check and the lock');
  const admin = await makeUser('admin', 'ADMIN');
  const x = await makeUser('x');
  const y = await makeUser('y');
  const pr = await makeActiveProject([[x, 30], [y, 45]]);
  const users = [x, y, pr.owner];
  const before = await snapshot(pr.projectId, users, pr.investmentIds);
  const w = await pgClient('10s');
  let r;
  let reason = 'not seen';
  try {
    await w.query('BEGIN');
    await w.query("UPDATE projects SET status = 'CANCELLED' WHERE id = $1", [pr.projectId]);
    const wpid = (await w.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const p = safe(complete(pr.projectId, admin, 'ADMIN'));
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      const b = await backendBlockedBy(wpid);
      if (b) { reason = `completion blocked by the writer on ${b.wait_event}: ${b.q}`; break; }
      if (await Promise.race([p.then(() => true), sleep(25).then(() => false)])) { reason = 'completion finished first'; break; }
    }
    progress(`e: ${reason}`);
    await w.query('COMMIT');
    r = await p;
  } finally {
    await w.query('ROLLBACK').catch(() => {});
    await w.end().catch(() => {});
  }
  const after = await snapshot(pr.projectId, users, pr.investmentIds);
  progress(`e: ${fmt(r)}`);
  show('e after', after, users);
  expect(/FROM projects WHERE id = \$1 FOR UPDATE/.test(reason), 'e: completion waited on the project row lock', reason);
  expect(!!r.error && r.err.statusCode === 400 && r.error === notActive('CANCELLED'),
    'e: the existing 400 status message, re-checked under the lock', fmt(r));
  expectNothingDone('e', before, after, users, pr.investmentIds);
  expect(after.project === 'CANCELLED', 'e: project stays CANCELLED (not overwritten to COMPLETED)', after.project);
}

async function makeDisbursement(projectId, amount, requestedBy) {
  return (await pool.query(
    `INSERT INTO project_disbursements (project_id, amount, status, requested_by, unique_reference)
     VALUES ($1, $2, 'AUTHORIZED', $3, $4) RETURNING id`,
    [projectId, amount, requestedBy, `P71E0c-DISB-${tag}-${projectId}-${++seq}`])).rows[0].id;
}
async function testVsDisbursement() {
  section('f1. N1: completion (by the owner) held after reading the escrow vs executeDisbursement 300 of 1000');
  const treasury = await makeUser('treasury', 'ADMIN');
  const [x, y] = [await makeUser('x'), await makeUser('y')];
  const pr = await makeActiveProject([[x, 400], [y, 600]]);
  const reqId = await makeDisbursement(pr.projectId, 300, pr.owner);
  const users = [x, y, pr.owner];
  const before = await snapshot(pr.projectId, users, pr.investmentIds);
  const dl0 = await deadlocks();
  const isEscrowRead = (sql) => /^\s*SELECT remaining_balance FROM controlled_project_accounts/i.test(sql);
  const { res1, res2, reason } = await raceHeld('f1', complete(pr.projectId, pr.owner),
    () => projectFinance.executeDisbursement(treasury, pr.projectId, reqId),
    { touch: isEscrowRead, holdAt: /FROM project_reserves/i });
  await sleep(1200);
  const dl1 = await deadlocks();
  const after = await snapshot(pr.projectId, users, pr.investmentIds);
  show('f1 after', after, users);
  const disb = (await pool.query('SELECT status FROM project_disbursements WHERE id = $1', [reqId])).rows[0].status;
  const outInv = r2((after.wallets[x] - before.wallets[x]) + (after.wallets[y] - before.wallets[y]));
  const outOwner = r2(after.wallets[pr.owner] - before.wallets[pr.owner]);
  progress(`f1: escrow ${pr.escrow}; paid to investors ${outInv}; paid to owner (disbursement) ${outOwner}; total out ${r2(outInv + outOwner)}; disbursement ${disb}; deadlocks ${dl0} -> ${dl1}`);
  expect(r2(outInv + outOwner) === pr.escrow, `f1: total paid out of the escrow = ${pr.escrow} (no money without a source)`, r2(outInv + outOwner));
  expect(!res1.error && outInv === 1000 && outOwner === 0, 'f1: completion returns 1000 to the investors, the disbursement pays nothing', `${fmt(res1)} inv=${outInv} owner=${outOwner}`);
  expect(!!res2.error && res2.err.statusCode === 409 && disb === 'AUTHORIZED',
    'f1: executeDisbursement refused (409, escrow insufficient), request stays AUTHORIZED', `${fmt(res2)} status=${disb}`);
  expect(/users|financial_operations/i.test(reason) || /blocked/.test(reason), 'f1: the disbursement waited on the completion', reason);
  expect(dl1 === dl0, 'f1: no deadlock (pg_stat_database.deadlocks unchanged)', `${dl0} -> ${dl1}`);
  expectCompletedOnce('f1', before, after, users, { [x]: 400, [y]: 600, [pr.owner]: 0 }, pr.investmentIds);
}

async function testVsEscrowWriter() {
  section('f2. N1: another writer takes 300 from the escrow (no other lock) while the completion starts');
  const admin = await makeUser('admin', 'ADMIN');
  const [x, y] = [await makeUser('x'), await makeUser('y')];
  const pr = await makeActiveProject([[x, 400], [y, 600]]);
  const users = [x, y, pr.owner];
  const before = await snapshot(pr.projectId, users, pr.investmentIds);
  const w = await pgClient('10s');
  let r;
  let reason = 'not seen';
  try {
    await w.query('BEGIN');
    await w.query('UPDATE controlled_project_accounts SET remaining_balance = remaining_balance - 300 WHERE project_id = $1', [pr.projectId]);
    const wpid = (await w.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const p = safe(complete(pr.projectId, admin, 'ADMIN'));
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      const b = await backendBlockedBy(wpid);
      if (b) { reason = `completion blocked by the writer on ${b.wait_event}: ${b.q}`; break; }
      if (await Promise.race([p.then(() => true), sleep(25).then(() => false)])) { reason = 'completion finished first'; break; }
    }
    progress(`f2: ${reason}`);
    await w.query('COMMIT');
    r = await p;
  } finally {
    await w.query('ROLLBACK').catch(() => {});
    await w.end().catch(() => {});
  }
  const after = await snapshot(pr.projectId, users, pr.investmentIds);
  show('f2 after', after, users);
  const outInv = r2((after.wallets[x] - before.wallets[x]) + (after.wallets[y] - before.wallets[y]));
  progress(`f2: ${fmt(r)}; escrow 1000 - 300 taken by the writer = 700 left; returned to investors ${outInv}`);
  expect(/FROM controlled_project_accounts/.test(reason), 'f2: completion waited on the escrow row lock', reason);
  expect(!r.error && outInv === 700 && Number(r.value.settlement.escrow_balance) === 700,
    'f2: completion returns exactly the 700 left (not the stale 1000)', `${fmt(r)} inv=${outInv}`);
  expectCompletedOnce('f2', before, after, users, { [x]: 280, [y]: 420, [pr.owner]: 0 }, pr.investmentIds);
}

async function testDeadlockBarrier() {
  section('g. Deadlock (deterministic): two completions, different projects, shared investor, barrier at creditWallet FOR UPDATE');
  const BARRIER_MS = 2000;
  const admin = await makeUser('admin', 'ADMIN');
  const inv = await makeUser('shared');
  const pX = await makeActiveProject([[inv, 11]]);
  const pY = await makeActiveProject([[inv, 22]]);
  const dl0 = await deadlocks();
  let arrivals = 0;
  let releaseAll;
  const allArrived = new Promise((r) => { releaseAll = r; });
  let barrierOpen = true;
  let result = 'not reached';
  const seen = new WeakSet();
  hook = async (client, sql) => {
    if (/SELECT wallet_balance FROM users WHERE id = \$1 FOR UPDATE/.test(sql) && !seen.has(client)) {
      seen.add(client);
      if (!barrierOpen) return;
      arrivals += 1;
      progress(`g: barrier arrival ${arrivals} (pid ${client.processID})`);
      if (arrivals >= 2) { result = 'both completions arrived holding KEY SHARE'; releaseAll(); return; }
      const t = await Promise.race([allArrived.then(() => 'all'), sleep(BARRIER_MS).then(() => 'timeout')]);
      if (t === 'timeout') { barrierOpen = false; result = `only one arrival within ${BARRIER_MS} ms (the other blocked earlier, on the users lock)`; }
    }
  };
  pool._setPool(interceptingPool);
  let res;
  try {
    res = await Promise.all([complete(pX.projectId, admin, 'ADMIN'), complete(pY.projectId, admin, 'ADMIN')].map((c) => safe(c)));
  } finally { releaseAll(); hook = null; pool._setPool(realPool); }
  progress(`g: ${result}`);
  for (const [k, r] of res.entries()) progress(`g: call${k + 1} -> ${fmt(r)}`);
  await sleep(1200);
  const dl1 = await deadlocks();
  const wal = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [inv])).rows[0].wallet_balance);
  expect(arrivals === 1, 'g: only one completion reached creditWallet while the other was held (users lock serialises them)', result);
  expect(res.every((r) => !r.error), 'g: both completions succeed: no 40P01 and no 409', res.filter((r) => r.error).map(fmt).join(' | '));
  expect(dl1 === dl0, 'g: pg_stat_database.deadlocks unchanged', `${dl0} -> ${dl1}`);
  expect(wal === 33, 'g: shared investor paid 11 + 22 = 33, each once', wal);
}

// The assertions in this section document the CURRENT (wrong) behaviour, the
// same before and after E0c; flip them when backlog #28 is fixed.
async function testTwoInvestmentsOneInvestor() {
  section('n. N2 evidence (backlog #28, NOT fixed in E0c): one investor with two CONFIRMED investments');
  const admin = await makeUser('admin', 'ADMIN');
  const run = async (label, invs) => {
    const pr = await makeActiveProject(invs.map(([who, amt]) => [who, amt]));
    const users = [...new Set(invs.map(([who]) => who)), pr.owner];
    const before = await snapshot(pr.projectId, users, pr.investmentIds);
    const r = await safe(complete(pr.projectId, admin, 'ADMIN'));
    const after = await snapshot(pr.projectId, users, pr.investmentIds);
    show(`n ${label} after`, after, users);
    const delta = (u) => r2(after.wallets[u] - before.wallets[u]);
    const paid = r2(users.reduce((s, u) => s + delta(u), 0));
    progress(`n ${label}: ${fmt(r)}`);
    return { pr, users, before, after, r, delta, paid };
  };
  // (1) equal amounts: x 150 + x 150, y 300; escrow 600.
  const [x1, y1] = [await makeUser('x'), await makeUser('y')];
  const e = await run('equal', [[x1, 150], [x1, 150], [y1, 300]]);
  const lost = r2(e.pr.escrow - e.paid);
  progress(`n equal: escrow ${e.pr.escrow}; x owns 150 + 150 = 300, paid ${e.delta(x1)}; y owns 300, paid ${e.delta(y1)}; owner paid ${e.delta(e.pr.owner)}; total paid ${e.paid}; LOST ${lost}; escrow after ${e.after.escrow.balance}/${e.after.escrow.status}; settlement returned_to_investors ${e.after.settlements[0] && Number(e.after.settlements[0].returned_to_investors)}`);
  expect(!e.r.error && e.delta(x1) === 150 && e.delta(y1) === 300 && e.delta(e.pr.owner) === 0,
    'n equal [documents #28]: x paid 150 only (owns 300), y paid 300', `x=${e.delta(x1)} y=${e.delta(y1)} owner=${e.delta(e.pr.owner)}`);
  expect(lost === 150 && e.after.escrow.balance === 0 && e.after.escrow.status === 'CLOSED' && e.after.project === 'COMPLETED',
    'n equal [documents #28]: 150 of the 600 escrow is paid to nobody, yet escrow 0 / CLOSED and project COMPLETED', `lost=${lost} escrow=${JSON.stringify(e.after.escrow)}`);
  expect(e.after.credits[x1] === 1 && e.after.settlements.length === 1 && Number(e.after.settlements[0].returned_to_investors) === 450,
    'n equal [documents #28]: x has 1 CREDIT; settlement records returned_to_investors 450 (not 600)',
    `cr=${e.after.credits[x1]} returned=${e.after.settlements[0] && e.after.settlements[0].returned_to_investors}`);
  // (2) different amounts: x 100 + x 200, y 300; escrow 600.
  const [x2, y2] = [await makeUser('x'), await makeUser('y')];
  const d = await run('different', [[x2, 100], [x2, 200], [y2, 300]]);
  progress(`n different: escrow ${d.pr.escrow}; total paid ${d.paid}; escrow after ${d.after.escrow.balance}/${d.after.escrow.status}; project ${d.after.project}`);
  expect(!!d.r.err && d.r.err.code === 'OPERATION_SHAPE_MISMATCH' && d.r.err.statusCode === 409,
    'n different [documents #28]: completion fails with 409 OPERATION_SHAPE_MISMATCH (same reference, different amount)', fmt(d.r));
  expect(d.paid === 0 && d.after.escrow.balance === 600 && d.after.project === 'ACTIVE' && d.after.settlements.length === 0,
    'n different [documents #28]: nothing paid, escrow 600 kept, project stays ACTIVE: it can never be completed this way',
    `paid=${d.paid} escrow=${JSON.stringify(d.after.escrow)} project=${d.after.project}`);
}

// HTTP: the REAL route behind the REAL i18n middleware and errorHandler.
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
  section('h. HTTP: 409 PROJECT_COMPLETE_IN_PROGRESS through the real route + errorHandler');
  const request = require('supertest');
  const app = httpApp();
  const loggerH = require('../src/utils/logger');
  const admin = await makeUser('admin', 'ADMIN');
  const x = await makeUser('x');
  const pr = await makeActiveProject([[x, 45]]);
  const token = await tokenFor(admin);
  const realError = loggerH.error;
  const realWarn = loggerH.warn;
  loggerH.error = () => {};
  loggerH.warn = () => {};
  let busy;
  try {
    const out = await raceHeld('h', complete(pr.projectId, pr.owner),
      () => request(app).post(`/api/v1/projects/${pr.projectId}/complete`).set('Authorization', `Bearer ${token}`).send({}).then((res) => res),
      { holdMs: 4500 });
    busy = out.res2.value;
  } finally { loggerH.error = realError; loggerH.warn = realWarn; }
  console.log(`  HTTP: ${busy && busy.status} ${busy && JSON.stringify(busy.body)}`);
  expect(!!busy && busy.status === 409 && JSON.stringify(busy.body) === JSON.stringify({ success: false, code: 'PROJECT_COMPLETE_IN_PROGRESS', message: BUSY_MESSAGE }),
    'h: 409 { success:false, code:"PROJECT_COMPLETE_IN_PROGRESS", message } reaches the client', busy && `${busy.status} ${JSON.stringify(busy.body)}`);
  const after = await snapshot(pr.projectId, [x], pr.investmentIds);
  expect(after.wallets[x] === 45 && after.credits[x] === 1 && after.settlements.length === 1, 'h: investor paid exactly once (+45), one settlement',
    `w=${after.wallets[x]} cr=${after.credits[x]} s=${after.settlements.length}`);
}

async function testConstraint() {
  section('p. pg_constraint: UNIQUE (project_id) on project_settlements');
  const r = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'project_settlements'::regclass AND contype = 'u'`);
  progress(`p: ${JSON.stringify(r.rows)}`);
  expect(r.rows.length === 1 && r.rows[0].conname === 'project_settlements_project_id_key' && r.rows[0].def === 'UNIQUE (project_id)',
    'p: project_settlements_project_id_key = UNIQUE (project_id)', JSON.stringify(r.rows));
}

function fnBody(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  return src.slice(start, src.indexOf('\n}\n', start));
}
function testStatic() {
  section('s. Static: lock order, checks under the lock, rowCount, 55P03/40P01, 23505 by constraint, references and outbox unchanged');
  const b = fnBody(fs.readFileSync(FINANCE_FILE, 'utf8'), 'async function completeProject(');
  const tx = b.slice(b.indexOf("client.query('BEGIN')"));
  expect(b.length > 0, 'completeProject found');
  expect(/FROM projects WHERE id = \$1 FOR UPDATE[\s\S]*?FROM project_settlements WHERE project_id[\s\S]*?status !== 'ACTIVE'[\s\S]*?FROM project_investments[\s\S]*?ORDER BY id ASC\s+FOR UPDATE[\s\S]*?SELECT id FROM users WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR UPDATE[\s\S]*?FROM controlled_project_accounts[^`]*FOR UPDATE[\s\S]*?fin\.creditWallet/.test(tx),
    'lock order: project FOR UPDATE -> settlement + status checked -> investments ORDER BY id FOR UPDATE -> users ORDER BY id FOR UPDATE -> escrow FOR UPDATE -> creditWallet');
  expect(/p\.owner_user_id/.test(tx.slice(tx.indexOf('users-lock'), tx.indexOf('escrow-lock'))), 'users lock includes the owner');
  expect(/escUpd\.rowCount !== escrowRes\.rows\.length\) throw stateChanged\(\)/.test(tx) && /upd\.rowCount !== 1\) throw stateChanged\(\)/.test(tx)
    && /const stateChanged = \(\) => \{[\s\S]{0,200}PROJECT_COMPLETE_STATE_CHANGED/.test(b),
    'escrow and project UPDATE row counts checked -> PROJECT_COMPLETE_STATE_CHANGED');
  expect(/WHERE id = \$1 AND status = 'ACTIVE'/.test(tx), "project UPDATE re-checks status = 'ACTIVE'");
  expect(/!txCommitted && e && \(e\.code === '55P03' \|\| e\.code === '40P01'\)[\s\S]{0,1200}PROJECT_COMPLETE_IN_PROGRESS/.test(b), '55P03 / 40P01 before COMMIT -> PROJECT_COMPLETE_IN_PROGRESS');
  expect(/!txCommitted && e && e\.code === '23505' && e\.constraint === 'project_settlements_project_id_key'/.test(b) && !/duplicate key/.test(b),
    "23505 matched by constraint name; no 'duplicate key' text match");
  expect(/await client\.query\('COMMIT'\);\s*txCommitted = true;/.test(b), 'txCommitted flag set right after COMMIT');
  expect(/const settleRef = `SETTLE-\$\{projectId\}-\$\{Date\.now\(\)\}`;/.test(b) && /reference: `\$\{settleRef\}-u\$\{inv\.investor_user_id\}`/.test(b)
    && /if \(res\.dedup\) \{ committed = round2\(committed \+ amt\); continue; \}/.test(b),
  'settlement / credit references and the dedup branch unchanged');
  expect(/reference: `\$\{settleRef\}-outbox`,\s*\}\)\.catch\(\(\) => \{\}\);/.test(b), 'outbox enqueue unchanged (after COMMIT, .catch) — E2');
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
        a: testParallel, b: testLockTimeout, c: testForcedErrors, d: testRowCount, e: testCancelledMeanwhile,
        f1: testVsDisbursement, f2: testVsEscrowWriter, g: testDeadlockBarrier, n: testTwoInvestmentsOneInvestor,
        h: testHttp, p: testConstraint, s: testStatic,
      };
      const order = ['a', 'b', 'c', 'd', 'e', 'f1', 'f2', 'g', 'n', 'h', 'p', 's'];
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
