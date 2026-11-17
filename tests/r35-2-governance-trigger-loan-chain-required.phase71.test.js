#!/usr/bin/env node
'use strict';
/* R35 (2) — owner decision D-S5-7 (= R31-1 A1). POST /governance/resolutions/:id/trigger-loan ran
 * requestLoan + approveLoan as ONE actor, which the R34 three-tier chain can never satisfy. Before:
 * it INSERTed a PENDING governance_financial_executions row, then requestLoan refused (403/400 by
 * accident) and the row was left FAILED. Now: binding check first (unchanged), then 409
 * VICOBA_LOAN_CHAIN_REQUIRED before any INSERT; nothing is written.
 *  [1] HTTP, MWENYEKITI of the resolution's group, applicant = self -> 409 CHAIN_REQUIRED; no DB mutation
 *      (11 money/loan tables + governance_financial_executions, governance_resolutions, audit_logs).
 *  [2] HTTP, applicant = another member, with interest_rate -> 409 CHAIN_REQUIRED; no DB mutation.
 *  [3] service call with every argument -> 409; no execution row (count unchanged), no FAILED row.
 *  [4] binding still first: a resolution of another group -> GOV_RESOURCE_* refusal (not 409); no mutation.
 *  [5] no group context -> GOV_GROUP_REQUIRED; no mutation.
 *  [6] two triggers at once -> both 409; no execution rows.
 *  [7] static: triggerVicobaLoan has no INSERT, no governance_financial_executions write and no
 *      vicobaService call; the binding check precedes the refusal.
 * Requires a DISPOSABLE database phase71_financial_audit_<suffix> on 127.0.0.1:55481 with migration 149.
 */
const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55481') {
  console.error('REFUSING: disposable r26-ci-db (127.0.0.1:55481, phase71_financial_audit_*) only'); process.exit(2);
}
process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = { post: async () => { throw new Error('net off'); }, get: async () => { throw new Error('net off'); }, create() { return this; }, defaults: { headers: { common: {} } }, interceptors: { request: { use() {} }, response: { use() {} } } };
const express = require(path.join(ROOT, 'node_modules/express'));
const pgMod = require(path.join(ROOT, 'node_modules/pg'));
const gate = { armed: false, prefix: null, released: null, onPause: null };
{
  const origProtoQuery = pgMod.Client.prototype.query;
  pgMod.Client.prototype.query = function gated(sql, ...rest) {
    const text = typeof sql === 'string' ? sql : (sql && sql.text);
    if (gate.armed && typeof text === 'string' && text.trimStart().startsWith(gate.prefix)) {
      gate.armed = false; gate.onPause();
      return gate.released.then(() => origProtoQuery.call(this, sql, ...rest));
    }
    return origProtoQuery.call(this, sql, ...rest);
  };
}
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const vicoba = require(path.join(ROOT, 'src/services/vicobaService'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

const app = express();
app.use(express.json());
app.use('/api/v1/vicoba', require(path.join(ROOT, 'src/routes/vicobaRoutes')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));

const MSG = 'Huwezi kuidhinisha ombi lako mwenyewe.';
let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, code: e.code, msg: e.message }));
let seq = 0;
async function user(label) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R34 ${label}`, `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  const r = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]);
  await pool.query(`INSERT INTO user_service_subscriptions (user_id, service_key, status) VALUES ($1,'VICOBA','ACTIVE') ON CONFLICT DO NOTHING`, [r.id]);
  return { id: r.id, token: signToken(r) };
}
let base;
async function call(method, p, who, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}
// roles: array of [label, role]; returns { g, <label>: user }
async function group(roles = [['chair', 'MWENYEKITI'], ['katibu', 'KATIBU'], ['treasurer', 'MWEKAHAZINA'], ['member', 'MJUMBE'], ['member2', 'MJUMBE']], balance = 500000) {
  const s = {};
  for (const [label] of roles) s[label] = await user(label);
  const creator = s[roles[0][0]];
  s.g = (await q1(`INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ($1,$2,1000,'ACTIVE',$3) RETURNING id`, [`R34 g${++seq}`, creator.id, balance])).id;
  for (const [label, role] of roles) await pool.query('INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1,$2,$3)', [s.g, s[label].id, role]);
  return s;
}
const submit = (s, who, body = {}) => call('POST', `/api/v1/vicoba/groups/${s.g}/loans`, who, { requestedAmount: 30000, ...body });
const decide = (lid, who, body) => call('POST', `/api/v1/vicoba/loans/${lid}/decision`, who, body);
const approveFinal = (lid, who, body = {}) => call('POST', `/api/v1/vicoba/loans/${lid}/approve`, who, body);
const loanRow = async (id) => q1('SELECT * FROM vicoba_loan_requests WHERE id=$1', [id]);
const approvals = async (id) => (await pool.query('SELECT step_no, step_code, actor_user_id, actor_role_at_action, decision, reason, amount, decided_at FROM vicoba_loan_approvals WHERE loan_id=$1 ORDER BY step_no', [id])).rows;
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const groupC = async (g) => cents((await q1('SELECT group_wallet_balance FROM vicoba_groups WHERE id=$1', [g])).group_wallet_balance);
const txCount = async (lid) => Number((await q1('SELECT count(*) n FROM transactions WHERE reference_id=$1', [`VICOBA:LOAN:${lid}:DISBURSE`])).n);
const codeIs = (r, status, code) => r.status === status && r.body && r.body.code === code;
const selfRefused = (r) => r.status === 403 && r.body && r.body.message === MSG && r.body.code === 'VICOBA_LOAN_SELF_APPROVAL';

