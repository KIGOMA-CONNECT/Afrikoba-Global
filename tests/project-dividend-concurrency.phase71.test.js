#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step E0: payProjectDividends concurrency (B2, P1)
 *
 *  1. Two PARALLEL payProjectDividends calls for one project with PENDING
 *     payouts: each investor is paid exactly once (wallet +entitlement once,
 *     one CREDIT operation, one DR/CR journal pair), every payout row PAID
 *     once; one call pays, the other returns already_paid (no unclear error).
 *     Real synchronisation: the first call is held just before its COMMIT
 *     (after crediting wallets) until the second call is observed waiting on
 *     a lock (pg_stat_activity wait_event_type = 'Lock'), then released.
 *     Exact balances, CREDIT ops, journal rows, transactions and payout
 *     notifications are asserted per investor.
 *  1b. Lock held longer than the production lock_timeout (3 s): the second
 *     call gets ValidityError 409 DIVIDEND_PAYOUT_IN_PROGRESS (not raw 55P03,
 *     not already_paid); a third call after the first finishes returns
 *     already_paid; a non-55P03 error is not mapped.
 *  2. Row-count guard: the UPDATE ... WHERE status = 'PENDING' changing a
 *     different number of rows than were summed -> 409 DIVIDEND_STATE_CHANGED,
 *     whole payout rolled back (no credit, journal, PAID row, notification).
 *  3a. Deadlock, deterministic: barrier at creditWallet FOR UPDATE; without
 *     the users lock both payouts arrive holding KEY SHARE and deadlock.
 *  3b. Deadlock under load: the same investors entered in opposite order on two projects,
 *     two parallel calls per project: no 40P01, deadlocks counter unchanged,
 *     each investor paid once per project.
 *  1c. Forced 40P01 mid-payout -> 409 DIVIDEND_PAYOUT_IN_PROGRESS, logger.warn
 *     with code and projectId, nothing paid; retry pays once.
 *  1d. Forced 55P03 at stage "credit" (inside creditWallet, not the payout
 *     lock) -> the same 409, nothing paid, logger.warn shows stage + table/routine.
 *  4. Static: lock order payouts -> users -> creditWallet, only 55P03/40P01
 *     before COMMIT mapped, rowCount checked, txnRef format unchanged.
 *  6. HTTP: the real route + i18n + errorHandler via supertest: status and
 *     full JSON body for 409 DIVIDEND_PAYOUT_IN_PROGRESS and 409
 *     DIVIDEND_STATE_CHANGED (code reaches the client); a retry after the
 *     409, once call1 committed, returns 200 already_paid (no second payment).
 *  5. Scale (information): N investors (default 200), two parallel calls,
 *     duration recorded; each investor paid exactly once.
 *
 * axios is stubbed: no real network. Run with a connection logger preload.
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix>.
 * Usage:
 *   DB_NAME=phase71_financial_audit_<suffix> DB_USER=... DB_PASSWORD=... \
 *     node tests/project-dividend-concurrency.phase71.test.js
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

// Hard watchdog: never hang the CI run even if a pool.end() is stuck.
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
const projectFinance = require('../src/services/projectFinanceService');

