#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / remediation of review residuals under the owner's
 * "CONDITIONAL REVIEW & REMEDIATION AUTHORIZATION":
 *
 *   F1   invest's PROJECT_INVEST audit row is written in the invest transaction
 *        (it was always lost after a 3 s lock wait). An audit failure rolls the
 *        investment back.
 *   #25  forceCloseFunding REFUND sends the "Uwekezaji umerudishwa"
 *        notifications only after COMMIT (none for a rolled-back refund, none
 *        lost to lock_timeout while the refund holds the investors' rows).
 *   F4   getInvestorStatement shows the rule revenue is allocated with
 *        (getAllocationRule; OBS-7c FROZEN terms), never an unapproved version.
 *
 * Every rejected operation must leave wallets, escrow, investments, journal,
 * operations, transactions and audit rows unchanged.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- failure / delay injection ---------------------------------------------
// inject: { re, nth, label } -> the nth matching query throws (then cleared)
// delay:  { re, ms }         -> every matching query waits ms first
let inject = null;
let delay = null;
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function patched(...args) {
  const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  if (inject && inject.re.test(sql)) {
    inject.seen = (inject.seen || 0) + 1;
    if (inject.seen === (inject.nth || 1)) {
      const err = new Error(`TEST: injected failure at ${inject.label}`);
      inject = null;
      if (cb) { setImmediate(() => cb(err)); return undefined; }
      return Promise.reject(err);
    }
  }
  if (delay && delay.re.test(sql)) {
    const ms = delay.ms;
    if (cb) { setTimeout(() => origQuery.apply(this, args), ms); return undefined; }
    return sleep(ms).then(() => origQuery.apply(this, args));
  }
  return origQuery.apply(this, args);
};

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label, role, wallet = 0) {
  seq += 1;
  const phone = `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71R2 ${label} ${tag} ${seq}`, phone])).rows[0].id;
  if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  if (wallet) await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [wallet, id]);
  return id;
}
const allProjects = new Set();
async function makeProject({ capital = 10000, status = 'FUNDING' } = {}) {
  const owner = await makeUser('owner');
  const id = (await pool.query(
    `INSERT INTO projects (owner_user_id, name, status, capital_required, amount_raised)
     VALUES ($1, $2, $3, $4, 0) RETURNING id`,
    [owner, `P71R2 project ${tag} ${++seq}`, status, capital])).rows[0].id;
  allProjects.add(id);
  return { projectId: id, owner };
}
const ref = (pid, s) => `P71R2-${tag}-${pid}-${s}`;
const invest = (u, pid, amount, s) => projectService.invest(u, pid, { amount, unique_reference: ref(pid, s) });
async function wallet(u) { return Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [u])).rows[0].wallet_balance); }
async function auditRows(reference) {
  return (await pool.query(
    `SELECT user_id, action, entity_type, entity_id FROM audit_logs WHERE action = 'PROJECT_INVEST' AND meta->>'referenceId' = $1`,
    [reference])).rows;
}
async function refundNotes(u) {
  return (await pool.query(
    `SELECT body FROM notifications WHERE user_id = $1 AND title = 'Uwekezaji umerudishwa'`, [u])).rows;
}

async function snap(pid, users = []) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const p = await one('SELECT status, amount_raised FROM projects WHERE id = $1', [pid]);
  const e = await one('SELECT escrow_balance, remaining_balance, disbursed_total, status FROM controlled_project_accounts WHERE project_id = $1', [pid]);
  const inv = (await pool.query('SELECT id, status, refund_reference FROM project_investments WHERE project_id = $1 ORDER BY id', [pid])).rows
    .map((r) => `${r.id}:${r.status}:${r.refund_reference || '-'}`);
  const counts = await one(`SELECT (SELECT COUNT(*) FROM journal_entries)::int AS je,
    (SELECT COUNT(*) FROM financial_operations)::int AS ops,
    (SELECT COUNT(*) FROM transactions)::int AS tx,
    (SELECT COUNT(*) FROM financial_audit_log)::int AS fal,
    (SELECT COUNT(*) FROM audit_logs WHERE action = 'PROJECT_INVEST')::int AS audit`);
  const w = [];
  for (const u of users) w.push(await wallet(u));
  return {
    project: p.status, raised: Number(p.amount_raised),
    escrow: e ? { gross: Number(e.escrow_balance), remaining: Number(e.remaining_balance), status: e.status } : null,
    inv, counts, wallets: w,
  };
}