const SNAP_TABLES = [
  ['vicoba_loan_requests', 'SELECT * FROM vicoba_loan_requests'],
  ['vicoba_loan_approvals', 'SELECT * FROM vicoba_loan_approvals'],
  ['vicoba_groups', 'SELECT * FROM vicoba_groups'],
  ['vicoba_members', 'SELECT * FROM vicoba_members'],
  ['transactions', 'SELECT * FROM transactions'],
  ['journal_entries', 'SELECT * FROM journal_entries'],
  ['wallet_ledger', 'SELECT * FROM wallet_ledger'],
  ['users_wallet', 'SELECT id, wallet_balance FROM users'],
  ['vicoba_loan_schedules', 'SELECT * FROM vicoba_loan_schedules'],
  ['outbox_events', 'SELECT * FROM outbox_events'],
  ['financial_operations', 'SELECT * FROM financial_operations'],
];
async function snap() {
  const out = {};
  for (const [name, sql] of SNAP_TABLES) {
    const r = await q1(`SELECT count(*)::int n, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) h FROM (${sql}) t`);
    out[name] = `${r.n}:${r.h}`;
  }
  return out;
}
const sameSnap = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
const diffSnap = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);
// a refusal: expected predicate on the response AND nothing changed
async function refused(label, fn, pred) {
  const s0 = await snap();
  const r = await fn();
  const s1 = await snap();
  check(`${label} (no DB mutation)`, pred(r) && sameSnap(s0, s1), { status: r.status, body: r.body, changed: diffSnap(s0, s1) });
  return r;
}
async function toMhasibu(s, lid) { const r = await decide(lid, s.katibu, { step: 'KATIBU', decision: 'APPROVE' }); if (r.status !== 200) throw new Error(`setup KATIBU ${JSON.stringify(r.body)}`); }
async function toMwenyekiti(s, lid, amount) { await toMhasibu(s, lid); const r = await decide(lid, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: amount }); if (r.status !== 200) throw new Error(`setup MHASIBU ${JSON.stringify(r.body)}`); }
async function pausedAt(prefix) {
  let release; const released = new Promise((x) => { release = x; });
  let paused; const isPaused = new Promise((x) => { paused = x; });
  gate.prefix = prefix; gate.released = released; gate.onPause = paused; gate.armed = true;
  return { release, waitPaused: () => Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]) };
}
// the backend of another connection that is waiting on a row/tx lock, with its statement text
async function lockWaiter(like) {
  for (let i = 0; i < 40; i++) {
    const r = await q1("SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE $1 LIMIT 1", [like]);
    if (r) return r;
    await sleep(50);
  }
  return null;
}
const settledWithin = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