const SERVICE_FILE = path.join(__dirname, '..', 'src', 'services', 'projectFinanceService.js');
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

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label) {
  seq += 1;
  const phone = `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const u = await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71E0 ${label} ${tag} ${seq}`, phone]
  );
  return u.rows[0].id;
}
async function makeProject(ownerId) {
  const r = await pool.query(
    `INSERT INTO projects (owner_user_id, name) VALUES ($1, $2) RETURNING id`,
    [ownerId, `P71E0 project ${tag} ${++seq}`]
  );
  return r.rows[0].id;
}
// entitlements: [[investorId, amount], ...] (several rows per investor allowed)
async function addPending(projectId, entitlements) {
  for (const [inv, amt] of entitlements) {
    await pool.query(
      `INSERT INTO project_investor_payouts (project_id, investor_user_id, entitlement, payout_reference)
       VALUES ($1, $2, $3, $4)`,
      [projectId, inv, amt, `P71E0-${tag}-${projectId}-u${inv}-${++seq}`]
    );
  }
}
async function snapshot(projectId, investors) {
  const wallets = {};
  for (const id of investors) {
    wallets[id] = Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [id])).rows[0].wallet_balance);
  }
  const like = `PROJECT_DIVIDEND_PAYOUT-%-${projectId}-u%`;
  const ops = (await pool.query(
    `SELECT user_id, COUNT(*)::int AS c FROM financial_operations
      WHERE operation_type = 'CREDIT' AND reference_id LIKE $1 GROUP BY user_id`, [like])).rows;
  const journal = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id LIKE $1`, [like])).rows[0].c;
  const txns = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM transactions WHERE reference_id LIKE $1`, [like])).rows[0].c;
  const payouts = (await pool.query(
    `SELECT status, COUNT(*)::int AS c FROM project_investor_payouts WHERE project_id = $1 GROUP BY status`,
    [projectId])).rows.reduce((m, r) => { m[r.status] = r.c; return m; }, {});
  const opsBy = {};
  for (const r of ops) opsBy[r.user_id] = r.c;
  const notes = {};
  const journalBy = {};
  const txnsBy = {};
  for (const id of investors) {
    const own = `PROJECT_DIVIDEND_PAYOUT-%-${projectId}-u${id}`;
    journalBy[id] = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM journal_entries WHERE reference_id LIKE $1`, [own])).rows[0].c;
    txnsBy[id] = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = $1 AND reference_id LIKE $2`, [id, like])).rows[0].c;
    notes[id] = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM notifications
        WHERE user_id = $1 AND entity_id = $2 AND title = 'Mgawanyo wa faida umelipwa'`,
      [id, projectId])).rows[0].c;
  }
  return { wallets, opsBy, journal, txns, payouts, notes, journalBy, txnsBy };
}

// ---- pool interception ------------------------------------------------------
// Wrap every client handed out by the pool so a test can hook query(text)
// before it runs (hook) and after it returns (afterHook).
// Timeouts: the PRODUCTION pool settings from src/config/db.js are kept on
// purpose (lock_timeout 3000 ms, idle_in_transaction_session_timeout 8000 ms):
// the 55P03 -> 409 contract must be exercised with the real 3 s limit, and a
// longer session lock_timeout leaks to pooled clients and can outlive the 8 s
// idle-in-transaction limit. Only statement_timeout is tightened (30 s -> 15 s)
// so a stuck statement fails clearly. A client 'error' listener records
// server-side terminations instead of crashing the process.
const STATEMENT_TIMEOUT = '15s';
const clientErrors = [];
const realPool = pool._getPool();
let hook = null;      // async (client, sql) => void
let afterHook = null; // (client, sql, result|error) => void
// Patch the RAW client once (no Proxy): src/config/db.js later does
// `origQuery = client.query.bind(client); client.query = ...`, which on a
// Proxy would write to the target and recurse forever. Chain stays linear:
// db.js wrapper -> this wrapper -> pg query. Callback-style calls (used by
// pg Pool.query internally) pass straight through without hooks.
function instrument(c) {
  if (c.__p71Instrumented) return c;
  c.__p71Instrumented = true;
  const orig = c.query.bind(c);
  c.query = function (...args) {
    if (typeof args[args.length - 1] === "function" || (!hook && !afterHook)) return orig(...args);
    const text = args[0];
    const sql = typeof text === "string" ? text : (text && text.text) || "";
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
    if (p === "connect") {
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
    return typeof v === "function" ? v.bind(t) : v;
  },
});

// Third, independent diagnostic connection (not from the app pool).
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
async function backendWaitingOnLock(pid) {
  const d = await diagClient();
  const r = await d.query(
    `SELECT wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity WHERE pid = $1`, [pid]);
  const row = r.rows[0];
  return row && row.wait_event_type === 'Lock' ? row : null;
}
async function dumpWaits(title) {
  try {
    const d = await diagClient();
    const act = await d.query(
      `SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
              left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS query
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY pid`);
    const locks = await d.query(
      `SELECT l.pid, l.locktype, l.mode, l.granted, c.relname
         FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND (NOT l.granted OR c.relname IN ('users', 'project_investor_payouts', 'financial_operations'))
        ORDER BY l.pid, c.relname`);
    console.log(`  [diag] ${title}: pg_stat_activity`);
    for (const r of act.rows) console.log(`    pid=${r.pid} state=${r.state} wait=${r.wait_event_type || '-'}/${r.wait_event || '-'} blocked_by=${JSON.stringify(r.blocked_by)} q=${r.query}`);
    console.log(`  [diag] ${title}: pg_locks (ungranted + key tables)`);
    for (const r of locks.rows) console.log(`    pid=${r.pid} ${r.locktype} ${r.mode} granted=${r.granted} rel=${r.relname || '-'}`);
  } catch (e) {
    console.log(`  [diag] ${title}: diagnostics failed: ${e.message}`);
  }
}

const ACTOR = { actorRole: 'ADMIN' };
const GATE_LIMIT_MS = 3000;
const SECTION_LIMIT_MS = 30000;
function progress(msg) { console.log(`  · ${msg}`); }

// ---------------------------------------------------------------------------

async function testParallelSameProject() {
  section('1. Two parallel payProjectDividends on one project');
  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const projectId = await makeProject(owner);
  await addPending(projectId, [[invA, 1000], [invA, 250.5], [invB, 400]]);
  const expected = { [invA]: 1250.5, [invB]: 400 };
  const before = await snapshot(projectId, [invA, invB]);
  const name = (id) => (id === invA ? 'A' : 'B');
  console.log(`  before: wallet A=${before.wallets[invA]} B=${before.wallets[invB]} CREDIT ops A=${before.opsBy[invA] || 0} B=${before.opsBy[invB] || 0} journal=${before.journal} payouts=${JSON.stringify(before.payouts)}`);

  // Label connections: the first BEGIN is call1; the first BEGIN after the
  // gate is reached is call2. Hold call1 just before its COMMIT (after it
  // credited wallets and marked rows PAID, inside its open transaction).
  const label = new Map(); // client -> 'call1' | 'call2'
  let gateReached;
  const reached = new Promise((r) => { gateReached = r; });
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  let gateIsHeld = false;
  let call2Pid = null;
  let call2Started;
  const call2Begun = new Promise((r) => { call2Started = r; });
  hook = async (client, sql) => {
    if (/^\s*BEGIN\b/i.test(sql) && !label.has(client)) {
      if (![...label.values()].includes('call1')) label.set(client, 'call1');
      else if (gateIsHeld && ![...label.values()].includes('call2')) {
        label.set(client, 'call2');
        call2Pid = client.processID;
        call2Started();
      }
    }
    if (label.get(client) === 'call1' && /^\s*COMMIT\b/i.test(sql) && !gateIsHeld) {
      gateIsHeld = true;
      progress(`call1 held before COMMIT (pid ${client.processID})`);
      gateReached();
      await gate;
    }
  };
  afterHook = (client, sql, res) => {
    const who = label.get(client);
    if (!who) return;
    if (res instanceof Error) progress(`${who} SQL error: ${res.code || ''} ${res.message}`);
    else if (/^\s*COMMIT\b/i.test(sql)) progress(`${who} committed (command tag ${res.command})`);
  };

  pool._setPool(interceptingPool);
  let r1;
  let r2;
  let gateReason = 'not reached';
  let timedOut = false;
  let sectionTimer;
  try {
    const work = (async () => {
      progress('call1 started');
      const p1 = safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
      const first = await Promise.race([reached.then(() => 'gate'), p1.then(() => 'done')]);
      expect(first === 'gate', 'call1 held before COMMIT with wallets already credited', first);
      progress('call2 started');
      const p2 = safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
      // Release the gate when call2's backend is seen waiting on a lock, or
      // after GATE_LIMIT_MS, whichever comes first. Never wait for call2 to finish.
      const t0 = Date.now();
      await Promise.race([call2Begun, sleep(GATE_LIMIT_MS)]);
      while (Date.now() - t0 < GATE_LIMIT_MS) {
        if (call2Pid) {
          const w = await backendWaitingOnLock(call2Pid);
          if (w) {
            gateReason = `call2 (pid ${call2Pid}) blocked on lock ${w.wait_event} by ${JSON.stringify(w.blockers)}`;
            break;
          }
        }
        const done2 = await Promise.race([p2.then(() => true), sleep(25).then(() => false)]);
        if (done2) { gateReason = 'call2 finished while call1 was held'; break; }
      }
      if (gateReason === 'not reached') gateReason = `gate limit ${GATE_LIMIT_MS} ms elapsed (call2 pid ${call2Pid || 'not seen'})`;
      progress(gateReason.startsWith('call2 (pid') ? `call2 blocked on lock -> ${gateReason}` : gateReason);
      progress('gate released');
      releaseGate();
      [r1, r2] = await Promise.all([p1, p2]);
      progress(`call1 finished: ${r1.error ? 'ERROR ' + r1.error : JSON.stringify({ paid: r1.value.paid.length, total: r1.value.total, already_paid: r1.value.already_paid })}`);
      progress(`call2 finished: ${r2.error ? 'ERROR ' + r2.error : JSON.stringify({ paid: r2.value.paid.length, total: r2.value.total, already_paid: r2.value.already_paid })}`);
    })();
    const limit = new Promise((resolve) => { sectionTimer = setTimeout(() => resolve('timeout'), SECTION_LIMIT_MS); });
    const outcome = await Promise.race([work.then(() => 'done'), limit]);
    if (outcome === 'timeout') {
      timedOut = true;
      await dumpWaits(`section limit ${SECTION_LIMIT_MS} ms reached`);
    }
  } finally {
    clearTimeout(sectionTimer);
    releaseGate();
    hook = null;
    afterHook = null;
    pool._setPool(realPool);
  }
  console.log(`  gate released by: ${gateReason}`);
  if (timedOut) {
    bad(`section 1 timed out after ${SECTION_LIMIT_MS} ms (see [diag] above)`);
    throw new Error('SECTION_TIMEOUT');
  }

  const after = await snapshot(projectId, [invA, invB]);
  console.log(`  after:  wallet A=${after.wallets[invA]} B=${after.wallets[invB]} CREDIT ops A=${after.opsBy[invA] || 0} B=${after.opsBy[invB] || 0} journal=${after.journal} payouts=${JSON.stringify(after.payouts)} notifications A=${after.notes[invA]} B=${after.notes[invB]}`);

  for (const id of [invA, invB]) {
    const delta = Math.round((after.wallets[id] - before.wallets[id]) * 100) / 100;
    expect(delta === expected[id], `investor ${name(id)} wallet increased exactly once (+${expected[id]})`, `delta=${delta}`);
    expect((after.opsBy[id] || 0) - (before.opsBy[id] || 0) === 1,
      `investor ${name(id)} has exactly one CREDIT operation`, `${after.opsBy[id] || 0}`);
    expect(after.journalBy[id] - before.journalBy[id] === 2,
      `investor ${name(id)} has exactly one DR/CR journal pair (2 rows)`, `${after.journalBy[id] - before.journalBy[id]}`);
    expect(after.txnsBy[id] === before.txnsBy[id] && after.txnsBy[id] === 0,
      `investor ${name(id)} transactions rows: 0 before, 0 after (this path writes none)`, `${before.txnsBy[id]} -> ${after.txnsBy[id]}`);
    expect(after.notes[id] - before.notes[id] === 1,
      `investor ${name(id)} receives exactly one payout notification`, `${after.notes[id] - before.notes[id]}`);
  }
  expect(after.wallets[invA] === 1250.5 && after.wallets[invB] === 400,
    'exact balances: A = 1250.50, B = 400.00', `A=${after.wallets[invA]} B=${after.wallets[invB]}`);
  expect(after.journal - before.journal === 4, 'journal: one DR/CR pair per investor (4 rows), not repeated', after.journal - before.journal);
  expect(after.txns === before.txns, 'transactions rows unchanged (this path writes none)', `${before.txns} -> ${after.txns}`);
  expect((after.payouts.PAID || 0) === 3 && !after.payouts.PENDING, 'all 3 payout rows PAID, none PENDING', JSON.stringify(after.payouts));

  const results = [r1, r2];
  const errors = results.filter((r) => r && r.error);
  expect(errors.length === 0, 'neither call fails with an error', errors.map((e) => e.error).join(' | '));
  const payers = results.filter((r) => r && r.value && r.value.paid && r.value.paid.length > 0);
  const already = results.filter((r) => r && r.value && r.value.already_paid === true && r.value.paid.length === 0);
  expect(payers.length === 1 && already.length === 1, 'one call pays, the other returns already_paid',
    JSON.stringify(results.map((r) => r && (r.error || { paid: r.value.paid.length, already_paid: r.value.already_paid }))));
  if (payers.length === 1) {
    expect(payers[0].value.total === 1650.5, 'paying call reports total 1650.5', payers[0].value.total);
  }
}

async function testLockTimeout() {
  section('1b. Lock held longer than lock_timeout (3 s) -> 409 DIVIDEND_PAYOUT_IN_PROGRESS, then already_paid');
  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const inv = await makeUser('inv');
  const projectId = await makeProject(owner);
  await addPending(projectId, [[inv, 300]]);
  const before = await snapshot(projectId, [inv]);

  // Hold call1 before its COMMIT (rows locked FOR UPDATE, wallet credited)
  // for longer than the production lock_timeout, and well under the 8 s
  // idle_in_transaction_session_timeout.
  let gateReached;
  const reached = new Promise((r) => { gateReached = r; });
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  let held = false;
  const touched = new WeakSet();
  hook = async (client, sql) => {
    if (/^\s*UPDATE\s+project_investor_payouts/i.test(sql)) touched.add(client);
    if (!held && touched.has(client) && /^\s*COMMIT\b/i.test(sql)) {
      held = true;
      progress(`call1 held before COMMIT (pid ${client.processID})`);
      gateReached();
      await gate;
    }
  };
  const loggerB = require('../src/utils/logger');
  const warnsB = [];
  const realWarnB = loggerB.warn;
  loggerB.warn = (scope, msg, meta) => { warnsB.push({ scope, msg: String(msg), meta }); };
  pool._setPool(interceptingPool);
  let r1;
  let r2;
  let waited = 0;
  try {
    const p1 = safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
    const first = await Promise.race([reached.then(() => 'gate'), p1.then(() => 'done'), sleep(10000).then(() => 'timeout')]);
    expect(first === 'gate', 'call1 held before COMMIT', first);
    progress('call2 started (call1 still holding the payout row locks)');
    const t0 = Date.now();
    r2 = await Promise.race([
      safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR })),
      sleep(7000).then(() => ({ error: 'TEST: call2 did not return within 7 s' })),
    ]);
    waited = Date.now() - t0;
    progress(`call2 returned after ${waited} ms: ${r2.error ? `${r2.err && r2.err.statusCode} ${r2.err && r2.err.code} ${r2.error}` : JSON.stringify(r2.value)}`);
    progress('gate released');
    releaseGate();
    r1 = await p1;
    progress(`call1 finished: ${r1.error ? 'ERROR ' + r1.error : JSON.stringify({ paid: r1.value.paid.length, total: r1.value.total })}`);
  } finally {
    releaseGate();
    hook = null;
    pool._setPool(realPool);
    loggerB.warn = realWarnB;
  }
  const wB = warnsB.find((x) => x.meta && x.meta.projectId === projectId);
  progress(`logger.warn meta: ${wB ? JSON.stringify(wB.meta) : 'none'}`);
  expect(!!wB && wB.meta.code === '55P03' && wB.meta.stage === 'payout-lock',
    'logger.warn: real 55P03 at stage "payout-lock"', wB && JSON.stringify(wB.meta));
  expect(r2.error === BUSY_MESSAGE, '409 message is the agreed text', r2.error);
  expect(!!r2.err && r2.err.statusCode === 409 && r2.err.code === 'DIVIDEND_PAYOUT_IN_PROGRESS',
    'call2: ValidityError 409 code DIVIDEND_PAYOUT_IN_PROGRESS (not a raw 55P03)',
    r2.error ? `${r2.err && r2.err.statusCode} ${r2.err && r2.err.code} ${r2.error}` : JSON.stringify(r2.value));
  expect(r2.err && r2.err.code !== '55P03' && /jaribu tena/i.test(r2.error || ''),
    'call2 message asks to retry later', r2.error);
  expect(waited >= 2500 && waited < 6000, 'call2 waited about the 3 s lock_timeout before giving up', `${waited} ms`);
  expect(!r1.error && r1.value.total === 300, 'call1 pays 300', r1.error || r1.value.total);

  const r3 = await safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
  expect(!r3.error && r3.value.already_paid === true && r3.value.paid.length === 0,
    'call3 after call1 finished: already_paid, nothing paid', r3.error || JSON.stringify(r3.value));
  const after = await snapshot(projectId, [inv]);
  expect(after.wallets[inv] - before.wallets[inv] === 300, 'wallet +300 exactly once', after.wallets[inv] - before.wallets[inv]);
  expect((after.opsBy[inv] || 0) === 1 && after.journalBy[inv] === 2 && after.notes[inv] === 1,
    'one CREDIT, one journal pair, one notification', JSON.stringify({ ops: after.opsBy[inv], journal: after.journalBy[inv], notes: after.notes[inv] }));

  // (b) Only 55P03 is translated: any other database error propagates unchanged.
  const other = await makeProject(owner);
  await addPending(other, [[inv, 10]]);
  hook = async (client, sql) => {
    if (/FOR UPDATE OF project_investor_payouts/i.test(sql)) {
      const e = new Error('TEST: simulated serialization failure');
      e.code = '40001';
      throw e;
    }
  };
  pool._setPool(interceptingPool);
  let r4;
  try {
    r4 = await safe(() => projectFinance.payProjectDividends({ projectId: other, actorUserId: admin, ...ACTOR }));
  } finally {
    hook = null;
    pool._setPool(realPool);
  }
  expect(!!r4.err && r4.err.code === '40001' && r4.err.statusCode === undefined,
    'a non-55P03 error on the lock statement is NOT mapped (code 40001 propagates as-is)',
    r4.error ? `${r4.err.code} ${r4.err.statusCode} ${r4.error}` : JSON.stringify(r4.value));
}

async function testForcedDeadlock() {
  section('1c. Forced 40P01 during the payout -> 409 DIVIDEND_PAYOUT_IN_PROGRESS, logged, nothing paid; retry pays once');
  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const projectId = await makeProject(owner);
  await addPending(projectId, [[invA, 120], [invB, 80]]);
  const before = await snapshot(projectId, [invA, invB]);
  const logger = require('../src/utils/logger');
  const warns = [];
  const realWarn = logger.warn;
  logger.warn = (scope, msg, meta) => { warns.push({ scope, msg: String(msg), meta }); };
  // Throw a deadlock error on the second investor's PENDING -> PAID update,
  // i.e. after the first investor was already credited inside the tx.
  let updates = 0;
  hook = async (client, sql) => {
    if (/^\s*UPDATE\s+project_investor_payouts/i.test(sql) && ++updates === 2) {
      const e = new Error('TEST: deadlock detected (forced)');
      e.code = '40P01';
      throw e;
    }
  };
  pool._setPool(interceptingPool);
  let r;
  try {
    r = await safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
  } finally {
    hook = null;
    pool._setPool(realPool);
    logger.warn = realWarn;
  }
  const after = await snapshot(projectId, [invA, invB]);
  progress(`result: ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value)}`);
  progress(`after wallet A=${after.wallets[invA]} B=${after.wallets[invB]} ops=${JSON.stringify(after.opsBy)} journal=${after.journal} payouts=${JSON.stringify(after.payouts)}`);
  expect(updates === 2, 'deadlock forced after the first investor was credited (inside the tx)', updates);
  expect(!!r.err && r.err.statusCode === 409 && r.err.code === 'DIVIDEND_PAYOUT_IN_PROGRESS',
    '40P01 -> ValidityError 409 DIVIDEND_PAYOUT_IN_PROGRESS', r.error ? `${r.err.statusCode} ${r.err.code}` : JSON.stringify(r.value));
  const w = warns.find((x) => x.meta && x.meta.code === '40P01' && x.meta.projectId === projectId);
  expect(!!w, 'logger.warn records code 40P01 and the projectId', JSON.stringify(warns));
  expect(!!w && w.meta.stage === 'mark-paid', 'logger.warn: stage "mark-paid"', w && JSON.stringify(w.meta));
  expect(r.error === BUSY_MESSAGE, '409 message is the agreed text', r.error);
  expect(after.wallets[invA] === before.wallets[invA] && after.wallets[invB] === before.wallets[invB],
    'no wallet credited (whole tx rolled back)', `A=${after.wallets[invA]} B=${after.wallets[invB]}`);
  expect(Object.keys(after.opsBy).length === 0 && after.journal === before.journal && after.payouts.PENDING === 2 && !after.payouts.PAID,
    'no CREDIT, no journal, both rows still PENDING', JSON.stringify({ ops: after.opsBy, journal: after.journal, payouts: after.payouts }));
  expect(after.notes[invA] === 0 && after.notes[invB] === 0, 'no payout notification');
  const retry = await safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
  const fin2 = await snapshot(projectId, [invA, invB]);
  expect(!retry.error && fin2.wallets[invA] === 120 && fin2.wallets[invB] === 80 && fin2.opsBy[invA] === 1 && fin2.opsBy[invB] === 1,
    'retry pays A=120, B=80 exactly once', retry.error || JSON.stringify({ w: fin2.wallets, ops: fin2.opsBy }));
}

async function testScale() {
  section('5. Scale (information for the backlog): one project with many investors');
  const N = Number(process.env.P71_SCALE_INVESTORS || 200);
  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const projectId = await makeProject(owner);
  const ids = [];
  for (let k = 0; k < N; k++) ids.push(await makeUser(`s${k}`));
  await addPending(projectId, ids.map((id) => [id, 1]));
  // Timings per client (pg pid): when the payout lock statement was sent and
  // returned, and when COMMIT returned. Lets the backlog separate
  //  - call1 time in the locked section (payout lock granted -> COMMIT done),
  //  - call1 total (incl. post-COMMIT audit/notifications/outbox),
  //  - call2 lock wait (payout lock statement sent -> returned).
  const tm = new Map(); // pid -> { lockSent, lockDone, commitDone }
  const rec = (c) => { if (!tm.has(c.processID)) tm.set(c.processID, {}); return tm.get(c.processID); };
  hook = async (c, sql) => { if (/FOR UPDATE OF project_investor_payouts/.test(sql)) rec(c).lockSent = Date.now(); };
  afterHook = (c, sql) => {
    if (/FOR UPDATE OF project_investor_payouts/.test(sql)) rec(c).lockDone = Date.now();
    else if (/^\s*COMMIT\b/i.test(sql) && tm.has(c.processID)) rec(c).commitDone = Date.now();
  };
  pool._setPool(interceptingPool);
  const t0 = Date.now();
  let a;
  let b;
  let doneA;
  let doneB;
  try {
    [a, b] = await Promise.all([
      safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR })).then((r) => { doneA = Date.now(); return r; }),
      sleep(50).then(() => safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }))).then((r) => { doneB = Date.now(); return r; }),
    ]);
  } finally {
    hook = null;
    afterHook = null;
    pool._setPool(realPool);
  }
  const ms = Date.now() - t0;
  const outcome = (r) => (r.error ? `${r.err.statusCode} ${r.err.code}` : (r.value.already_paid ? 'already_paid' : `paid ${r.value.paid.length}`));
  progress(`N=${N} investors: both calls done in ${ms} ms; call1=${outcome(a)} call2=${outcome(b)}`);
  const ts = [...tm.values()].filter((x) => x.lockSent).sort((x, y) => x.lockDone - y.lockDone);
  if (ts.length === 2) {
    const [first, second] = ts;
    const aPaid = !a.error && !a.value.already_paid;
    first.payerTotal = aPaid ? doneA - t0 : doneB - (t0 + 50);
    progress(`N=${N} timing: payer locked section (lock granted -> COMMIT done) ${first.commitDone - first.lockDone} ms;`
      + ` payer call total (incl. post-COMMIT work) ${first.payerTotal} ms;`
      + ` waiter lock wait (lock sent -> returned) ${second.lockDone - second.lockSent} ms;`
      + ` both calls ${ms} ms`);
  }
  const credited = (await pool.query(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(wallet_balance),0)::numeric AS s FROM users WHERE id = ANY($1::int[])`, [ids])).rows[0];
  const ops = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM financial_operations WHERE operation_type = 'CREDIT' AND reference_id LIKE $1`,
    [`PROJECT_DIVIDEND_PAYOUT-%-${projectId}-u%`])).rows[0].c;
  expect(Number(credited.s) === N && ops === N, `N=${N}: each investor paid exactly once (sum ${N}, ${N} CREDIT ops)`, `sum=${credited.s} ops=${ops}`);
  const okOutcomes = [a, b].every((r) => !r.error || (r.err.statusCode === 409 && r.err.code === 'DIVIDEND_PAYOUT_IN_PROGRESS'));
  expect(okOutcomes, 'second call ends as already_paid or 409 DIVIDEND_PAYOUT_IN_PROGRESS (no raw error)', `${outcome(a)} / ${outcome(b)}`);
}

const BUSY_MESSAGE = 'Malipo hayakukamilika kwa sababu ya shughuli nyingine zinazoendelea. Hakuna kilicholipwa. Jaribu tena baadaye.';
const STATE_CHANGED_MESSAGE = 'Hali ya malipo ya mgawanyo imebadilika wakati wa kulipa; hakuna kilicholipwa, jaribu tena.';

async function testForcedLockTimeoutAtCredit() {
  section('1d. Forced 55P03 at stage "credit" (not the payout lock) -> same 409, nothing paid, stage logged');
  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const invA = await makeUser('invA');
  const invB = await makeUser('invB');
  const projectId = await makeProject(owner);
  await addPending(projectId, [[invA, 60], [invB, 40]]);
  const before = await snapshot(projectId, [invA, invB]);
  const logger = require('../src/utils/logger');
  const warns = [];
  const realWarn = logger.warn;
  logger.warn = (scope, msg, meta) => { warns.push({ scope, msg: String(msg), meta }); };
  // creditWallet's first statement is the financial_operations claim. Fail the
  // SECOND investor's claim with 55P03, after the first investor was credited.
  let claims = 0;
  hook = async (client, sql) => {
    if (/^\s*INSERT INTO financial_operations/i.test(sql) && ++claims === 2) {
      const e = new Error('TEST: canceling statement due to lock timeout (forced)');
      e.code = '55P03';
      e.table = 'financial_operations';
      e.routine = 'ProcessInterrupts';
      throw e;
    }
  };
  pool._setPool(interceptingPool);
  let r;
  try {
    r = await safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
  } finally {
    hook = null;
    pool._setPool(realPool);
    logger.warn = realWarn;
  }
  const after = await snapshot(projectId, [invA, invB]);
  const w = warns.find((x) => x.meta && x.meta.projectId === projectId);
  progress(`result: ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value)}`);
  progress(`logger.warn meta: ${w ? JSON.stringify(w.meta) : 'none'}`);
  expect(claims === 2, '55P03 forced inside creditWallet of the 2nd investor (1st already credited in the tx)', claims);
  expect(!!r.err && r.err.statusCode === 409 && r.err.code === 'DIVIDEND_PAYOUT_IN_PROGRESS' && r.error === BUSY_MESSAGE,
    'same 409 DIVIDEND_PAYOUT_IN_PROGRESS with the new message', r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value));
  expect(!!w && w.meta.code === '55P03' && w.meta.stage === 'credit',
    'logger.warn: code 55P03, stage "credit"', w && JSON.stringify(w.meta));
  expect(!!w && w.meta.table === 'financial_operations' && w.meta.routine === 'ProcessInterrupts',
    'logger.warn carries e.table and e.routine when present', w && JSON.stringify(w.meta));
  expect(after.wallets[invA] === before.wallets[invA] && after.wallets[invB] === before.wallets[invB]
    && Object.keys(after.opsBy).length === 0 && after.journal === before.journal,
    'nothing paid: wallets, CREDIT operations and journal unchanged',
    JSON.stringify({ w: after.wallets, ops: after.opsBy, journal: after.journal }));
  expect(after.payouts.PENDING === 2 && !after.payouts.PAID && after.notes[invA] === 0 && after.notes[invB] === 0,
    'both payout rows still PENDING, no notification', JSON.stringify(after.payouts));
}

async function testRowCountGuard() {
  section('2. Row-count guard: rowCount != rows summed -> clear error, whole payout rolled back');
  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const inv = await makeUser('inv');
  const projectId = await makeProject(owner);
  await addPending(projectId, [[inv, 500]]);
  // An already-PAID row of the same investor: it is not PENDING, so it is not
  // locked or summed. Flipping it back to PENDING from another connection
  // right before the UPDATE needs no lock the payout holds (no FK change),
  // so the UPDATE ... WHERE status = 'PENDING' changes 2 rows while 1 was summed.
  const flip = (await pool.query(
    `INSERT INTO project_investor_payouts (project_id, investor_user_id, entitlement, payout_reference, status, paid_at)
     VALUES ($1, $2, 75, $3, 'PAID', NOW()) RETURNING id`,
    [projectId, inv, `P71E0-${tag}-flip-${projectId}`])).rows[0].id;
  const before = await snapshot(projectId, [inv]);

  let injected = false;
  hook = async (client, sql) => {
    if (!injected && /^\s*UPDATE\s+project_investor_payouts/i.test(sql)) {
      injected = true;
      const d = await diagClient();
      await d.query(`UPDATE project_investor_payouts SET status = 'PENDING', paid_at = NULL WHERE id = $1`, [flip]);
      progress(`row ${flip} flipped PAID -> PENDING by another connection before the UPDATE`);
    }
  };
  pool._setPool(interceptingPool);
  let r;
  try {
    r = await safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
  } finally {
    hook = null;
    pool._setPool(realPool);
  }
  const after = await snapshot(projectId, [inv]);
  progress(`result: ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : JSON.stringify(r.value)}`);
  progress(`before wallet=${before.wallets[inv]} ops=${before.opsBy[inv] || 0} journal=${before.journalBy[inv]} payouts=${JSON.stringify(before.payouts)}`);
  progress(`after  wallet=${after.wallets[inv]} ops=${after.opsBy[inv] || 0} journal=${after.journalBy[inv]} payouts=${JSON.stringify(after.payouts)}`);
  expect(injected, 'mismatch injected between aggregation and UPDATE');
  expect(!!r.err && r.err.statusCode === 409 && r.err.code === 'DIVIDEND_STATE_CHANGED',
    'call fails with a clear 409 DIVIDEND_STATE_CHANGED', r.error || JSON.stringify(r.value));
  expect(after.wallets[inv] === before.wallets[inv], 'wallet unchanged (credit rolled back)', `${before.wallets[inv]} -> ${after.wallets[inv]}`);
  expect((after.opsBy[inv] || 0) === (before.opsBy[inv] || 0) && after.journalBy[inv] === before.journalBy[inv],
    'no CREDIT operation and no journal rows kept', `ops=${after.opsBy[inv] || 0} journal=${after.journalBy[inv]}`);
  expect(!after.payouts.PAID && after.payouts.PENDING === 2, 'nothing marked PAID by the failed payout; 2 rows PENDING', JSON.stringify(after.payouts));
  expect(after.notes[inv] === before.notes[inv], 'no payout notification sent', after.notes[inv] - before.notes[inv]);

  // A clean retry pays both rows once.
  const retry = await safe(() => projectFinance.payProjectDividends({ projectId, actorUserId: admin, ...ACTOR }));
  const final = await snapshot(projectId, [inv]);
  expect(!retry.error && retry.value.total === 575 && final.wallets[inv] - before.wallets[inv] === 575 && final.payouts.PAID === 2,
    'retry pays 575 once and marks both rows PAID', retry.error || `total=${retry.value.total} payouts=${JSON.stringify(final.payouts)}`);
}

// HTTP contract: the REAL route POST /api/v1/projects/:id/dividend/payout
// (src/routes/projectRoutes.js, with its authRequired + requireRoles) behind
// the REAL i18n middleware and errorHandler, driven by supertest. Only these
// three pieces are mounted (no other server.js middleware), so the assertions
// are about route -> service -> errorHandler -> localizeError.
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
async function makeAdminToken() {
  const id = await makeUser('http-admin');
  const u = (await pool.query(
    `UPDATE users SET role = 'ADMIN' WHERE id = $1 RETURNING id, role, phone_number, auth_version`, [id])).rows[0];
  return { id, token: require('../src/middleware/auth').signToken(u) };
}

async function testHttpContract() {
  section('6. HTTP: real route + errorHandler -> status, full body, code reaches the client');
  const request = require('supertest');
  const app = httpApp();
  const { token } = await makeAdminToken();
  const post = (projectId) => request(app)
    .post(`/api/v1/projects/${projectId}/dividend/payout`)
    .set('Authorization', `Bearer ${token}`);
  const owner = await makeUser('owner');
  const loggerH = require('../src/utils/logger');
  const realWarnH = loggerH.warn;
  const realErrorH = loggerH.error;
  const warnsH = [];

  // (a) 409 DIVIDEND_PAYOUT_IN_PROGRESS: call1 (service) holds the payout row
  // locks before its COMMIT; the HTTP call waits the real 3 s lock_timeout.
  const invA = await makeUser('inv');
  const pA = await makeProject(owner);
  await addPending(pA, [[invA, 210]]);
  const beforeA = await snapshot(pA, [invA]);
  let gateReached;
  const reached = new Promise((r) => { gateReached = r; });
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  let held = false;
  const touched = new WeakSet();
  hook = async (client, sql) => {
    if (/^\s*UPDATE\s+project_investor_payouts/i.test(sql)) touched.add(client);
    if (!held && touched.has(client) && /^\s*COMMIT\b/i.test(sql)) {
      held = true;
      gateReached();
      await gate;
    }
  };
  loggerH.warn = (scope, msg, meta) => { warnsH.push({ scope, msg: String(msg), meta }); };
  loggerH.error = () => {};
  pool._setPool(interceptingPool);
  let resBusy;
  let r1;
  let resAfter;
  try {
    const p1 = safe(() => projectFinance.payProjectDividends({ projectId: pA, actorUserId: owner, ...ACTOR }));
    const first = await Promise.race([reached.then(() => 'gate'), p1.then(() => 'done'), sleep(10000).then(() => 'timeout')]);
    expect(first === 'gate', 'http(a): call1 held before COMMIT', first);
    resBusy = await post(pA);
    releaseGate();
    r1 = await p1;
    // (3) retry "later", after call1 committed: must not pay again.
    resAfter = await post(pA);
  } finally {
    releaseGate();
    hook = null;
    pool._setPool(realPool);
    loggerH.warn = realWarnH;
    loggerH.error = realErrorH;
  }
  console.log(`  HTTP ${resBusy.status} ${JSON.stringify(resBusy.body)}`);
  expect(resBusy.status === 409, 'http(a): status 409', resBusy.status);
  expect(JSON.stringify(resBusy.body) === JSON.stringify({ success: false, code: 'DIVIDEND_PAYOUT_IN_PROGRESS', message: BUSY_MESSAGE }),
    'http(a): body is exactly { success:false, code:"DIVIDEND_PAYOUT_IN_PROGRESS", message:<agreed text> }', JSON.stringify(resBusy.body));
  const wH = warnsH.find((x) => x.meta && x.meta.projectId === pA);
  expect(!!wH && wH.meta.stage === 'payout-lock' && wH.meta.code === '55P03', 'http(a): logger.warn stage payout-lock, 55P03', wH && JSON.stringify(wH.meta));
  expect(!r1.error && r1.value.total === 210, 'http(a): call1 paid 210', r1.error || r1.value.total);
  console.log(`  HTTP retry after call1: ${resAfter.status} ${JSON.stringify(resAfter.body)}`);
  expect(resAfter.status === 200 && resAfter.body.already_paid === true && resAfter.body.total === 0,
    'http(a) retry after the 409: 200 already_paid, total 0', JSON.stringify(resAfter.body));
  const afterA = await snapshot(pA, [invA]);
  expect(afterA.wallets[invA] - beforeA.wallets[invA] === 210 && (afterA.opsBy[invA] || 0) === 1
    && afterA.journalBy[invA] === 2 && afterA.notes[invA] === 1 && afterA.payouts.PAID === 1 && !afterA.payouts.PENDING,
    'http(a): investor paid exactly once (+210, 1 CREDIT, 1 journal pair, 1 notification, row PAID)',
    JSON.stringify({ d: afterA.wallets[invA] - beforeA.wallets[invA], ops: afterA.opsBy[invA], j: afterA.journalBy[invA], n: afterA.notes[invA], p: afterA.payouts }));

  // (b) 409 DIVIDEND_STATE_CHANGED via the same route.
  const invB = await makeUser('inv');
  const pB = await makeProject(owner);
  await addPending(pB, [[invB, 500]]);
  const flip = (await pool.query(
    `INSERT INTO project_investor_payouts (project_id, investor_user_id, entitlement, payout_reference, status, paid_at)
     VALUES ($1, $2, 75, $3, 'PAID', NOW()) RETURNING id`,
    [pB, invB, `P71E0-${tag}-httpflip-${pB}`])).rows[0].id;
  const beforeB = await snapshot(pB, [invB]);
  let injected = false;
  hook = async (client, sql) => {
    if (!injected && /^\s*UPDATE\s+project_investor_payouts/i.test(sql)) {
      injected = true;
      const d = await diagClient();
      await d.query(`UPDATE project_investor_payouts SET status = 'PENDING', paid_at = NULL WHERE id = $1`, [flip]);
    }
  };
  loggerH.error = () => {};
  pool._setPool(interceptingPool);
  let resChanged;
  try {
    resChanged = await post(pB);
  } finally {
    hook = null;
    pool._setPool(realPool);
    loggerH.error = realErrorH;
  }
  console.log(`  HTTP ${resChanged.status} ${JSON.stringify(resChanged.body)}`);
  expect(injected, 'http(b): mismatch injected');
  expect(resChanged.status === 409, 'http(b): status 409', resChanged.status);
  expect(JSON.stringify(resChanged.body) === JSON.stringify({ success: false, code: 'DIVIDEND_STATE_CHANGED', message: STATE_CHANGED_MESSAGE }),
    'http(b): body is exactly { success:false, code:"DIVIDEND_STATE_CHANGED", message:<service text> }', JSON.stringify(resChanged.body));
  const afterB = await snapshot(pB, [invB]);
  expect(afterB.wallets[invB] === beforeB.wallets[invB] && (afterB.opsBy[invB] || 0) === 0 && !afterB.payouts.PAID,
    'http(b): nothing paid, nothing marked PAID', JSON.stringify({ w: [beforeB.wallets[invB], afterB.wallets[invB]], p: afterB.payouts }));
}

async function testNoDeadlockBarrier() {
  section('3a. Deadlock (deterministic): two projects, shared investor, barrier at creditWallet FOR UPDATE');
  // Both payouts are held at creditWallet's `SELECT wallet_balance ... FOR UPDATE`
  // until BOTH have arrived (or BARRIER_MS passes). Without the users lock,
  // both arrive holding FOR KEY SHARE on the investor (claimOperation's FK
  // insert) and the upgrade deadlocks for certain. With the users lock, the
  // second payout blocks earlier on the users row, so only one arrives.
  const BARRIER_MS = 2000;
  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const inv = await makeUser('shared');
  const pX = await makeProject(owner);
  const pY = await makeProject(owner);
  await addPending(pX, [[inv, 11]]);
  await addPending(pY, [[inv, 22]]);
  const deadlocksBefore = Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
  const w0 = (await snapshot(pX, [inv])).wallets[inv];

  let arrivals = 0;
  let releaseAll;
  const allArrived = new Promise((r) => { releaseAll = r; });
  let barrierResult = 'not reached';
  let barrierOpen = true; // closes when the first waiter times out
  const seen = new WeakSet();
  hook = async (client, sql) => {
    if (/SELECT wallet_balance FROM users WHERE id = \$1 FOR UPDATE/.test(sql) && !seen.has(client)) {
      seen.add(client);
      if (!barrierOpen) {
        progress(`barrier: late arrival (pid ${client.processID}) after the barrier timed out: not counted`);
        return;
      }
      arrivals += 1;
      progress(`barrier: arrival ${arrivals} (pid ${client.processID})`);
      if (arrivals >= 2) { barrierResult = 'both payouts arrived holding KEY SHARE'; releaseAll(); return; }
      const t = await Promise.race([allArrived.then(() => 'all'), sleep(BARRIER_MS).then(() => 'timeout')]);
      if (t === 'timeout') {
        barrierOpen = false;
        barrierResult = `only one arrival within ${BARRIER_MS} ms (the other payout was blocked earlier, on the users lock)`;
      }
    }
  };
  pool._setPool(interceptingPool);
  let res;
  try {
    res = await Promise.all([
      safe(() => projectFinance.payProjectDividends({ projectId: pX, actorUserId: admin, ...ACTOR })),
      safe(() => projectFinance.payProjectDividends({ projectId: pY, actorUserId: admin, ...ACTOR })),
    ]);
  } finally {
    releaseAll();
    hook = null;
    pool._setPool(realPool);
  }
  progress(`barrier result: ${barrierResult}`);
  for (const [k, r] of res.entries()) progress(`call${k + 1}: ${r.error ? `${r.err.statusCode} ${r.err.code} ${r.error}` : `paid ${r.value.paid.length} total ${r.value.total}`}`);
  await sleep(1200);
  const deadlocksAfter = Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
  const w1 = (await snapshot(pX, [inv])).wallets[inv];
  const errs = res.filter((r) => r.error);
  expect(arrivals === 1, 'only one payout reached creditWallet while the other was held (users lock serialises them)', barrierResult);
  expect(errs.length === 0, 'both payouts succeed: no 40P01 and no 409', errs.map((r) => `${r.err.code} ${r.error}`).join(' | '));
  expect(deadlocksAfter === deadlocksBefore, 'pg_stat_database.deadlocks unchanged', `${deadlocksBefore} -> ${deadlocksAfter}`);
  expect(w1 - w0 === 33, 'shared investor paid 11 + 22 = 33 exactly once each', w1 - w0);
}

async function testNoDeadlock() {
  section('3b. Deadlock (load): the same investors entered in opposite order on two projects, 4 parallel calls');
  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const i1 = await makeUser('i1');
  const i2 = await makeUser('i2');
  const i3 = await makeUser('i3');
  const pX = await makeProject(owner);
  const pY = await makeProject(owner);
  await addPending(pX, [[i1, 10], [i2, 20], [i3, 30]]);
  await addPending(pY, [[i3, 7], [i2, 8], [i1, 9]]);
  const deadlocksBefore = Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
  const w0 = (await snapshot(pX, [i1, i2, i3])).wallets;
  const calls = [];
  for (let k = 0; k < 2; k++) {
    calls.push(safe(() => projectFinance.payProjectDividends({ projectId: pX, actorUserId: admin, ...ACTOR })));
    calls.push(safe(() => projectFinance.payProjectDividends({ projectId: pY, actorUserId: admin, ...ACTOR })));
  }
  const res = await Promise.all(calls);
  const errs = res.filter((r) => r.error).map((r) => r.error);
  expect(errs.length === 0, 'all 4 parallel calls finish without error (no deadlock)', errs.join(' | '));
  expect(!errs.some((e) => /deadlock/i.test(e)), 'no deadlock error (40P01) returned');
  await sleep(1200); // pg_stat_database is flushed asynchronously
  const deadlocksAfter = Number((await pool.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
  expect(deadlocksAfter === deadlocksBefore, 'pg_stat_database.deadlocks unchanged', `${deadlocksBefore} -> ${deadlocksAfter}`);
  const paidCalls = res.filter((r) => r.value && r.value.paid.length > 0).length;
  const noops = res.filter((r) => r.value && r.value.already_paid === true).length;
  expect(paidCalls === 2 && noops === 2, 'one paying call and one already_paid per project', `paid=${paidCalls} already_paid=${noops}`);
  const w1 = (await snapshot(pX, [i1, i2, i3])).wallets;
  const want = { [i1]: 19, [i2]: 28, [i3]: 37 };
  const deltas = [i1, i2, i3].map((id) => Math.round((w1[id] - w0[id]) * 100) / 100);
  expect(deltas[0] === want[i1] && deltas[1] === want[i2] && deltas[2] === want[i3],
    'each investor paid once per project (19, 28, 37)', JSON.stringify(deltas));
  const pend = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM project_investor_payouts WHERE project_id IN ($1, $2) AND status = 'PENDING'`,
    [pX, pY])).rows[0].c;
  expect(pend === 0, 'no PENDING rows left on either project', pend);
}