// paid_in - refunded = escrow remaining = PROJECT_INVESTMENT_ACCOUNT net over the project's references
async function recon(pid) {
  const one = async (sql) => (await pool.query(sql, [pid])).rows[0];
  const inv = await one(`SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('CONFIRMED','REFUNDED')),0)::numeric AS paid_in,
                                COALESCE(SUM(amount) FILTER (WHERE status = 'REFUNDED'),0)::numeric AS refunded,
                                COALESCE(SUM(amount) FILTER (WHERE status = 'CONFIRMED'),0)::numeric AS confirmed
                           FROM project_investments WHERE project_id = $1`);
  const p = await one('SELECT status, amount_raised FROM projects WHERE id = $1');
  const e = await one('SELECT remaining_balance FROM controlled_project_accounts WHERE project_id = $1');
  const led = await one(
    `SELECT COALESCE(SUM(CASE WHEN je.direction = 'CR' THEN je.amount ELSE -je.amount END),0)::numeric AS net
       FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id
      WHERE la.account_code = 'PROJECT_INVESTMENT_ACCOUNT'
        AND je.reference_id IN (
          SELECT unique_reference FROM project_investments WHERE project_id = $1
          UNION SELECT refund_reference FROM project_investments WHERE project_id = $1 AND refund_reference IS NOT NULL)`);
  return {
    project: p.status, raised: Number(p.amount_raised),
    paid_in: Number(inv.paid_in), refunded: Number(inv.refunded), confirmed: Number(inv.confirmed),
    escrow: e ? Number(e.remaining_balance) : 0, ledger: Number(led.net),
  };
}
const reconciles = (rc) => rc.paid_in - rc.refunded === rc.escrow && rc.escrow === rc.ledger;

// ---------------------------------------------------------------------------
async function testF1() {
  section('F1a. invest writes exactly one PROJECT_INVEST audit row, without a 3 s lock wait');
  const pr = await makeProject();
  const u = await makeUser('inv', null, 1000);
  const t0 = Date.now();
  const r = await safe(() => invest(u, pr.projectId, 400, 'a'));
  const ms = Date.now() - t0;
  expect(!r.error, 'F1a: invest succeeds', r.error);
  expect(ms < 2000, 'F1a: invest finished well under lock_timeout (no audit lock wait)', `${ms} ms`);
  const rows = await auditRows(ref(pr.projectId, 'a'));
  expect(rows.length === 1 && Number(rows[0].user_id) === u && Number(rows[0].entity_id) === pr.projectId && rows[0].entity_type === 'PROJECT',
    'F1a: one audit row (user, PROJECT, project id)', show(rows));
  console.log(`  [evidence] F1a invest duration ${ms} ms`);

  section('F1b. audit insert fails -> investment rolled back, nothing changed');
  const before = await snap(pr.projectId, [u]);
  inject = { re: /INSERT INTO audit_logs/i, label: 'audit_logs insert' };
  const rb = await safe(() => invest(u, pr.projectId, 300, 'b'));
  inject = null;
  const after = await snap(pr.projectId, [u]);
  expect(!!rb.error, 'F1b: invest refused when its audit row cannot be written', rb.error);
  expect(show(before) === show(after), 'F1b: wallet, project, escrow, investments, journal, ops, transactions, audit unchanged',
    `${show(before)} vs ${show(after)}`);
  const inv = (await pool.query('SELECT COUNT(*)::int c FROM project_investments WHERE unique_reference = $1', [ref(pr.projectId, 'b')])).rows[0].c;
  expect(inv === 0, 'F1b: no investment row for the refused invest', inv);

  section('F1c. 6 parallel invests on one project: all committed, one audit row each, escrow = ledger');
  const pc = await makeProject({ capital: 100000 });
  const us = [];
  for (let i = 0; i < 6; i++) us.push(await makeUser(`par${i}`, null, 1000));
  const tp = Date.now();
  const res = await Promise.all(us.map((x, i) => safe(() => invest(x, pc.projectId, 100 + i, `p${i}`))));
  const pms = Date.now() - tp;
  expect(res.every((x) => !x.error), 'F1c: all 6 invests succeed', show(res.filter((x) => x.error).map((x) => x.error)));
  let audits = 0;
  for (let i = 0; i < 6; i++) audits += (await auditRows(ref(pc.projectId, `p${i}`))).length;
  expect(audits === 6, 'F1c: 6 audit rows (none lost under contention)', audits);
  const rc = await recon(pc.projectId);
  expect(reconciles(rc) && rc.raised === 615 && rc.confirmed === 615, 'F1c: raised = CONFIRMED = escrow = ledger = 615', show(rc));
  for (let i = 0; i < 6; i++) {
    const w = await wallet(us[i]);
    if (w !== 1000 - (100 + i)) bad(`F1c: wallet of investor ${i}`, w);
  }
  ok('F1c: each wallet debited exactly once');
  console.log(`  [evidence] F1c 6 parallel invests in ${pms} ms`);
}