app.use('/api/governance', require(path.join(ROOT, 'src/routes/governanceRoutes')));
// error handler again, after the governance mount (the harness one sits before it)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));
const gfl = require(path.join(ROOT, 'src/services/governanceFinancialLinkageService'));
SNAP_TABLES.push(
  ['governance_financial_executions', 'SELECT * FROM governance_financial_executions'],
  ['governance_resolutions', 'SELECT * FROM governance_resolutions'],
  ['audit_logs', 'SELECT * FROM audit_logs'],
);
const execCount = async () => Number((await q1('SELECT count(*) n FROM governance_financial_executions')).n);
// migration 143: root_resolution_id NOT NULL, self-referencing (a first version is its own root)
const resolution = async (g) => {
  const rid = Number((await q1("SELECT nextval(pg_get_serial_sequence('governance_resolutions','id')) AS id")).id);
  await pool.query(`INSERT INTO governance_resolutions (id, root_resolution_id, group_type, group_id, title, body, financial_action_type, financial_amount) VALUES ($1,$1,'VICOBA',$2,'R35 loan','body','LOAN_APPROVAL',30000)`, [rid, g]);
  return rid;
};
const trigger = (rid, who, body) => call('POST', `/api/governance/resolutions/${rid}/trigger-loan`, who, body);
const chainRequired = (x) => codeIs(x, 409, 'VICOBA_LOAN_CHAIN_REQUIRED');

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await group();
  const rid = await resolution(s.g);
  const e0 = await execCount();

  console.log('\n[1]-[2] HTTP trigger-loan');
  await refused('[1] MWENYEKITI, applicant = self -> 409 VICOBA_LOAN_CHAIN_REQUIRED', () => trigger(rid, s.chair, { group_type: 'VICOBA', group_id: s.g, applicant_user_id: s.chair.id, amount: 30000 }), chainRequired);
  await refused('[2] MWEKAHAZINA, applicant = member, interest_rate sent -> 409 CHAIN_REQUIRED', () => trigger(rid, s.treasurer, { group_type: 'VICOBA', group_id: s.g, applicant_user_id: s.member.id, amount: 30000, interest_rate: 12, repayment_months: 3 }), chainRequired);

  console.log('\n[3] service call');
  {
    const s0 = await snap();
    const r = await attempt(gfl.triggerVicobaLoan({ actorUserId: s.chair.id, resolutionId: rid, groupId: s.g, applicantUserId: s.member.id, amount: 30000, interestRate: 10, repaymentMonths: 3, governance: { groupType: 'VICOBA', groupId: s.g } }));
    const s1 = await snap();
    const failedRows = Number((await q1("SELECT count(*) n FROM governance_financial_executions WHERE resolution_id=$1", [rid])).n);
    check('[3] service -> 409 CHAIN_REQUIRED; no execution row (none FAILED); no DB mutation', !r.ok && r.status === 409 && r.code === 'VICOBA_LOAN_CHAIN_REQUIRED' && failedRows === 0 && (await execCount()) === e0 && sameSnap(s0, s1), { r, failedRows, changed: diffSnap(s0, s1) });
  }

  console.log('\n[4]-[5] binding stays first');
  {
    const o = await group();
    const foreign = await resolution(o.g);
    await refused('[4] HTTP: resolution of another group -> GOV_RESOURCE refusal, not 409', () => trigger(foreign, s.chair, { group_type: 'VICOBA', group_id: s.g, applicant_user_id: s.member.id, amount: 30000 }), (x) => x.status !== 409 && x.status >= 400 && x.status < 500 && /^GOV_RESOURCE/.test(x.body && x.body.code));
    const s0 = await snap();
    const r = await attempt(gfl.triggerVicobaLoan({ actorUserId: s.chair.id, resolutionId: foreign, applicantUserId: s.member.id, amount: 30000, governance: { groupType: 'VICOBA', groupId: s.g } }));
    check('[4] service: foreign resolution -> binding refusal (GOV_RESOURCE_*), not 409; no DB mutation', !r.ok && r.status !== 409 && /^GOV_RESOURCE/.test(r.code || '') && sameSnap(s0, await snap()), r);
    const s2 = await snap();
    const r2 = await attempt(gfl.triggerVicobaLoan({ actorUserId: s.chair.id, resolutionId: rid, applicantUserId: s.member.id, amount: 30000 }));
    check('[5] service without group context -> GOV_GROUP_REQUIRED; no DB mutation', !r2.ok && r2.code === 'GOV_GROUP_REQUIRED' && sameSnap(s2, await snap()), r2);
  }

  console.log('\n[6] two triggers at once');
  {
    const s0 = await snap();
    const body = { group_type: 'VICOBA', group_id: s.g, applicant_user_id: s.member.id, amount: 30000 };
    const [a, b] = await Promise.all([trigger(rid, s.chair, body), trigger(rid, s.chair, body)]);
    check('[6] both 409 CHAIN_REQUIRED; no execution rows; no DB mutation', chainRequired(a) && chainRequired(b) && (await execCount()) === e0 && sameSnap(s0, await snap()), { a: a.status, b: b.status });
  }

  console.log('\n[7] static');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/governanceFinancialLinkageService.js'), 'utf8');
    const start = src.indexOf('async function triggerVicobaLoan(');
    const b = src.slice(start, src.indexOf('\n}\n', start));
    const iBind = b.indexOf("binding.assertResourceInContext('RESOLUTION'"); const iRef = b.indexOf("'VICOBA_LOAN_CHAIN_REQUIRED'");
    check('[7] binding check, then the 409; no INSERT / executions write / vicoba call in triggerVicobaLoan',
      start > 0 && iBind > 0 && iRef > iBind && !/INSERT|UPDATE|governance_financial_executions|vicobaService|requestLoan|approveLoan/.test(b), { iBind, iRef });
  }

  console.log(`\nR35 (2) trigger-loan: ${passed} passed, ${failed} failed`);
  server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await pool.end(); } catch (x) { /* */ } process.exit(1); });
