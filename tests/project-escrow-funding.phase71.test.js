#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Remediation OBS-7: escrow funding projection
 *   projectService.invest                (src/services/projectService.js)
 *   projectFinance.onFundingReceived     (src/services/projectFinanceService.js)
 *   forceCloseFunding / refundInvestment (refund and cancellation paths)
 *
 * Before: invest COMMITted, then a separate best-effort step read amount_raised
 * without a lock and overwrote controlled_project_accounts (escrow_balance =
 * remaining_balance = amount_raised) and froze the waterfall rule. A stale step
 * could restore escrow after a refund; a failed step left invest "successful"
 * with no escrow and an unfrozen rule.
 *
 * Required behaviour:
 *  1. Investment concurrent with cancellation/refund: consistent either way.
 *  2. A funding callback after project closure never restores escrow.
 *  3. Escrow/freeze failure fails the whole investment (rollback), not "success".
 *  4. Duplicate callback / duplicate reference: no double credit.
 *  5. Concurrent investments by different investors: consistent.
 *  6. Refund followed by a delayed funding synchronisation: escrow not restored.
 *  7. Reconciliation: amount_raised = CONFIRMED sum = PROJECT ledger net =
 *     escrow remaining (escrow_balance >= remaining).
 *  8. Failure injection at every financial write boundary of invest: full rollback.
 *  9. Static: escrow and freeze happen inside invest's transaction, after the
 *     project row lock; onFundingReceived writes no escrow and no rule.
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