async function testN25() {
  section('#25a. forceCloseFunding REFUND: one notification per investor, after COMMIT, with the committed reference');
  const admin = await makeUser('admin', 'ADMIN');
  const pa = await makeProject();
  const x = await makeUser('x', null, 1000);
  const y = await makeUser('y', null, 1000);
  await invest(x, pa.projectId, 600, 'x');
  await invest(y, pa.projectId, 900, 'y');
  const r = await safe(() => pf.forceCloseFunding(admin, 'ADMIN', pa.projectId, { action: 'REFUND' }));
  expect(!r.error && r.value.refunded_count === 2, 'a: refund succeeds for 2 investors', r.error || show(r.value));
  for (const [u, amt] of [[x, 600], [y, 900]]) {
    const notes = await refundNotes(u);
    const rr = (await pool.query("SELECT refund_reference FROM project_investments WHERE project_id = $1 AND investor_user_id = $2 AND status = 'REFUNDED'", [pa.projectId, u])).rows;
    expect(notes.length === 1 && rr.length === 1 && notes[0].body.includes(rr[0].refund_reference),
      `a: investor (${amt}) has exactly 1 notification naming the committed refund reference`, show({ notes, rr }));
    expect(await wallet(u) === 1000, `a: investor (${amt}) wallet back to 1000`, await wallet(u));
  }

  section('#25b. failure at the 2nd investor credit: full rollback, NO notification sent');
  const pb = await makeProject();
  const bx = await makeUser('bx', null, 1000);
  const by = await makeUser('by', null, 1000);
  await invest(bx, pb.projectId, 500, 'x');
  await invest(by, pb.projectId, 700, 'y');
  const before = await snap(pb.projectId, [bx, by]);
  inject = { re: /^\s*INSERT INTO financial_operations/i, nth: 2, label: '2nd creditWallet claim' };
  const rb = await safe(() => pf.forceCloseFunding(admin, 'ADMIN', pb.projectId, { action: 'REFUND' }));
  inject = null;
  await sleep(300);
  const after = await snap(pb.projectId, [bx, by]);
  expect(!!rb.error, 'b: refund fails', rb.error);
  expect(show(before) === show(after), 'b: wallets, project, escrow, investments, journal, ops, transactions unchanged',
    `${show(before)} vs ${show(after)}`);
  const sent = (await refundNotes(bx)).length + (await refundNotes(by)).length;
  expect(sent === 0, 'b: 0 "refunded" notifications for a rolled-back refund (was 1 before the fix)', sent);

  section('#25c. refund held 4.5 s before COMMIT (> lock_timeout): notifications are NOT lost');
  const pc = await makeProject();
  const cx = await makeUser('cx', null, 1000);
  const cy = await makeUser('cy', null, 1000);
  await invest(cx, pc.projectId, 300, 'x');
  await invest(cy, pc.projectId, 200, 'y');
  delay = { re: /UPDATE projects SET status = 'CANCELLED', amount_raised = 0/i, ms: 4500 };
  const errs = [];
  const logger = require('../src/utils/logger');
  const origErr = logger.error;
  logger.error = (...a) => { errs.push(String(a[0]) + ' ' + String(a[1] || '')); };
  let rc;
  try {
    rc = await safe(() => pf.forceCloseFunding(admin, 'ADMIN', pc.projectId, { action: 'REFUND' }));
  } finally { delay = null; logger.error = origErr; }
  expect(!rc.error, 'c: held refund commits', rc.error);
  const nc = (await refundNotes(cx)).length + (await refundNotes(cy)).length;
  expect(nc === 2, 'c: both investors notified (before the fix the in-loop insert timed out after 3 s)', nc);
  expect(!errs.some((m) => /NOTIFICATION/.test(m)), 'c: no NOTIFICATION lock-timeout error logged', show(errs));

  section('#25d. two parallel force-close REFUNDs: one refunds, one refused; exactly one notification each');
  const pd = await makeProject();
  const dx = await makeUser('dx', null, 1000);
  const dy = await makeUser('dy', null, 1000);
  await invest(dx, pd.projectId, 250, 'x');
  await invest(dy, pd.projectId, 350, 'y');
  const admin2 = await makeUser('admin2', 'ADMIN');
  const [r1, r2] = await Promise.all([
    safe(() => pf.forceCloseFunding(admin, 'ADMIN', pd.projectId, { action: 'REFUND' })),
    safe(() => pf.forceCloseFunding(admin2, 'ADMIN', pd.projectId, { action: 'REFUND' })),
  ]);
  const okN = [r1, r2].filter((x) => !x.error).length;
  expect(okN === 1, 'd: exactly one refund succeeds', show([r1.error || 'ok', r2.error || 'ok']));
  const nx = (await refundNotes(dx)).length;
  const ny = (await refundNotes(dy)).length;
  expect(nx === 1 && ny === 1, 'd: exactly one notification per investor', `${nx}/${ny}`);
  expect(await wallet(dx) === 1000 && await wallet(dy) === 1000, 'd: each investor refunded exactly once', `${await wallet(dx)}/${await wallet(dy)}`);
}

