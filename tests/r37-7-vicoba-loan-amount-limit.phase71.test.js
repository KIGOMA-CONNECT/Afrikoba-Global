#!/usr/bin/env node
'use strict';
/* R37 (7) / F-R36-3: VICOBA loan amounts are rejected with 400 BEFORE storage at the real column limit.
 * Schema (db/migrations/002, 149): vicoba_loan_requests.requested_amount / approved_amount and
 * vicoba_loan_approvals.amount are NUMERIC(15,2): largest storable value 9999999999999.99.
 *  [1] submit (POST /groups/:g/loans): requestedAmount that rounds above 9999999999999.99
 *      (9999999999999.996 - the nearest double rounds to 10000000000000.00 -, 1e13, 1e14, 1e15, 1e20) -> 400 VICOBA_LOAN_AMOUNT_INVALID, never a 500 overflow;
 *      no DB mutation.
 *  [2] boundary controls: 9999999999999.99 and 9999999999999.994 are accepted and stored as 9999999999999.99.
 *  [3] MHASIBU on a loan requested at the limit: 9999999999999.996, 1e13, 1e15, 9.99e15, 1e20 -> 400, no DB
 *      mutation; the limit itself -> 200 and stored exactly on the loan and on the step-2 approval.
 * The high-value KYC threshold is raised for this process so the amount rule is what is exercised.
 * Requires a DISPOSABLE database phase71_financial_audit_<suffix> on 127.0.0.1:55481 with migration 149.
 */
const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55481') {
  console.error('REFUSING: disposable r26-ci-db (127.0.0.1:55481, phase71_financial_audit_*) only'); process.exit(2);
}
process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
process.env.HIGH_VALUE_LOAN_THRESHOLD = '1e300'; // R37 (7): keep the KYC gate out of the amount boundary checks
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


(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const MAX = '9999999999999.99';
  const invalid = (x) => codeIs(x, 400, 'VICOBA_LOAN_AMOUNT_INVALID');
  const mh = (lid, s, approvedAmount) => decide(lid, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount });

  console.log('\n[1] submit: above the column limit -> 400, never 500');
  {
    const s = await group();
    for (const v of [9999999999999.996, 1e13, 1e14, 1e15, 1e20]) { // numbers only: strictAmount refuses strings
      await refused(`[1] requestedAmount ${JSON.stringify(v)} -> 400 VICOBA_LOAN_AMOUNT_INVALID`, () => submit(s, s.member, { requestedAmount: v }), invalid);
    }
  }

  console.log('\n[2] submit: boundary controls');
  let s2; let lidMax;
  {
    s2 = await group();
    const r = await submit(s2, s2.member, { requestedAmount: 9999999999999.99 });
    check('[2] requestedAmount 9999999999999.99 -> 201', r.status === 201, { status: r.status, body: r.body });
    lidMax = r.body && r.body.loan && r.body.loan.id;
    if (lidMax) check('[2] stored requested_amount = 9999999999999.99', (await loanRow(lidMax)).requested_amount === MAX);
    const s = await group();
    const r2 = await submit(s, s.member, { requestedAmount: 9999999999999.994 });
    check('[2] requestedAmount 9999999999999.994 -> 201, stored 9999999999999.99', r2.status === 201 && (await loanRow(r2.body.loan.id)).requested_amount === MAX, { status: r2.status });
  }

  console.log('\n[3] MHASIBU on a loan requested at the limit');
  if (lidMax) {
    await toMhasibu(s2, lidMax);
    for (const v of [9999999999999.996, 1e13, 1e15, 9.99e15, 1e20]) {
      await refused(`[3] approvedAmount ${JSON.stringify(v)} -> 400`, () => mh(lidMax, s2, v), invalid);
    }
    const ok = await mh(lidMax, s2, 9999999999999.99);
    check('[3] approvedAmount at the limit -> 200', ok.status === 200, { status: ok.status, body: ok.body });
    const row = await loanRow(lidMax); const a = await approvals(lidMax);
    check('[3] approved_amount and the step-2 approval amount stored exactly 9999999999999.99', row.approved_amount === MAX && a.some((x) => x.step_code === 'MHASIBU' && x.amount === MAX), { approved: row.approved_amount });
  } else check('[3] setup: loan at the limit exists', false);

  server.close();
  await pool.end();
  console.log(`\nR37 (7) VICOBA loan amount column limit: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e && e.message); try { await pool.end(); } catch (x) { /* */ } process.exit(1); });