// ---- query interception (failure injection + post-commit pause) -------------
// Every pool/client query goes through pg.Client.prototype.query.
let inject = null;           // { re, label } -> next matching query throws
let pauseEscrowSync = null;  // { gate, hit } -> next escrow write via the pool waits
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function patched(...args) {
  const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null; // pg-pool uses callbacks
  if (inject && inject.re.test(sql)) {
    const err = new Error(`TEST: injected failure at ${inject.label}`);
    inject = null;
    if (cb) { setImmediate(() => cb(err)); return undefined; }
    return Promise.reject(err);
  }
  if (pauseEscrowSync && /(INSERT INTO|UPDATE)\s+controlled_project_accounts/i.test(sql) && !this.__inTxn) {
    const p = pauseEscrowSync;
    pauseEscrowSync = null;
    p.hit();
    if (cb) { p.gate.then(() => origQuery.apply(this, args)); return undefined; }
    return p.gate.then(() => origQuery.apply(this, args));
  }
  if (/^\s*BEGIN/i.test(sql)) this.__inTxn = true;
  if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) this.__inTxn = false;
  return origQuery.apply(this, args);
};

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label, role, wallet = 0) {
  seq += 1;
  const phone = `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71ESC ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  if (wallet) await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [wallet, id]);
  return id;
}
async function makeProject({ rule = false, capital = 10000 } = {}) {
  const owner = await makeUser('owner');
  const id = (await pool.query(
    `INSERT INTO projects (owner_user_id, name, status, capital_required, amount_raised)
     VALUES ($1, $2, 'FUNDING', $3, 0) RETURNING id`,
    [owner, `P71ESC project ${tag} ${++seq}`, capital])).rows[0].id;
  if (rule) {
    await pool.query(
      `INSERT INTO waterfall_allocation_rules (project_id, version, status, investor_dividend_percentage, owner_residual_percentage)
       VALUES ($1, 1, 'ACTIVE', 60, 40)`, [id]);
  }
  return { projectId: id, owner };
}
const ref = (pid, s) => `P71ESC-${tag}-${pid}-${s}`;
const invest = (u, pid, amount, s) => projectService.invest(u, pid, { amount, unique_reference: ref(pid, s) });
async function wallet(u) { return Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [u])).rows[0].wallet_balance); }

// amount_raised, CONFIRMED sum, PROJECT ledger net (CR invest refs - DR refund refs), escrow.
async function recon(pid) {
  const one = async (sql) => (await pool.query(sql, [pid])).rows[0];
  const p = await one('SELECT status, amount_raised FROM projects WHERE id = $1');
  const inv = await one(`SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'CONFIRMED'),0)::numeric AS conf,
                                COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int AS nconf,
                                COUNT(*) FILTER (WHERE status = 'REFUNDED')::int AS nref
                           FROM project_investments WHERE project_id = $1`);
  const led = await one(
    `SELECT COALESCE(SUM(CASE WHEN je.direction = 'CR' THEN je.amount ELSE -je.amount END),0)::numeric AS net
       FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id
      WHERE la.account_code = 'PROJECT_INVESTMENT_ACCOUNT'
        AND je.reference_id IN (SELECT unique_reference FROM project_investments WHERE project_id = $1
                                UNION SELECT refund_reference FROM project_investments WHERE project_id = $1 AND refund_reference IS NOT NULL)`);
  const e = (await pool.query('SELECT escrow_balance, remaining_balance, status FROM controlled_project_accounts WHERE project_id = $1', [pid])).rows[0];
  const rule = (await pool.query('SELECT status FROM waterfall_allocation_rules WHERE project_id = $1 ORDER BY version DESC LIMIT 1', [pid])).rows[0];
  return {
    project: p.status, raised: Number(p.amount_raised), confirmed: Number(inv.conf), nconf: inv.nconf, nref: inv.nref,
    ledger: Number(led.net),
    escrow: e ? { remaining: Number(e.remaining_balance), gross: Number(e.escrow_balance), status: e.status } : null,
    rule: rule ? rule.status : null,
  };
}
function reconciles(r) {
  const rem = r.escrow ? r.escrow.remaining : 0;
  const grossOk = !r.escrow || r.escrow.gross >= r.escrow.remaining;
  return r.raised === r.confirmed && r.confirmed === r.ledger && r.ledger === rem && grossOk;
}
const admin = { id: null };
async function refundAll(pid) { return pf.forceCloseFunding(admin.id, 'ADMIN', pid, { action: 'REFUND' }); }

// ---------------------------------------------------------------------------
async function testInvestThenRefundWithDelayedSync() {
  section('1/6. Investment committed, delayed sync, then REFUND -> escrow NOT restored');
  const pr = await makeProject();
  const a = await makeUser('A', null, 1000);
  const b = await makeUser('B', null, 1000);
  await invest(a, pr.projectId, 300, 'a');
  let release; let hit;
  const gate = new Promise((r) => { release = r; });
  const hitP = new Promise((r) => { hit = r; });
  pauseEscrowSync = { gate, hit };
  const investB = invest(b, pr.projectId, 200, 'b');
  const settledB = investB.then(() => 'OK', (e) => e.message);
  await Promise.race([hitP, settledB]); // old code: paused before its stale escrow write
  const fc = await safe(() => refundAll(pr.projectId));
  expect(!fc.error, 'forceCloseFunding REFUND succeeds', fc.error);
  release();
  pauseEscrowSync = null;
  expect((await settledB) === 'OK', 'investment B itself succeeded', await settledB);
  const r = await recon(pr.projectId);
  expect(r.project === 'CANCELLED' && r.nconf === 0 && r.nref === 2, 'project CANCELLED, both investments REFUNDED', show(r));
  expect(r.escrow && r.escrow.remaining === 0 && r.escrow.status === 'CLOSED', 'escrow stays 0 / CLOSED (no stale restore)', show(r.escrow));
  expect(reconciles(r), 'raised = confirmed = ledger net = escrow remaining (all 0)', show(r));
  expect(await wallet(a) === 1000 && await wallet(b) === 1000, 'both investors fully refunded', `${await wallet(a)} ${await wallet(b)}`);
}

async function testRefundThenInvest() {
  section('1b. REFUND first, then an investment -> refused, nothing written');
  const pr = await makeProject();
  const a = await makeUser('A', null, 1000);
  const c = await makeUser('C', null, 1000);
  await invest(a, pr.projectId, 300, 'a');
  await refundAll(pr.projectId);
  const before = await recon(pr.projectId);
  const r = await safe(() => invest(c, pr.projectId, 200, 'c'));
  expect(!!r.error, 'investment into a CANCELLED project refused', r.error || show(r.value));
  const after = await recon(pr.projectId);
  expect(show(after) === show(before) && await wallet(c) === 1000, 'no change to project, escrow, ledger or wallet', `${show(before)} -> ${show(after)}`);
}

async function testRace() {
  section('1c. True race: investment and REFUND at the same time (5 projects)');
  let allOk = true; const detail = [];
  for (let i = 0; i < 5; i++) {
    const pr = await makeProject();
    const a = await makeUser('A', null, 1000);
    const b = await makeUser('B', null, 1000);
    await invest(a, pr.projectId, 300, 'a');
    const [ib, fc] = await Promise.all([safe(() => invest(b, pr.projectId, 200, 'b')), safe(() => refundAll(pr.projectId))]);
    await new Promise((res) => setTimeout(res, 50)); // let any post-commit step finish
    const r = await recon(pr.projectId);
    const good = reconciles(r) && (!fc.error ? (r.project === 'CANCELLED' && r.escrow.remaining === 0 && await wallet(a) === 1000 && await wallet(b) === 1000) : true);
    detail.push(`${ib.error ? 'inv:ERR' : 'inv:OK'}/${fc.error ? 'fc:ERR' : 'fc:OK'}/${good ? 'consistent' : show(r)}`);
    if (!good) allOk = false;
  }
  expect(allOk, 'every race outcome reconciles; a refunded project keeps escrow 0 and wallets whole', detail.join(' | '));
}

async function testCallbackAfterClosure() {
  section('2. Funding callback after project closure -> escrow unchanged');
  const pr = await makeProject();
  const a = await makeUser('A', null, 1000);
  await invest(a, pr.projectId, 400, 'a');
  await refundAll(pr.projectId);
  const before = await recon(pr.projectId);
  await safe(() => pf.onFundingReceived({ projectId: pr.projectId, amount: 400, firstFunding: false }));
  const after = await recon(pr.projectId);
  expect(after.escrow && after.escrow.remaining === 0 && after.escrow.status === 'CLOSED' && after.escrow.gross === before.escrow.gross,
    'late callback: escrow stays 0 / CLOSED, escrow_balance unchanged', `${show(before.escrow)} -> ${show(after.escrow)}`);
  expect(reconciles(after), 'reconciles after late callback', show(after));
}

async function testSyncFailure() {
  section('3. Escrow or freeze failure -> the whole investment rolls back');
  for (const [label, re] of [
    ['escrow write', /(INSERT INTO|UPDATE)\s+controlled_project_accounts/i],
    ['waterfall freeze', /UPDATE\s+waterfall_allocation_rules/i],
  ]) {
    const pr = await makeProject({ rule: true });
    const a = await makeUser('A', null, 1000);
    const before = await recon(pr.projectId);
    inject = { re, label };
    const r = await safe(() => invest(a, pr.projectId, 400, 'a'));
    inject = null;
    await new Promise((res) => setTimeout(res, 50));
    const after = await recon(pr.projectId);
    expect(!!r.error, `${label} failure: investment reported as failed (not success)`, r.error || show(r.value));
    expect(after.raised === 0 && after.nconf === 0 && after.ledger === 0 && after.escrow === null && await wallet(a) === 1000,
      `${label} failure: nothing persisted (raised 0, no investment, no ledger, no escrow, wallet 1000)`, show(after));
    expect(after.rule === 'ACTIVE' && before.rule === 'ACTIVE', `${label} failure: rule unchanged (ACTIVE)`, show(after));
    const ok2 = await safe(() => invest(a, pr.projectId, 400, 'a2'));
    const fin = await recon(pr.projectId);
    expect(!ok2.error && fin.raised === 400 && fin.escrow && fin.escrow.remaining === 400 && fin.rule === 'FROZEN' && reconciles(fin),
      `${label}: a clean retry funds once, escrow 400, rule FROZEN`, ok2.error || show(fin));
  }
}

async function testDuplicates() {
  section('4. Duplicate callback and duplicate reference -> no double credit');
  const pr = await makeProject({ rule: true });
  const a = await makeUser('A', null, 1000);
  await invest(a, pr.projectId, 300, 'a');
  const r1 = await recon(pr.projectId);
  expect(r1.escrow && r1.escrow.remaining === 300 && r1.escrow.gross === 300 && r1.rule === 'FROZEN' && reconciles(r1),
    'first investment: escrow 300, rule FROZEN at first funding', show(r1));
  await pf.onFundingReceived({ projectId: pr.projectId, amount: 300, firstFunding: true });
  await pf.onFundingReceived({ projectId: pr.projectId, amount: 300, firstFunding: true });
  const r2 = await recon(pr.projectId);
  expect(show(r2) === show(r1), 'callback replayed twice: nothing changes', `${show(r1)} -> ${show(r2)}`);
  const dup = await safe(() => invest(a, pr.projectId, 300, 'a'));
  const r3 = await recon(pr.projectId);
  expect(r3.raised === 300 && r3.ledger === 300 && r3.escrow.remaining === 300 && await wallet(a) === 700,
    'same unique_reference again: no second debit or credit', `${dup.error || show(dup.value)} ${show(r3)}`);
}

async function testConcurrentInvestors() {
  section('5/7. Concurrent investors -> reconciliation holds');
  const pr = await makeProject();
  const users = [];
  for (let i = 0; i < 5; i++) users.push(await makeUser(`c${i}`, null, 1000));
  const res = await Promise.all(users.map((u, i) => safe(() => invest(u, pr.projectId, 100 * (i + 1), `c${i}`))));
  await new Promise((r) => setTimeout(r, 50));
  const okSum = res.reduce((s, x, i) => s + (x.error ? 0 : 100 * (i + 1)), 0);
  const r = await recon(pr.projectId);
  expect(res.some((x) => !x.error), `at least one concurrent investment succeeds (${res.filter((x) => !x.error).length}/5)`, show(res.map((x) => x.error || 'OK')));
  expect(r.raised === okSum && reconciles(r) && r.escrow.gross === okSum, `raised = confirmed = ledger = escrow = ${okSum}`, show(r));
  for (let i = 0; i < users.length; i++) {
    const w = await wallet(users[i]);
    if (res[i].error) expect(w === 1000, `refused investor c${i}: wallet unchanged`, w);
  }
}

async function testRefundInvestmentDelayedSync() {
  section('6b. Expiry refund of one investment, then a delayed sync -> escrow not restored');
  const pr = await makeProject();
  const a = await makeUser('A', null, 1000);
  const b = await makeUser('B', null, 1000);
  await invest(a, pr.projectId, 300, 'a');
  let release; let hit;
  const gate = new Promise((r) => { release = r; });
  const hitP = new Promise((r) => { hit = r; });
  pauseEscrowSync = { gate, hit };
  const settledB = invest(b, pr.projectId, 200, 'b').then(() => 'OK', (e) => e.message);
  await Promise.race([hitP, settledB]);
  await pool.query("UPDATE projects SET status = 'EXPIRED' WHERE id = $1", [pr.projectId]); // expiry job
  const invA = (await pool.query('SELECT id FROM project_investments WHERE unique_reference = $1', [ref(pr.projectId, 'a')])).rows[0].id;
  const rf = await safe(() => projectService.refundInvestment(pr.projectId, invA, a));
  expect(!rf.error, 'investor A refunds on the EXPIRED project', rf.error);
  release();
  pauseEscrowSync = null;
  expect((await settledB) === 'OK', 'investment B succeeded', await settledB);
  const r = await recon(pr.projectId);
  expect(r.raised === 200 && r.nconf === 1 && r.nref === 1, 'raised 200, 1 CONFIRMED (B), 1 REFUNDED (A)', show(r));
  expect(r.escrow && r.escrow.remaining === 200, 'escrow remaining 200 (A refund not undone by a stale sync)', show(r.escrow));
  expect(reconciles(r), 'raised = confirmed = ledger net = escrow remaining = 200', show(r));
}

async function testFailureInjection() {
  section('8. Failure injection at every financial write boundary of invest');
  const boundaries = [
    ['INSERT project_investments', /INSERT INTO project_investments/i],
    ['claim financial_operations', /INSERT INTO financial_operations/i],
    ['wallet debit', /UPDATE users SET wallet_balance/i],
    ['journal', /INSERT INTO journal_entries/i],
    ['balance audit', /INSERT INTO financial_audit_log/i],
    ['investment CONFIRMED', /UPDATE project_investments SET participation_pct/i],
    ['amount_raised', /UPDATE projects SET amount_raised/i],
    ['escrow write', /(INSERT INTO|UPDATE)\s+controlled_project_accounts/i],
    ['waterfall freeze', /UPDATE\s+waterfall_allocation_rules/i],
    ['transactions row', /INSERT INTO transactions/i],
    ['COMMIT', /^\s*COMMIT/i],
  ];
  for (const [label, re] of boundaries) {
    const pr = await makeProject({ rule: true });
    const a = await makeUser('A', null, 1000);
    // The freeze happens at first funding, so that boundary is tested without a seed.
    if (label !== 'waterfall freeze') await invest(a, pr.projectId, 100, 'seed');
    const before = await recon(pr.projectId);
    const w0 = await wallet(a);
    inject = { re, label };
    const r = await safe(() => invest(a, pr.projectId, 250, 'x'));
    const fired = inject === null;
    inject = null;
    await new Promise((res) => setTimeout(res, 30));
    const after = await recon(pr.projectId);
    const left = (await pool.query(
      `SELECT (SELECT COUNT(*) FROM project_investments WHERE unique_reference = $1)::int AS inv,
              (SELECT COUNT(*) FROM financial_operations WHERE reference_id = $1)::int AS ops,
              (SELECT COUNT(*) FROM journal_entries WHERE reference_id = $1)::int AS je,
              (SELECT COUNT(*) FROM transactions WHERE reference_id = $1)::int AS tx`, [ref(pr.projectId, 'x')])).rows[0];
    const clean = !!r.error && fired && show(after) === show(before) && await wallet(a) === w0
      && left.inv === 0 && left.ops === 0 && left.je === 0 && left.tx === 0;
    expect(clean, `${label}: investment failed and fully rolled back (escrow, ledger, wallet, rule, rows)`,
      `fired=${fired} err=${r.error || 'none'} ${show(before)} -> ${show(after)} left=${show(left)}`);
  }
}

async function testClosedEscrowGuard() {
  section('10. Inconsistent state: escrow CLOSED while the project is still FUNDING -> investment refused');
  const pr = await makeProject();
  const a = await makeUser('A', null, 1000);
  await invest(a, pr.projectId, 100, 'seed');
  await pool.query("UPDATE controlled_project_accounts SET status = 'CLOSED' WHERE project_id = $1", [pr.projectId]);
  const before = await recon(pr.projectId);
  const r = await safe(() => invest(a, pr.projectId, 200, 'x'));
  const after = await recon(pr.projectId);
  expect(!!r.error && r.err.statusCode === 409, 'investment into a CLOSED escrow refused (409)', r.error || show(r.value));
  expect(show(after) === show(before) && await wallet(a) === 900, 'nothing changed: escrow, raised, ledger, wallet', `${show(before)} -> ${show(after)}`);
}

async function testStatic() {
  section('9. Static: transaction boundary and lock order');
  const src = fs.readFileSync(PROJECT_FILE, 'utf8');
  const fn = src.slice(src.indexOf('async function invest('), src.indexOf('async function', src.indexOf('async function invest(') + 20));
  const iLock = fn.indexOf('FROM projects WHERE id = $1 FOR UPDATE');
  const iEscrow = fn.indexOf('recordFundingInTransaction(');
  const iCommit = fn.indexOf("'COMMIT'");
  expect(iLock > 0 && iEscrow > iLock && iCommit > iEscrow, 'invest: project lock -> escrow/freeze -> COMMIT', `${iLock}/${iEscrow}/${iCommit}`);
  const fsrc = fs.readFileSync(FINANCE_FILE, 'utf8');
  const cb = fsrc.slice(fsrc.indexOf('async function onFundingReceived'), fsrc.indexOf('async function', fsrc.indexOf('async function onFundingReceived') + 20));
  expect(!/controlled_project_accounts|setWaterfallFrozen|waterfall_allocation_rules/.test(cb), 'onFundingReceived: no escrow or rule writes', '');
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port`);
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);
    admin.id = await makeUser('admin', 'ADMIN');
    const silenced = console.error;
    console.error = () => {};
    try {
      for (const t of [testInvestThenRefundWithDelayedSync, testRefundThenInvest, testRace, testCallbackAfterClosure,
        testSyncFailure, testDuplicates, testConcurrentInvestors, testRefundInvestmentDelayedSync, testFailureInjection, testClosedEscrowGuard, testStatic]) {
        const res = await safe(t);
        if (res.error) bad(`${t.name} aborted`, res.error);
        inject = null; pauseEscrowSync = null;
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