const RULE = (inv, own) => ({ investor_dividend_percentage: inv, owner_residual_percentage: own });
const cfg = (st) => show({ DIVIDEND: st.waterfall_config.DIVIDEND, OWNER_RESIDUAL: st.waterfall_config.OWNER_RESIDUAL });

async function testF4() {
  section('F4. investor statement shows the allocation rule, never an unapproved version');
  const approver = await makeUser('approver', 'ADMIN');

  // a: DRAFT only -> nothing shown
  const pa = await makeProject();
  await pf.createInitialRules(pa.owner, pa.projectId, RULE(70, 30));
  const sa = await pf.getInvestorStatement({ userId: pa.owner, role: 'USER' }, pa.projectId);
  expect(Object.keys(sa.waterfall_config).length === 0, 'F4a: DRAFT rule (not approved) is not shown', show(sa.waterfall_config));

  // b: approved v1 (ACTIVE) -> shown
  const pb = await makeProject();
  const v1 = await pf.createInitialRules(pb.owner, pb.projectId, RULE(60, 40));
  await pf.approveWaterfallRule(approver, v1.id, {});
  const sb = await pf.getInvestorStatement({ userId: pb.owner, role: 'USER' }, pb.projectId);
  expect(cfg(sb) === show({ DIVIDEND: 60, OWNER_RESIDUAL: 40 }), 'F4b: ACTIVE v1 shown (60/40)', cfg(sb));

  // c: funded (v1 FROZEN), amendment 55/45 approved (ACTIVE v2) -> FROZEN 60/40 shown = rule used by revenue
  const inv = await makeUser('inv', null, 5000);
  await invest(inv, pb.projectId, 1000, 'f4');
  const st1 = (await pool.query('SELECT status FROM waterfall_allocation_rules WHERE id = $1', [v1.id])).rows[0].status;
  expect(st1 === 'FROZEN', 'F4c: v1 FROZEN at first funding', st1);
  const p2 = await pf.proposeWaterfallRules(pb.owner, pb.projectId, { ...RULE(55, 45), change_reason: 'P71R2 amend' });
  await pf.approveWaterfallRule(approver, p2.id, {});
  const sc = await pf.getInvestorStatement({ userId: inv, role: 'USER' }, pb.projectId);
  expect(cfg(sc) === show({ DIVIDEND: 60, OWNER_RESIDUAL: 40 }), 'F4c: investor sees the FROZEN terms (60/40), not the amendment (55/45)', cfg(sc));
  // The rule actually used for allocation (disposable DB only): revenue records carry rule_id.
  const rref = ref(pb.projectId, 'rev');
  const rv = await safe(() => pf.processIncomingRevenue(pb.owner, pb.projectId, { amount: 100, revenue_type: 'SALES', unique_reference: rref }, null));
  const used = (await pool.query('SELECT DISTINCT rule_id FROM waterfall_allocation_records WHERE project_id = $1 AND revenue_reference = $2', [pb.projectId, rref])).rows;
  expect(!rv.error && used.length === 1 && Number(used[0].rule_id) === Number(v1.id),
    'F4c: the statement rule is the rule revenue was allocated with (rule_id = v1)', rv.error || show(used));

  // d: pending (unapproved) proposal above a FROZEN rule -> not shown as terms
  const pd = await makeProject();
  const d1 = await pf.createInitialRules(pd.owner, pd.projectId, RULE(60, 40));
  await pf.approveWaterfallRule(approver, d1.id, {});
  const dinv = await makeUser('dinv', null, 5000);
  await invest(dinv, pd.projectId, 1000, 'f4d');
  await pf.proposeWaterfallRules(pd.owner, pd.projectId, { ...RULE(50, 50), change_reason: 'P71R2 pending' });
  const sd = await pf.getInvestorStatement({ userId: dinv, role: 'USER' }, pd.projectId);
  expect(sd.waterfall_config.DIVIDEND !== 50, 'F4d: unapproved 50/50 proposal is not shown as the investor terms', show(sd.waterfall_config));
  console.log(`  [evidence] F4d pending proposal above FROZEN: statement waterfall_config=${show(sd.waterfall_config)} (getAllocationRule returns the PROPOSED row; revenue is refused while it is pending: see F3)`);
}

