#!/usr/bin/env node
'use strict';
/* R35 (3) — owner decision D-S5-12. tests/r30-d4-vicoba-loan-request-maker-checker.phase71.test.js is
 * SUPERSEDED: its premise (an officer creates the request for a member and the creation is the chair
 * step) was replaced by R34 S5 D(a) (the member submits their own request). The R30 (1) rule it
 * protected — the applicant never approves their own loan, whatever the body says — is carried here
 * onto the three-tier chain, item by item (R30 D4 number in brackets):
 *  [1]/[2] MWENYEKITI, MWEKAHAZINA, KATIBU submit for themselves: no step is approved at creation
 *          (chairman_approval FALSE, chairman_approved_by NULL, no approval rows), and each gets 403 with
 *          the R30 message at their own step; nothing paid.
 *  [3] body chairmanUserId/actorId/userId at creation are ignored: initiator = applicant = caller.
 *  [4] ids as strings: HTTP applicantUserId "<self>" is the same person; service decideLoanStep /
 *      approveLoan with the applicant id as a string -> 403 with the message.
 *  [6] governance-style sequence by one actor (requestLoan, then approveLoan as the same person) ->
 *      approveLoan refuses 403 with the message; no transaction, not DISBURSED.
 *  [7] static: the applicant check precedes the step-order and role checks in assertChainStep, and
 *      the approveLoan self-check precedes the disbursement.
 *  [8] two self-approval attempts at once -> both 403; no approval row.
 *  [9] officer applicant whose role has a second holder (loan actionable, not ON_HOLD): own KATIBU,
 *      MHASIBU and MWENYEKITI steps -> 403 with the message; control: the second holder acts (200).
 * R30 D4 [5] (officer creates for a member, chair step at creation) is retired by D(a) and not carried.
 * Every refusal is checked with no DB mutation (11 tables). Needs migration 149.
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

const r30self = (x) => x.status === 403 && x.body && x.body.message === MSG;
const svcSelf = (a) => !a.ok && a.status === 403 && a.msg === MSG;

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n[1]/[2] officers submit for themselves');
  {
    const s = await group();
    const created = {};
    for (const who of ['chair', 'treasurer', 'katibu']) {
      const r = await submit(s, s[who]);
      const row = r.body && r.body.loan && await loanRow(r.body.loan.id);
      created[who] = row && row.id;
      check(`[1/2] ${who} submits own request -> 201; no step approved at creation (chairman_approval FALSE, by NULL, 0 approvals)`,
        r.status === 201 && row.chairman_approval === false && row.chairman_approved_by === null && Number(row.applicant_user_id) === s[who].id && (await approvals(row.id)).length === 0, { r: r.body, row: row && row.status });
    }
    await refused('[1/2] KATIBU-applicant at the KATIBU step -> 403 R30 message', () => decide(created.katibu, s.katibu, { step: 'KATIBU', decision: 'APPROVE' }), r30self);
    await toMhasibu(s, created.treasurer);
    await refused('[1/2] MWEKAHAZINA-applicant at the MHASIBU step -> 403 R30 message', () => decide(created.treasurer, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE' }), r30self);
    await toMwenyekiti(s, created.chair);
    await refused('[1/2] MWENYEKITI-applicant /approve -> 403 R30 message', () => approveFinal(created.chair, s.chair), r30self);
    check('[1/2] nothing paid for any self-submitted request', (await txCount(created.chair)) + (await txCount(created.treasurer)) + (await txCount(created.katibu)) === 0);
  }

  console.log('\n[3] body cannot change the creator');
  {
    const s = await group();
    const r = await submit(s, s.chair, { chairmanUserId: s.treasurer.id, actorId: s.treasurer.id, userId: s.treasurer.id, initiatedByUserId: s.treasurer.id });
    const row = await loanRow(r.body.loan.id);
    check('[3] initiator = applicant = caller; chairman_approved_by NULL', r.status === 201 && Number(row.initiated_by_user_id) === s.chair.id && Number(row.applicant_user_id) === s.chair.id && row.chairman_approved_by === null, row);
    await refused('[3] body actorId/approverUserId = KATIBU on /decision by the applicant -> still 403', () => decide(row.id, s.chair, { step: 'KATIBU', decision: 'APPROVE', actorId: s.katibu.id, approverUserId: s.katibu.id, userId: s.katibu.id }), r30self);
  }

  console.log('\n[4] ids as strings');
  {
    const s = await group();
    const r = await submit(s, s.member, { applicantUserId: String(s.member.id) });
    check('[4] HTTP applicantUserId as the caller id string -> 201, applicant = caller', r.status === 201 && Number(r.body.loan.applicant_user_id) === s.member.id, r.body);
    const lid = r.body.loan.id;
    const s0 = await snap();
    const a = await attempt(vicoba.decideLoanStep(String(s.member.id), lid, { step: 'KATIBU', decision: 'APPROVE' }));
    check('[4] service decideLoanStep with the applicant id as a string -> 403 R30 message; no DB mutation', svcSelf(a) && sameSnap(s0, await snap()), a);
    await toMwenyekiti(s, lid);
    const s1 = await snap();
    const b = await attempt(vicoba.approveLoan(String(s.member.id), lid));
    check('[4] service approveLoan with the applicant id as a string -> 403 R30 message; no DB mutation', svcSelf(b) && sameSnap(s1, await snap()), b);
  }

  console.log('\n[6] governance-style sequence, one actor');
  {
    const s = await group();
    const req = await vicoba.requestLoan(s.treasurer.id, { groupId: s.g, applicantUserId: s.treasurer.id, requestedAmount: 30000 });
    const s0 = await snap();
    const a = await attempt(vicoba.approveLoan(s.treasurer.id, req.id, 30000));
    const row = await loanRow(req.id);
    check('[6] requestLoan then approveLoan by the same person -> 403 R30 message; no transaction; not DISBURSED; no DB mutation',
      svcSelf(a) && row.status !== 'DISBURSED' && (await txCount(req.id)) === 0 && sameSnap(s0, await snap()), { a, st: row.status });
  }

  console.log('\n[7] static ordering');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/vicobaService.js'), 'utf8');
    const body = (name) => { const st = src.indexOf(`async function ${name}(`); return src.slice(st, src.indexOf('\nasync function ', st + 10)); };
    const c = body('assertChainStep');
    const iSelf = c.indexOf('SELF_APPROVAL'); const iOrder = c.indexOf('STEP_OUT_OF_ORDER'); const iRole = c.indexOf('STEP_ROLE_REQUIRED');
    check('[7] assertChainStep: applicant check before step-order and role checks', iSelf > 0 && iOrder > iSelf && iRole > iSelf, { iSelf, iOrder, iRole });
    const a = body('approveLoan');
    const aSelf = a.indexOf(MSG); const aTx = a.indexOf('INSERT INTO transactions');
    check('[7] approveLoan: self-check (R30 message) before the disbursement', aSelf > 0 && aTx > aSelf, { aSelf, aTx });
  }

  console.log('\n[8] two self-approval attempts at once');
  {
    const s = await group();
    const lid = (await submit(s, s.member)).body.loan.id;
    const s0 = await snap();
    const [a, b] = await Promise.all([decide(lid, s.member, { step: 'KATIBU', decision: 'APPROVE' }), decide(lid, s.member, { step: 'KATIBU', decision: 'APPROVE' })]);
    check('[8] both 403 R30 message; no approval row; no DB mutation', r30self(a) && r30self(b) && (await approvals(lid)).length === 0 && sameSnap(s0, await snap()), { a: a.status, b: b.status });
  }

  console.log('\n[9] officer applicant whose role has a second holder (loan actionable, not ON_HOLD)');
  {
    const s = await group([['chair', 'MWENYEKITI'], ['chair2', 'MWENYEKITI'], ['katibu', 'KATIBU'], ['katibu2', 'KATIBU'],
      ['treasurer', 'MWEKAHAZINA'], ['treasurer2', 'MWEKAHAZINA'], ['member', 'MJUMBE']]);
    const lk = (await submit(s, s.katibu)).body.loan;
    check('[9] KATIBU applies while a second KATIBU exists -> PENDING_KATIBU (actionable)', lk && lk.status === 'PENDING_KATIBU', lk);
    await refused('[9] KATIBU-applicant approves own KATIBU step -> 403 R30 message', () => decide(lk.id, s.katibu, { step: 'KATIBU', decision: 'APPROVE' }), r30self);
    await refused('[9] KATIBU-applicant rejects own KATIBU step -> 403 R30 message', () => decide(lk.id, s.katibu, { step: 'KATIBU', decision: 'REJECT', reason: 'mwenyewe' }), r30self);
    const lt = (await submit(s, s.treasurer)).body.loan;
    await toMhasibu(s, lt.id);
    check('[9] MWEKAHAZINA-applicant loan reaches PENDING_MHASIBU (second MWEKAHAZINA exists)', (await loanRow(lt.id)).status === 'PENDING_MHASIBU');
    await refused('[9] MWEKAHAZINA-applicant approves own MHASIBU step -> 403 R30 message', () => decide(lt.id, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: 30000 }), r30self);
    const lc = (await submit(s, s.chair)).body.loan;
    await toMwenyekiti(s, lc.id);
    check('[9] MWENYEKITI-applicant loan reaches PENDING_MWENYEKITI (second MWENYEKITI exists)', (await loanRow(lc.id)).status === 'PENDING_MWENYEKITI');
    await refused('[9] MWENYEKITI-applicant /approve own loan -> 403 R30 message', () => approveFinal(lc.id, s.chair), r30self);
    await refused('[9] MWENYEKITI-applicant /decision MWENYEKITI APPROVE own loan -> 403 R30 message', () => decide(lc.id, s.chair, { step: 'MWENYEKITI', decision: 'APPROVE' }), r30self);
    const k2 = await decide(lk.id, s.katibu2, { step: 'KATIBU', decision: 'APPROVE' });
    const t2 = await decide(lt.id, s.treasurer2, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: 30000 });
    const c2 = await approveFinal(lc.id, s.chair2);
    check('[9] control: the second holder of each role can act (200), so the refusals above were the self rule, not the state',
      k2.status === 200 && t2.status === 200 && c2.status === 200 && (await loanRow(lc.id)).status === 'DISBURSED', { k2: k2.status, t2: t2.status, c2: c2.status });
  }

  console.log(`\nR35 (3) R30 (1) on the chain: ${passed} passed, ${failed} failed`);
  server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await pool.end(); } catch (x) { /* */ } process.exit(1); });