async function testStatic() {
  section('4. Static: FOR UPDATE OF payouts in investor order, 55P03 mapping, rowCount check');
  const src = fs.readFileSync(SERVICE_FILE, 'utf8');
  const start = src.indexOf('async function payProjectDividends(');
  const end = src.indexOf('\n}\n', start);
  const fn = start >= 0 ? src.slice(start, end) : '';
  expect(fn.length > 0, 'payProjectDividends found');
  expect(/status\s*=\s*'PENDING'\s*ORDER BY investor_user_id, id\s*FOR UPDATE OF project_investor_payouts/.test(fn),
    "PENDING rows locked: ... ORDER BY investor_user_id, id FOR UPDATE OF project_investor_payouts");
  expect(/FOR UPDATE OF project_investor_payouts[\s\S]*?SELECT id FROM users WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR UPDATE[\s\S]*?fin\.creditWallet/.test(fn),
    'lock order: payouts (ORDER BY investor_user_id) -> users (ORDER BY id) -> first creditWallet');
  expect(/!committed && e && \(e\.code === '55P03' \|\| e\.code === '40P01'\)[\s\S]{0,1200}DIVIDEND_PAYOUT_IN_PROGRESS[\s\S]{0,60}throw busy;\s*\}\s*throw e;/.test(fn),
    'only 55P03 / 40P01 before COMMIT map to DIVIDEND_PAYOUT_IN_PROGRESS; other errors rethrown');
  expect(/await client\.query\('COMMIT'\);\s*committed = true;/.test(fn), 'committed flag set right after COMMIT');
  expect(/stage = 'payout-lock';\s*await client\.query\(\s*`SELECT id FROM project_investor_payouts/.test(fn)
    && /stage = 'users-lock';\s*await client\.query\(\s*'SELECT id FROM users/.test(fn)
    && /stage = 'credit';\s*const res = await fin\.creditWallet/.test(fn)
    && /stage = 'mark-paid';\s*const marked = await client\.query/.test(fn),
    'stage set right before payout-lock, users-lock, credit and mark-paid');
  expect(/\{ code: e\.code, projectId, stage, table: e\.table \|\| null, routine: e\.routine \|\| null \}/.test(fn),
    'logger.warn meta: code, projectId, stage, table, routine');
  expect(/rowCount\s*!==\s*Number\(row\.row_count\)|rowCount\s*!==\s*row\.row_count/.test(fn),
    'UPDATE PENDING -> PAID checks rowCount against row_count');
  expect(/generateReference\('PROJECT_DIVIDEND_PAYOUT'\)\}-\$\{projectId\}/.test(fn), 'txnRef format unchanged');
}

// ---------------------------------------------------------------------------

(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr,
              inet_server_addr()::text AS addr, inet_server_port() AS port`
    );
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);

    const silenced = console.error;
    console.error = () => {};
    try {
      const all = { 1: testParallelSameProject, '1b': testLockTimeout, '1c': testForcedDeadlock, '1d': testForcedLockTimeoutAtCredit, 2: testRowCountGuard, '3a': testNoDeadlockBarrier, 3: testNoDeadlock, 4: testStatic, 5: testScale, 6: testHttpContract };
      const order = ['1', '1b', '1c', '1d', '2', '6', '3a', '3', '4', '5'];
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
