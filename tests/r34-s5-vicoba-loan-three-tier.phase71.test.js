#!/usr/bin/env node
'use strict';
/* R34 S5 — VICOBA loan three-tier approval chain (VICOBA v2.1 §3, §4.1–4.4; owner decisions
 * D-S5-0/3/4/5/8/15). Needs migration 149.
 *  P  positive: member submits own request; KATIBU -> MHASIBU (MWEKAHAZINA) -> MWENYEKITI; disbursement
 *     only after all three, once; ON_HOLD when the applicant is the only holder of a step role or a role
 *     holder is missing mid-flow; rejection with a reason stops the chain; applicant cancels ON_HOLD;
 *     interest from the group (never the body).
 *  N  negative: applicant at any step; skipped / repeated step; one person two steps; wrong role;
 *     other group; body applicant / interest; non-member; reason rules; ON_HOLD; amounts; group cannot
 *     staff three people (409, no row); legacy rows (old rules, D-S5-8). Every refusal is checked to leave
 *     row counts and md5 hashes of vicoba_loan_requests, vicoba_loan_approvals, vicoba_groups,
 *     vicoba_members, transactions, journal_entries, wallet_ledger, users.wallet_balance,
 *     vicoba_loan_schedules, outbox_events, financial_operations unchanged.
 *  C  concurrency: two holders of one step; two steps at once; double final approval; role change
 *     while a step is in flight; double cancel.
 *  S  static: chain rules run after the loan row lock; creation never sets chairman_approval.
 * Requires a DISPOSABLE database phase71_financial_audit_<suffix> on 127.0.0.1:55481.
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
const settledWithin = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n[P1-P5] full chain: member -> KATIBU -> MHASIBU -> MWENYEKITI -> disbursement');
  {
    const s = await group();
    const r = await submit(s, s.member, { repaymentMonths: 3 });
    const lid = r.body && r.body.loan && r.body.loan.id;
    const row = lid && await loanRow(lid);
    check('[P1] member submits own request -> 201 PENDING_KATIBU; applicant = initiator = member; chain v1; no chair approval; default interest 10; nothing paid',
      r.status === 201 && row.status === 'PENDING_KATIBU' && Number(row.applicant_user_id) === s.member.id && Number(row.initiated_by_user_id) === s.member.id
      && row.approval_chain_version === 1 && row.chairman_approval === false && row.chairman_approved_by === null && Number(row.interest_rate) === 10
      && (await approvals(lid)).length === 0 && (await txCount(lid)) === 0, { r, row });
    const r2 = await decide(lid, s.katibu, { step: 'KATIBU', decision: 'APPROVE' });
    const a1 = await approvals(lid);
    check('[P2] KATIBU approves -> PENDING_MHASIBU; approval row (1, KATIBU, actor, role at action)',
      r2.status === 200 && (await loanRow(lid)).status === 'PENDING_MHASIBU' && a1.length === 1 && a1[0].step_code === 'KATIBU' && Number(a1[0].actor_user_id) === s.katibu.id && a1[0].actor_role_at_action === 'KATIBU' && a1[0].decision === 'APPROVED', { r2, a1 });
    const r3 = await decide(lid, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: 25000 });
    const row3 = await loanRow(lid);
    check('[P3] MWEKAHAZINA (Mhasibu) verifies 25000 of 30000 -> PENDING_MWENYEKITI; approved_amount set; treasurer columns mirrored; still nothing paid',
      r3.status === 200 && row3.status === 'PENDING_MWENYEKITI' && cents(row3.approved_amount) === 2500000 && row3.treasurer_approval === true && Number(row3.treasurer_approved_by) === s.treasurer.id && (await txCount(lid)) === 0, { r3, row3 });
    const w0 = await walletC(s.member.id); const g0 = await groupC(s.g);
    const r4 = await approveFinal(lid, s.chair);
    const row4 = await loanRow(lid); const a4 = await approvals(lid);
    const sch = Number((await q1('SELECT count(*) n FROM vicoba_loan_schedules WHERE loan_id=$1', [lid])).n);
    check('[P4] MWENYEKITI approves -> 200 DISBURSED; one transaction; member +25000; group -25000; schedule created',
      r4.status === 200 && r4.body.success === true && row4.status === 'DISBURSED' && (await txCount(lid)) === 1 && (await walletC(s.member.id)) === w0 + 2500000 && (await groupC(s.g)) === g0 - 2500000 && sch >= 1, { r4, status: row4.status, sch });
    check('[P4] three approvals, three different actors, none the applicant, roles recorded; chair columns mirrored',
      a4.length === 3 && new Set(a4.map((a) => Number(a.actor_user_id))).size === 3 && !a4.some((a) => Number(a.actor_user_id) === s.member.id)
      && a4.map((a) => `${a.step_code}:${a.actor_role_at_action}`).join(',') === 'KATIBU:KATIBU,MHASIBU:MWEKAHAZINA,MWENYEKITI:MWENYEKITI'
      && row4.chairman_approval === true && Number(row4.chairman_approved_by) === s.chair.id, a4);
    const r5 = await approveFinal(lid, s.chair);
    check('[P5] retry by the same MWENYEKITI -> idempotent 200, still one transaction, paid once', r5.status === 200 && r5.body.success === true && (await txCount(lid)) === 1 && (await walletC(s.member.id)) === w0 + 2500000, r5);
    await refused('[P5] retry by KATIBU on a DISBURSED chain loan -> 409 ALREADY_DECIDED', () => approveFinal(lid, s.katibu), (x) => codeIs(x, 409, 'VICOBA_LOAN_ALREADY_DECIDED'));
    await refused('[P5] retry by the applicant -> 403 self', () => approveFinal(lid, s.member), selfRefused);
    const hist = await call('GET', `/api/v1/vicoba/loans/${lid}/approvals`, s.member2);
    check('[P11] group member reads the approval history (3 rows)', hist.status === 200 && hist.body.approvals.length === 3, hist.status);
    const outsider = await user('outsider');
    const h2 = await call('GET', `/api/v1/vicoba/loans/${lid}/approvals`, outsider);
    check('[P11] non-member -> 403', codeIs(h2, 403, 'VICOBA_NOT_GROUP_MEMBER'), h2);
  }

  console.log('\n[P1b/P1c] interest comes from the group, never the body (D-S5-3)');
  {
    const s = await group();
    await refused('[P1b] body interestRate -> 400 VICOBA_LOAN_INTEREST_FROM_GROUP, no row', () => submit(s, s.member, { interestRate: 1 }), (x) => codeIs(x, 400, 'VICOBA_LOAN_INTEREST_FROM_GROUP'));
    await pool.query('INSERT INTO vicoba_group_constitutions (group_id, loan_interest_rate) VALUES ($1, 12.5)', [s.g]);
    const r = await submit(s, s.member);
    check('[P1c] group constitution loan_interest_rate (12.5) is used', r.status === 201 && Number(r.body.loan.interest_rate) === 12.5, r.body);
  }

  console.log('\n[P6/P7/P9/P12] ON_HOLD (v2.1 §4.3/§4.4)');
  {
    const s = await group();
    const r = await submit(s, s.katibu);
    const row = r.body && r.body.loan;
    check('[P6] sole KATIBU applies -> 201 ON_HOLD (hold_step KATIBU, APPLICANT_IS_STEP_OFFICER); no approvals',
      r.status === 201 && row.status === 'ON_HOLD' && row.hold_step === 'KATIBU' && row.hold_reason === 'APPLICANT_IS_STEP_OFFICER' && row.held_at && (await approvals(row.id)).length === 0, r.body);
    await refused('[N11] ON_HOLD: KATIBU (the applicant) -> 403 self', () => decide(row.id, s.katibu, { step: 'KATIBU', decision: 'APPROVE' }), selfRefused);
    await refused('[N11] ON_HOLD: MWEKAHAZINA -> 409 ON_HOLD', () => decide(row.id, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE' }), (x) => codeIs(x, 409, 'VICOBA_LOAN_ON_HOLD'));
    await refused('[N11] ON_HOLD: MWENYEKITI /approve -> 409 ON_HOLD', () => approveFinal(row.id, s.chair), (x) => codeIs(x, 409, 'VICOBA_LOAN_ON_HOLD'));
    await refused('[N11] ON_HOLD: reject attempt -> 409 ON_HOLD', () => decide(row.id, s.chair, { step: 'MWENYEKITI', decision: 'REJECT', reason: 'no' + 'pe' }), (x) => codeIs(x, 409, 'VICOBA_LOAN_ON_HOLD'));

    console.log('  [P10] applicant cancels an ON_HOLD request (D-S5-5)');
    await refused('[P10] another member cannot cancel -> 403', () => call('POST', `/api/v1/vicoba/loans/${row.id}/cancel`, s.chair), (x) => codeIs(x, 403, 'VICOBA_LOAN_CANCEL_NOT_APPLICANT'));
    const c = await call('POST', `/api/v1/vicoba/loans/${row.id}/cancel`, s.katibu);
    const rc = await loanRow(row.id);
    check('[P10] applicant cancels -> 200 CANCELLED, cancelled_by applicant, hold info kept', c.status === 200 && rc.status === 'CANCELLED' && Number(rc.cancelled_by_user_id) === s.katibu.id && rc.cancelled_at && rc.hold_step === 'KATIBU', { c, rc: rc.status });
    await refused('[P10] cancel again -> 409 NOT_ON_HOLD', () => call('POST', `/api/v1/vicoba/loans/${row.id}/cancel`, s.katibu), (x) => codeIs(x, 409, 'VICOBA_LOAN_NOT_ON_HOLD'));
    const p = await submit(s, s.member);
    await refused('[P10] cancel of a PENDING_KATIBU request -> 409 NOT_ON_HOLD', () => call('POST', `/api/v1/vicoba/loans/${p.body.loan.id}/cancel`, s.member), (x) => codeIs(x, 409, 'VICOBA_LOAN_NOT_ON_HOLD'));
    await refused('[P10] cancelled request cannot be approved -> 409', () => decide(row.id, s.treasurer, { step: 'KATIBU', decision: 'APPROVE' }), (x) => x.status === 409);

    const r7 = await submit(s, s.chair);
    const l7 = r7.body.loan.id;
    await toMhasibu(s, l7);
    const t7 = await decide(l7, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE' });
    const row7 = await loanRow(l7);
    check('[P7] MWENYEKITI applies: KATIBU, MHASIBU approve, then ON_HOLD at MWENYEKITI (no other chair), in the same transaction',
      r7.status === 201 && t7.status === 200 && t7.body.status === 'ON_HOLD' && row7.status === 'ON_HOLD' && row7.hold_step === 'MWENYEKITI' && row7.hold_reason === 'APPLICANT_IS_STEP_OFFICER' && (await approvals(l7)).length === 2 && (await txCount(l7)) === 0, { t7: t7.body, row7: row7.status });
    await refused('[P7] the chair-applicant /approve -> 403 self', () => approveFinal(l7, s.chair), selfRefused);
  }
  {
    const s = await group();
    const r = await submit(s, s.member);
    await pool.query("UPDATE vicoba_members SET role_in_group='MJUMBE' WHERE group_id=$1 AND user_id=$2", [s.g, s.treasurer.id]);
    const k = await decide(r.body.loan.id, s.katibu, { step: 'KATIBU', decision: 'APPROVE' });
    const row = await loanRow(r.body.loan.id);
    check('[P9] MWEKAHAZINA removed mid-flow: KATIBU approves -> ON_HOLD (hold_step MHASIBU, APPROVER_MISSING); system appoints nobody',
      k.status === 200 && row.status === 'ON_HOLD' && row.hold_step === 'MHASIBU' && row.hold_reason === 'APPROVER_MISSING', { k: k.body, row: row.status });
  }
  {
    const s = await group([['chair', 'MWENYEKITI'], ['katibu', 'KATIBU'], ['katibu2', 'KATIBU'], ['treasurer', 'MWEKAHAZINA'], ['member', 'MJUMBE']]);
    const r = await submit(s, s.katibu);
    check('[P12] KATIBU applies while a second KATIBU exists -> PENDING_KATIBU (a real role holder, not a substitute)', r.status === 201 && r.body.loan.status === 'PENDING_KATIBU', r.body);
    const k2 = await decide(r.body.loan.id, s.katibu2, { step: 'KATIBU', decision: 'APPROVE' });
    check('[P12] the other KATIBU approves step 1', k2.status === 200 && (await loanRow(r.body.loan.id)).status === 'PENDING_MHASIBU', k2.body);
  }

  console.log('\n[P8] rejection with a reason stops the chain');
  {
    const s = await group();
    const l1 = (await submit(s, s.member)).body.loan.id;
    const rj = await decide(l1, s.katibu, { step: 'KATIBU', decision: 'REJECT', reason: 'Hisa hazitoshi' });
    const row = await loanRow(l1); const a = await approvals(l1);
    check('[P8] KATIBU rejects -> REJECTED, reason stored on the loan and the approval row, rejected_step KATIBU',
      rj.status === 200 && row.status === 'REJECTED' && row.rejection_reason === 'Hisa hazitoshi' && row.rejected_step === 'KATIBU' && a.length === 1 && a[0].decision === 'REJECTED' && a[0].reason === 'Hisa hazitoshi', { rj: rj.body, row: row.status });
    await refused('[P8] next step after rejection -> 409 ALREADY_DECIDED', () => decide(l1, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE' }), (x) => codeIs(x, 409, 'VICOBA_LOAN_ALREADY_DECIDED'));
    await refused('[P8] /approve after rejection -> 409', () => approveFinal(l1, s.chair), (x) => codeIs(x, 409, 'VICOBA_LOAN_ALREADY_DECIDED'));
    const l2 = (await submit(s, s.member)).body.loan.id; await toMhasibu(s, l2);
    const rj2 = await decide(l2, s.treasurer, { step: 'MHASIBU', decision: 'REJECT', reason: 'Salio dogo' });
    check('[P8] MHASIBU rejects at its step', rj2.status === 200 && (await loanRow(l2)).rejected_step === 'MHASIBU', rj2.body);
    const l3 = (await submit(s, s.member)).body.loan.id; await toMwenyekiti(s, l3);
    const rj3 = await decide(l3, s.chair, { step: 'MWENYEKITI', decision: 'REJECT', reason: 'Mkutano umekataa' });
    check('[P8] MWENYEKITI rejects at the final step; nothing paid', rj3.status === 200 && (await loanRow(l3)).status === 'REJECTED' && (await txCount(l3)) === 0, rj3.body);
  }

  console.log('\n[N] refusals (each with no DB mutation)');
  {
    const s = await group();
    const lid = (await submit(s, s.member)).body.loan.id;
    await refused('[N1] applicant at KATIBU step -> 403 self', () => decide(lid, s.member, { step: 'KATIBU', decision: 'APPROVE' }), selfRefused);
    await refused('[N1] applicant reject -> 403 self', () => decide(lid, s.member, { step: 'KATIBU', decision: 'REJECT', reason: 'xyz' }), selfRefused);
    await refused('[N12] body actorId/approverUserId/userId are ignored -> still 403 self', () => decide(lid, s.member, { step: 'KATIBU', decision: 'APPROVE', actorId: s.katibu.id, approverUserId: s.katibu.id, userId: s.katibu.id }), selfRefused);
    await refused('[N2] skip: MHASIBU on PENDING_KATIBU -> 409 OUT_OF_ORDER', () => decide(lid, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE' }), (x) => codeIs(x, 409, 'VICOBA_LOAN_STEP_OUT_OF_ORDER'));
    await refused('[N3] skip: MWENYEKITI /approve on PENDING_KATIBU -> 409 OUT_OF_ORDER', () => approveFinal(lid, s.chair), (x) => codeIs(x, 409, 'VICOBA_LOAN_STEP_OUT_OF_ORDER'));
    await refused('[N3] skip: MWENYEKITI via /decision APPROVE on PENDING_KATIBU -> 409', () => decide(lid, s.chair, { step: 'MWENYEKITI', decision: 'APPROVE' }), (x) => codeIs(x, 409, 'VICOBA_LOAN_STEP_OUT_OF_ORDER'));
    await refused('[N6] MJUMBE at KATIBU step -> 403 ROLE', () => decide(lid, s.member2, { step: 'KATIBU', decision: 'APPROVE' }), (x) => codeIs(x, 403, 'VICOBA_LOAN_STEP_ROLE_REQUIRED'));
    await refused('[N6] MWENYEKITI at KATIBU step -> 403 ROLE', () => decide(lid, s.chair, { step: 'KATIBU', decision: 'APPROVE' }), (x) => codeIs(x, 403, 'VICOBA_LOAN_STEP_ROLE_REQUIRED'));
    const o = await group();
    await refused('[N7] KATIBU of another group -> 403 NOT_GROUP_MEMBER', () => decide(lid, o.katibu, { step: 'KATIBU', decision: 'APPROVE' }), (x) => codeIs(x, 403, 'VICOBA_NOT_GROUP_MEMBER'));
    await refused('[N7] MWENYEKITI of another group /approve -> 403', () => approveFinal(lid, o.chair), (x) => x.status === 403);
    for (const bad of [undefined, '  ', 'ab', 'x'.repeat(501)]) {
      await refused(`[N10] reject reason ${JSON.stringify(bad && bad.length > 10 ? `${bad.length} chars` : bad)} -> 400`, () => decide(lid, s.katibu, { step: 'KATIBU', decision: 'REJECT', reason: bad }), (x) => codeIs(x, 400, 'VICOBA_LOAN_REJECT_REASON_REQUIRED'));
    }
    await refused('[N19] decision invalid -> 400', () => decide(lid, s.katibu, { step: 'KATIBU', decision: 'MAYBE' }), (x) => codeIs(x, 400, 'VICOBA_LOAN_DECISION_INVALID'));
    await refused('[N19] step invalid -> 400', () => decide(lid, s.katibu, { step: 'BOSS', decision: 'APPROVE' }), (x) => codeIs(x, 400, 'VICOBA_LOAN_STEP_INVALID'));
    await refused('[N20] unknown loan -> 404', () => decide(999999999, s.katibu, { step: 'KATIBU', decision: 'APPROVE' }), (x) => codeIs(x, 404, 'VICOBA_LOAN_NOT_FOUND'));

    await toMhasibu(s, lid);
    await refused('[N4] repeat: KATIBU again on PENDING_MHASIBU -> 409 OUT_OF_ORDER', () => decide(lid, s.katibu, { step: 'KATIBU', decision: 'APPROVE' }), (x) => codeIs(x, 409, 'VICOBA_LOAN_STEP_OUT_OF_ORDER'));
    await refused('[N1] applicant at MHASIBU step -> 403 self', () => decide(lid, s.member, { step: 'MHASIBU', decision: 'APPROVE' }), selfRefused);
    await refused('[N3] MWENYEKITI /approve on PENDING_MHASIBU -> 409 OUT_OF_ORDER', () => approveFinal(lid, s.chair), (x) => codeIs(x, 409, 'VICOBA_LOAN_STEP_OUT_OF_ORDER'));
    for (const bad of [0, -1, 'abc', 30001, 'Infinity']) {
      await refused(`[N13] MHASIBU amount ${JSON.stringify(bad)} -> 400`, () => decide(lid, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: bad }), (x) => codeIs(x, 400, 'VICOBA_LOAN_AMOUNT_INVALID'));
    }
    // one person, two steps: KATIBU acted on step 1, is then made MWEKAHAZINA
    await pool.query("UPDATE vicoba_members SET role_in_group='MWEKAHAZINA' WHERE group_id=$1 AND user_id=$2", [s.g, s.katibu.id]);
    await refused('[N5] KATIBU of step 1 (now MWEKAHAZINA) at MHASIBU step -> 403 ACTOR_ALREADY_ACTED', () => decide(lid, s.katibu, { step: 'MHASIBU', decision: 'APPROVE' }), (x) => codeIs(x, 403, 'VICOBA_LOAN_ACTOR_ALREADY_ACTED'));
    await pool.query("UPDATE vicoba_members SET role_in_group='KATIBU' WHERE group_id=$1 AND user_id=$2", [s.g, s.katibu.id]);
    await decide(lid, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: 20000 });
    await pool.query("UPDATE vicoba_members SET role_in_group='MWENYEKITI' WHERE group_id=$1 AND user_id=$2", [s.g, s.treasurer.id]);
    await refused('[N5] MHASIBU of step 2 (now MWENYEKITI) /approve -> 403 ACTOR_ALREADY_ACTED', () => approveFinal(lid, s.treasurer), (x) => codeIs(x, 403, 'VICOBA_LOAN_ACTOR_ALREADY_ACTED'));
    await pool.query("UPDATE vicoba_members SET role_in_group='MWEKAHAZINA' WHERE group_id=$1 AND user_id=$2", [s.g, s.treasurer.id]);
    await refused('[N1] applicant /approve at MWENYEKITI step -> 403 self', () => approveFinal(lid, s.member), selfRefused);
    await refused('[N14] MWENYEKITI amount != verified (20000) -> 409 MISMATCH', () => approveFinal(lid, s.chair, { approvedAmount: 30000 }), (x) => codeIs(x, 409, 'VICOBA_LOAN_AMOUNT_MISMATCH'));
    const ok = await approveFinal(lid, s.chair, { approvedAmount: 20000 });
    check('[N14] matching amount -> 200 DISBURSED', ok.status === 200 && (await loanRow(lid)).status === 'DISBURSED', ok.body);
  }
  {
    const s = await group();
    const outsider = await user('nonmember');
    await refused('[N8] officer submits for another member (applicantUserId) -> 403 APPLICANT_MUST_BE_SELF, no row', () => submit(s, s.chair, { applicantUserId: s.member.id }), (x) => codeIs(x, 403, 'VICOBA_LOAN_APPLICANT_MUST_BE_SELF'));
    const sv = await attempt(vicoba.requestLoan(s.chair.id, { groupId: s.g, applicantUserId: s.member.id, requestedAmount: 1000 }));
    check('[N8] service call with a different applicant (as trigger-loan does) -> 403', !sv.ok && sv.status === 403 && sv.code === 'VICOBA_LOAN_APPLICANT_MUST_BE_SELF', sv);
    const same = await submit(s, s.member, { applicantUserId: s.member.id });
    check('[N8] applicantUserId equal to the caller is accepted', same.status === 201, same.body);
    await refused('[N9] non-member submits -> 403 NOT_GROUP_MEMBER', () => submit(s, outsider), (x) => codeIs(x, 403, 'VICOBA_NOT_GROUP_MEMBER'));
    for (const bad of [0, -5, 'abc', null]) {
      await refused(`[N13] requestedAmount ${JSON.stringify(bad)} -> 400`, () => submit(s, s.member, { requestedAmount: bad }), (x) => codeIs(x, 400, 'VICOBA_LOAN_AMOUNT_INVALID'));
    }
    await refused('[N13] repaymentMonths 1.5 -> 400', () => submit(s, s.member, { repaymentMonths: 1.5 }), (x) => codeIs(x, 400, 'VICOBA_LOAN_MONTHS_INVALID'));
  }
  {
    const s4 = await group([['chair', 'MWENYEKITI'], ['treasurer', 'MWEKAHAZINA'], ['member', 'MJUMBE'], ['member2', 'MJUMBE']]);
    await refused('[N15] 4 members, no KATIBU -> 409 INSUFFICIENT_APPROVERS, no row', () => submit(s4, s4.member), (x) => codeIs(x, 409, 'VICOBA_GOVERNANCE_INSUFFICIENT_APPROVERS'));
    const s3 = await group([['chair', 'MWENYEKITI'], ['katibu', 'KATIBU'], ['treasurer', 'MWEKAHAZINA']]);
    await refused('[N15] 3 members (Small mode) -> 409, no row, no ON_HOLD', () => submit(s3, s3.katibu), (x) => codeIs(x, 409, 'VICOBA_GOVERNANCE_INSUFFICIENT_APPROVERS'));
  }
  {
    const s = await group([['chair', 'MWENYEKITI'], ['katibu', 'KATIBU'], ['treasurer', 'MWEKAHAZINA'], ['member', 'MJUMBE'], ['member2', 'MJUMBE']], 10000);
    const lid = (await submit(s, s.member, { requestedAmount: 30000 })).body.loan.id;
    await toMwenyekiti(s, lid);
    await refused('[N17] group balance too low at the final step -> 400; full rollback (PENDING_MWENYEKITI, 2 approvals, no transaction)', () => approveFinal(lid, s.chair),
      (x) => x.status === 400);
    const row = await loanRow(lid);
    check('[N17] state after rollback', row.status === 'PENDING_MWENYEKITI' && (await approvals(lid)).length === 2 && (await txCount(lid)) === 0, row.status);
  }

  console.log('\n[L] legacy rows keep the old rules (D-S5-8)');
  {
    const s = await group();
    const legacy = async (applicant) => (await q1(`INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, requested_amount, chairman_approval, chairman_approved_by, status) VALUES ($1,$2,30000,TRUE,$3,'PENDING') RETURNING id`, [s.g, applicant.id, s.chair.id])).id;
    const l1 = await legacy(s.member);
    await refused('[L1] /decision on a legacy row -> 409 LEGACY_CHAIN', () => decide(l1, s.katibu, { step: 'KATIBU', decision: 'APPROVE' }), (x) => codeIs(x, 409, 'VICOBA_LOAN_LEGACY_CHAIN'));
    await refused('[L2] legacy: MWENYEKITI cannot do the old second step -> 403 legacy role message', () => approveFinal(l1, s.chair), (x) => x.status === 403 && x.body.message === 'Mwekahazina au Katibu ndiye anayeidhinisha kiasi.');
    const w0 = await walletC(s.member.id);
    const ok = await approveFinal(l1, s.treasurer, { approvedAmount: 30000 });
    check('[L3] legacy: MWEKAHAZINA completes under the old rule -> 200 DISBURSED, paid once, no chain approvals written', ok.status === 200 && (await loanRow(l1)).status === 'DISBURSED' && (await txCount(l1)) === 1 && (await walletC(s.member.id)) === w0 + 3000000 && (await approvals(l1)).length === 0, ok.body);
    const l2 = await legacy(s.treasurer);
    await refused('[L4] legacy R30 (1): the applicant (MWEKAHAZINA) cannot approve own loan -> 403', () => approveFinal(l2, s.treasurer), (x) => x.status === 403 && x.body.message === MSG);
  }

  console.log('\n[C] concurrency');
  {
    const s = await group([['chair', 'MWENYEKITI'], ['katibu', 'KATIBU'], ['katibu2', 'KATIBU'], ['treasurer', 'MWEKAHAZINA'], ['member', 'MJUMBE']]);
    const lid = (await submit(s, s.member)).body.loan.id;
    const gp = await pausedAt('COMMIT');
    const first = attempt(vicoba.decideLoanStep(s.katibu.id, lid, { step: 'KATIBU', decision: 'APPROVE' }));
    const didPause = await gp.waitPaused();
    const second = attempt(vicoba.decideLoanStep(s.katibu2.id, lid, { step: 'KATIBU', decision: 'APPROVE' }));
    const early = await settledWithin(second, 400);
    gp.release();
    const [a, b] = [await first, await second];
    const ap = await approvals(lid);
    check('[C1] two KATIBUs at once: second waits on the loan lock, then 409; exactly one step-1 approval', didPause && early === false && a.ok && !b.ok && b.status === 409 && ap.length === 1 && Number(ap[0].actor_user_id) === s.katibu.id, { didPause, early, a, b, ap: ap.length });
  }
  {
    const s = await group();
    const lid = (await submit(s, s.member)).body.loan.id;
    const gp = await pausedAt('COMMIT');
    const k = attempt(vicoba.decideLoanStep(s.katibu.id, lid, { step: 'KATIBU', decision: 'APPROVE' }));
    const didPause = await gp.waitPaused();
    const t = attempt(vicoba.decideLoanStep(s.treasurer.id, lid, { step: 'MHASIBU', decision: 'APPROVE' }));
    const early = await settledWithin(t, 400);
    gp.release();
    const [rk, rt] = [await k, await t];
    const ap = await approvals(lid);
    check('[C2] KATIBU and MHASIBU at once: MHASIBU waits, then runs on the committed step 1; order kept (no step 2 before step 1)',
      didPause && early === false && rk.ok && rt.ok && (await loanRow(lid)).status === 'PENDING_MWENYEKITI' && ap.length === 2 && ap[0].step_code === 'KATIBU' && ap[1].step_code === 'MHASIBU' && new Date(ap[1].decided_at) >= new Date(ap[0].decided_at), { didPause, early, rk, rt });
  }
  {
    const s = await group();
    const lid = (await submit(s, s.member)).body.loan.id;
    await toMwenyekiti(s, lid);
    const w0 = await walletC(s.member.id); const g0 = await groupC(s.g);
    const gp = await pausedAt('COMMIT');
    const a = attempt(vicoba.approveLoan(s.chair.id, lid));
    const didPause = await gp.waitPaused();
    const b = attempt(vicoba.approveLoan(s.chair.id, lid));
    const early = await settledWithin(b, 400);
    gp.release();
    const [ra, rb] = [await a, await b];
    check('[C3] double final approval: second waits, then idempotent 200; one transaction; paid once',
      didPause && early === false && ra.ok && rb.ok && (await txCount(lid)) === 1 && (await walletC(s.member.id)) === w0 + 3000000 && (await groupC(s.g)) === g0 - 3000000 && (await approvals(lid)).length === 3, { didPause, early, ra, rb });
  }
  {
    const s = await group();
    const lid = (await submit(s, s.member)).body.loan.id;
    const gp = await pausedAt('COMMIT');
    const k = attempt(vicoba.decideLoanStep(s.katibu.id, lid, { step: 'KATIBU', decision: 'APPROVE' }));
    const didPause = await gp.waitPaused();
    const roleChange = pool.query("UPDATE vicoba_members SET role_in_group='MWEKAHAZINA' WHERE group_id=$1 AND user_id=$2", [s.g, s.katibu.id]);
    const early = await settledWithin(roleChange, 400);
    gp.release();
    await k; await roleChange;
    const ap = await approvals(lid);
    check('[C4] role change of the acting KATIBU waits until the step commits (role at action pinned: KATIBU)', didPause && early === false && ap.length === 1 && ap[0].actor_role_at_action === 'KATIBU', { didPause, early });
    const again = await attempt(vicoba.decideLoanStep(s.katibu.id, lid, { step: 'MHASIBU', decision: 'APPROVE' }));
    check('[C4] the same person (now MWEKAHAZINA) cannot take step 2 -> 403 ACTOR_ALREADY_ACTED', !again.ok && again.code === 'VICOBA_LOAN_ACTOR_ALREADY_ACTED', again);
  }
  {
    const s = await group();
    const lid = (await submit(s, s.katibu)).body.loan.id; // ON_HOLD
    const [a, b] = await Promise.all([attempt(vicoba.cancelLoanRequest(s.katibu.id, lid)), attempt(vicoba.cancelLoanRequest(s.katibu.id, lid))]);
    check('[C5] double cancel at once: one 200, one 409; status CANCELLED', [a, b].filter((x) => x.ok).length === 1 && [a, b].some((x) => !x.ok && x.status === 409) && (await loanRow(lid)).status === 'CANCELLED', { a, b });
  }

  console.log('\n[S] static');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/vicobaService.js'), 'utf8');
    const body = (name) => { const i = src.indexOf(`async function ${name}(`); const j = src.indexOf('\nasync function ', i + 10); return src.slice(i, j); };
    const d = body('decideLoanStep');
    const iLock = d.indexOf('FOR UPDATE'); const iAssert = d.indexOf('assertChainStep('); const iIns = d.indexOf('insertApproval(');
    check('[S1] decideLoanStep: chain rules after the loan row lock, before the first write', iLock > 0 && iAssert > iLock && iIns > iAssert, { iLock, iAssert, iIns });
    const a = body('approveLoan');
    const aLock = a.indexOf('FOR UPDATE'); const aAssert = a.indexOf("assertChainStep(client, loan, approverUserId, 'MWENYEKITI')"); const aTx = a.indexOf('INSERT INTO transactions');
    check('[S2] approveLoan: final-step chain rules after the lock, before the disbursement', aLock > 0 && aAssert > aLock && aTx > aAssert, { aLock, aAssert, aTx });
    const r = body('requestLoan');
    check('[S3] requestLoan never writes chairman_approval', !/chairman_approval/.test(r));
  }

  console.log(`\nR34 S5 three-tier chain: ${passed} passed, ${failed} failed`);
  server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await pool.end(); } catch (x) { /* */ } process.exit(1); });