async function testReconciliationAll() {
  section('R. Reconciliation of every project in this run');
  const bad2 = [];
  for (const pid of allProjects) {
    const rc = await recon(pid);
    if (!reconciles(rc) || (rc.project !== 'CANCELLED' && rc.raised !== rc.confirmed)) bad2.push({ pid, ...rc });
  }
  expect(bad2.length === 0, `R: ${allProjects.size} projects: paid_in - refunded = escrow = ledger; raised = CONFIRMED`, show(bad2));
  const unbalanced = (await pool.query(
    `SELECT reference_id FROM journal_entries GROUP BY reference_id
      HAVING SUM(CASE WHEN direction = 'DR' THEN amount ELSE 0 END) <> SUM(CASE WHEN direction = 'CR' THEN amount ELSE 0 END)`)).rows;
  expect(unbalanced.length === 0, 'R: every journal reference balances DR = CR', show(unbalanced.slice(0, 5)));
  const neg = (await pool.query('SELECT COUNT(*)::int c FROM controlled_project_accounts WHERE remaining_balance < 0')).rows[0].c;
  expect(neg === 0, 'R: no negative escrow', neg);
}

async function testStatic() {
  section('S. Static');
  const ps = fs.readFileSync(PROJECT_FILE, 'utf8');
  const fsrc = fs.readFileSync(FINANCE_FILE, 'utf8');
  const fnOf = (src, name) => { const i = src.indexOf(`async function ${name}(`); return src.slice(i, src.indexOf('\nasync function', i + 10)); };
  const inv = fnOf(ps, 'invest');
  const iA = inv.indexOf("eventType: 'PROJECT_INVEST'");
  const auditLine = inv.slice(iA, inv.indexOf('\n', iA));
  expect(iA > 0 && /\bclient\b/.test(auditLine) && iA < inv.indexOf("query('COMMIT')"), 'invest: PROJECT_INVEST audit passes client, before COMMIT', auditLine);
  const fc = fnOf(fsrc, 'forceCloseFunding');
  const iRefund = fc.indexOf('// REFUND action');
  const refundPart = fc.slice(iRefund);
  const iCommit = refundPart.indexOf("query('COMMIT')");
  const iNote = refundPart.indexOf("title: 'Uwekezaji umerudishwa'");
  expect(iCommit > 0 && iNote > iCommit && refundPart.indexOf('client.release()') < iNote,
    'forceCloseFunding REFUND: notification only after COMMIT and release', `${iCommit}/${iNote}`);
  const st = fnOf(fsrc, 'getInvestorStatement');
  expect(st.includes('getAllocationRule(projectId)') && !/ORDER BY version DESC LIMIT 1/.test(st),
    'getInvestorStatement: uses getAllocationRule, not the highest version', '');
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
      for (const t of [testF1, testN25, testF4, testReconciliationAll, testStatic]) {
        const res = await safe(t);
        if (res.error) bad(`${t.name} aborted`, res.err && res.err.stack || res.error);
        inject = null;
        delay = null;
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
