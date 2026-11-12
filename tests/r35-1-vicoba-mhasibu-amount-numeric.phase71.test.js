#!/usr/bin/env node
'use strict';
/* R35 (1) — R34 reviewer F1: the MHASIBU step compared amounts with JS float rounding
 * (Math.round(x * 100)) while the column stores NUMERIC rounded half up, so approvedAmount
 * 10000.005 on a 10000.00 request passed and was stored and paid as 10000.01. Owner decision:
 * round with NUMERIC(18,2) before storing and never exceed the requested amount.
 *  [1] 10000.005 (number and string) on a 10000.00 request -> 400 AMOUNT_INVALID, no DB mutation.
 *  [2] 0.004 (rounds to 0.00) -> 400; 1e20 -> 400 (not 500); no DB mutation.
 *  [3] 9999.995 rounds to 10000.00 (= requested) -> 200; loan approved_amount and step-2 approval
 *      amount are exactly 10000.00.
 *  [4] the final step pays exactly the stored 10000.00 (1000000 cents), once.
 *  [5] 10000.004 rounds to 10000.00 -> 200; 2500.125 on a 10000 request is stored as 2500.13.
 *  [6] static: the MHASIBU check rounds in SQL with numeric(18,2) before insertApproval.
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

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const atMhasibu = async (s, requestedAmount = 10000) => {
    const r = await submit(s, s.member, { requestedAmount });
    if (r.status !== 201) throw new Error(`setup submit ${JSON.stringify(r.body)}`);
    await toMhasibu(s, r.body.loan.id);
    return r.body.loan.id;
  };
  const mh = (lid, s, approvedAmount) => decide(lid, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount });
  const invalid = (x) => codeIs(x, 400, 'VICOBA_LOAN_AMOUNT_INVALID');

  console.log('\n[1] sub-cent amount that rounds above the request');
  {
    const s = await group();
    const lid = await atMhasibu(s);
    await refused('[1] approvedAmount 10000.005 (number) on 10000.00 -> 400', () => mh(lid, s, 10000.005), invalid);
    await refused('[1] approvedAmount "10000.005" (string) on 10000.00 -> 400', () => mh(lid, s, '10000.005'), invalid);
    await refused('[1] approvedAmount 10000.01 on 10000.00 -> 400', () => mh(lid, s, 10000.01), invalid);
    const row = await loanRow(lid);
    check('[1] loan still PENDING_MHASIBU, approved_amount untouched, one approval', row.status === 'PENDING_MHASIBU' && (await approvals(lid)).length === 1, row.status);
  }

  console.log('\n[2] amounts that round to zero or overflow');
  {
    const s = await group();
    const lid = await atMhasibu(s);
    await refused('[2] approvedAmount 0.004 (rounds to 0.00) -> 400', () => mh(lid, s, 0.004), invalid);
    await refused('[2] approvedAmount 1e20 -> 400, not 500', () => mh(lid, s, 1e20), invalid);
    await refused('[2] approvedAmount "1e-7" -> 400', () => mh(lid, s, '1e-7'), invalid);
  }

  console.log('\n[3]-[4] rounds down to the request: accepted and paid exactly');
  {
    const s = await group();
    const lid = await atMhasibu(s);
    const r = await mh(lid, s, 9999.995);
    const row = await loanRow(lid); const a = await approvals(lid);
    check('[3] 9999.995 -> 200 PENDING_MWENYEKITI; approved_amount 10000.00; step-2 approval amount 10000.00',
      r.status === 200 && row.status === 'PENDING_MWENYEKITI' && String(row.approved_amount) === '10000.00' && a.length === 2 && String(a[1].amount) === '10000.00', { r: r.body, aa: row.approved_amount, a2: a[1] && a[1].amount });
    const w0 = await walletC(s.member.id); const g0 = await groupC(s.g);
    const f = await approveFinal(lid, s.chair);
    check('[4] final step pays exactly 10000.00 once (member +1000000 cents, group -1000000)',
      f.status === 200 && (await loanRow(lid)).status === 'DISBURSED' && (await txCount(lid)) === 1 && (await walletC(s.member.id)) === w0 + 1000000 && (await groupC(s.g)) === g0 - 1000000, { f: f.body });
  }

  console.log('\n[5] other roundings');
  {
    const s = await group();
    const l1 = await atMhasibu(s);
    const r1 = await mh(l1, s, 10000.004);
    check('[5] 10000.004 -> 200, stored 10000.00', r1.status === 200 && String((await loanRow(l1)).approved_amount) === '10000.00', r1.body);
    const l2 = await atMhasibu(s);
    const r2 = await mh(l2, s, 2500.125);
    const a2 = await approvals(l2);
    check('[5] 2500.125 -> 200, stored 2500.13 on the loan and the approval (NUMERIC half up)', r2.status === 200 && String((await loanRow(l2)).approved_amount) === '2500.13' && String(a2[1].amount) === '2500.13', { r2: r2.body, a: a2[1] && a2[1].amount });
    const l3 = await atMhasibu(s);
    const r3 = await mh(l3, s, undefined);
    check('[5] no approvedAmount -> the requested 10000.00', r3.status === 200 && String((await loanRow(l3)).approved_amount) === '10000.00', r3.body);
  }

  console.log('\n[7] values where JS float rounding and NUMERIC rounding disagree (R35 (1) review F-1)');
  {
    const s = await group();
    const l1 = await atMhasibu(s, 5242.89);
    const r1 = await mh(l1, s, 5242.8949999999995);
    const row1 = await loanRow(l1); const a1 = await approvals(l1);
    check('[7] 5242.8949999999995 on 5242.89 -> 200, stored 5242.89 on the loan and the approval (JS Math.round would give 5242.90)',
      r1.status === 200 && String(row1.approved_amount) === '5242.89' && String(a1[1].amount) === '5242.89', { r1: r1.body, aa: row1.approved_amount, a: a1[1] && a1[1].amount });
    const w0 = await walletC(s.member.id);
    const f = await approveFinal(l1, s.chair);
    check('[7] paid exactly 5242.89 (524289 cents), never a cent above the request', f.status === 200 && (await walletC(s.member.id)) === w0 + 524289 && (await txCount(l1)) === 1, { f: f.body });
    const l2 = await atMhasibu(s, 2);
    const r2 = await mh(l2, s, 1.005);
    check('[7] 1.005 on 2.00 -> stored 1.01 (NUMERIC half up; JS Math.round gives 1.00)', r2.status === 200 && String((await loanRow(l2)).approved_amount) === '1.01', { r2: r2.body });
  }

  console.log('\n[6] static');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/vicobaService.js'), 'utf8');
    const start = src.indexOf('async function decideLoanStep(');
    const b = src.slice(start, src.indexOf('\nasync function ', start + 10));
    const iRound = b.indexOf('::numeric(18,2)'); const iIns = b.indexOf("insertApproval(client, loan, ctx.step, actor, ctx.role, 'APPROVED'");
    check('[6] MHASIBU amount rounded with numeric(18,2) in SQL before insertApproval', iRound > 0 && iIns > iRound, { iRound, iIns });
  }

  console.log(`\nR35 (1) MHASIBU amount: ${passed} passed, ${failed} failed`);
  server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await pool.end(); } catch (x) { /* */ } process.exit(1); });
