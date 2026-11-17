#!/usr/bin/env node
'use strict';
/* R30 F-D5-5 (owner decision 1) — VICOBA loan self-approval. vicobaService.approveLoan refuses
 * (403, 'Huwezi kuidhinisha ombi lako mwenyewe.') when the approver (req.user) is the loan's
 * applicant_user_id. The check runs inside the transaction, under the loan row lock, before any
 * UPDATE. Before: a MWEKAHAZINA or KATIBU who was the applicant approved and disbursed their own
 * loan into their own wallet (only the chair step was a second person).
 * Owner decision 2: the approval chain (chair, then treasurer/secretary) is unchanged.
 *  [1] MWEKAHAZINA applicant approves own loan via POST /loans/:id/approve -> 403 + message;
 *      loan PENDING, no treasurer approval, no transaction, group and wallet balances unchanged.
 *  [2] KATIBU applicant -> same.
 *  [3] body cannot change the actor (approverUserId/actorId/userId in the body ignored).
 *  [4] service call approveLoan(applicant, ...) -> statusCode 403, same message.
 *  [5] chain unchanged: another treasurer/secretary approves the treasurer's loan (200, DISBURSED,
 *      applicant paid once); member loan approved by treasurer; chair -> 403 role; plain member ->
 *      403 role; non-member -> 403; no chairman approval -> 400.
 *  [6] static: the self check sits after BEGIN and the loan row lock, before the first UPDATE.
 *  [7] concurrency: a legitimate KATIBU approval paused before COMMIT while the treasurer-applicant
 *      tries to self-approve -> self waits on the lock, then 403; money moves exactly once.
 *  [8] two parallel self-approvals -> both 403, nothing moves.
 *  [9] legacy: a DISBURSED loan whose applicant retries as approver -> 403 (no idempotent 200),
 *      nothing moves.
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
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R30 ${label}`, `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  const r = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]);
  return { id: r.id, token: signToken(r) };
}
let base;
async function call(method, p, token, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}
async function group() {
  const chair = await user('chair'); const treasurer = await user('treasurer'); const secretary = await user('secretary'); const member = await user('member');
  const g = await q1(`INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ($1,$2,1000,'ACTIVE',500000) RETURNING id`, [`R30 g${++seq}`, chair.id]);
  for (const [u, role] of [[chair, 'MWENYEKITI'], [treasurer, 'MWEKAHAZINA'], [secretary, 'KATIBU'], [member, 'MJUMBE']]) {
    await pool.query('INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1,$2,$3)', [g.id, u.id, role]);
    await pool.query(`INSERT INTO user_service_subscriptions (user_id, service_key, status) VALUES ($1,'VICOBA','ACTIVE') ON CONFLICT DO NOTHING`, [u.id]);
  }
  return { g: g.id, chair, treasurer, secretary, member };
}
const loan = async (s, applicant, { amount = 30000, chairOk = true, status = 'PENDING' } = {}) => (await q1(
  `INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, requested_amount, chairman_approval, chairman_approved_by, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
  [s.g, applicant.id, amount, chairOk, chairOk ? s.chair.id : null, status])).id;
const loanRow = async (id) => q1('SELECT status, treasurer_approval, treasurer_approved_by, approved_amount FROM vicoba_loan_requests WHERE id=$1', [id]);
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const groupC = async (g) => cents((await q1('SELECT group_wallet_balance FROM vicoba_groups WHERE id=$1', [g])).group_wallet_balance);
const txCount = async (lid) => Number((await q1('SELECT count(*) n FROM transactions WHERE reference_id=$1', [`VICOBA:LOAN:${lid}:DISBURSE`])).n);
const selfRefused = (r) => r.status === 403 && r.body && r.body.message === MSG;
async function untouched(s, lid, applicant, w0, g0) {
  const row = await loanRow(lid);
  return { ok: row.status === 'PENDING' && row.treasurer_approval === false && row.treasurer_approved_by === null && (await txCount(lid)) === 0 && (await walletC(applicant.id)) === w0 && (await groupC(s.g)) === g0, row };
}
async function pausedAt(prefix) {
  let release; const released = new Promise((x) => { release = x; });
  let paused; const isPaused = new Promise((x) => { paused = x; });
  gate.prefix = prefix; gate.released = released; gate.onPause = paused; gate.armed = true;
  return { release, waitPaused: () => Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]) };
}

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n[1] MWEKAHAZINA approves own loan (direct route)');
  {
    const s = await group(); const lid = await loan(s, s.treasurer); const w0 = await walletC(s.treasurer.id); const g0 = await groupC(s.g);
    const r = await call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.treasurer.token, {});
    check('[1] -> 403 with the owner message', selfRefused(r), r);
    const u = await untouched(s, lid, s.treasurer, w0, g0);
    check('[1] loan PENDING, no treasurer approval, no transaction, balances unchanged', u.ok, u.row);
  }

  console.log('\n[2] KATIBU approves own loan (direct route)');
  {
    const s = await group(); const lid = await loan(s, s.secretary); const w0 = await walletC(s.secretary.id); const g0 = await groupC(s.g);
    const r = await call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.secretary.token, { approvedAmount: 20000 });
    const u = await untouched(s, lid, s.secretary, w0, g0);
    check('[2] -> 403 with the owner message; nothing changed', selfRefused(r) && u.ok, { r, row: u.row });
  }

  console.log('\n[3] body cannot change the actor');
  {
    const s = await group(); const lid = await loan(s, s.treasurer); const w0 = await walletC(s.treasurer.id); const g0 = await groupC(s.g);
    const r = await call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.treasurer.token, { approverUserId: s.secretary.id, actorId: s.secretary.id, userId: s.secretary.id });
    const u = await untouched(s, lid, s.treasurer, w0, g0);
    check('[3] body approverUserId/actorId/userId ignored -> still 403; nothing changed', selfRefused(r) && u.ok, { r, row: u.row });
  }

  console.log('\n[4] service-level call');
  {
    const s = await group(); const lid = await loan(s, s.treasurer); const w0 = await walletC(s.treasurer.id); const g0 = await groupC(s.g);
    const a = await attempt(vicoba.approveLoan(s.treasurer.id, lid, 30000));
    const u = await untouched(s, lid, s.treasurer, w0, g0);
    check('[4] approveLoan(applicant) throws statusCode 403 with the message; nothing changed', !a.ok && a.status === 403 && a.msg === MSG && u.ok, { a, row: u.row });
    const b = await attempt(vicoba.approveLoan(String(s.treasurer.id), lid, 30000));
    check('[4] same user id given as a string -> 403 too', !b.ok && b.status === 403 && b.msg === MSG, b);
  }

  console.log('\n[5] approval chain unchanged (owner decision 2)');
  {
    const s = await group(); const lid = await loan(s, s.treasurer); const w0 = await walletC(s.treasurer.id); const g0 = await groupC(s.g);
    const r = await call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.secretary.token, {});
    const row = await loanRow(lid);
    check('[5a] KATIBU approves the MWEKAHAZINA\'s loan -> 200, DISBURSED, approved by KATIBU, applicant paid once', r.status === 200 && r.body.success === true && row.status === 'DISBURSED' && Number(row.treasurer_approved_by) === Number(s.secretary.id) && (await txCount(lid)) === 1 && (await walletC(s.treasurer.id)) === w0 + 3000000 && (await groupC(s.g)) === g0 - 3000000, { r, row });
    const lid2 = await loan(s, s.secretary);
    const r2 = await call('POST', `/api/v1/vicoba/loans/${lid2}/approve`, s.treasurer.token, { approvedAmount: 10000 });
    check('[5b] MWEKAHAZINA approves the KATIBU\'s loan -> 200, DISBURSED', r2.status === 200 && (await loanRow(lid2)).status === 'DISBURSED', r2);
    const lid3 = await loan(s, s.member);
    const r3 = await call('POST', `/api/v1/vicoba/loans/${lid3}/approve`, s.treasurer.token, {});
    check('[5c] MWEKAHAZINA approves a member loan -> 200, DISBURSED', r3.status === 200 && (await loanRow(lid3)).status === 'DISBURSED', r3);
    const lid4 = await loan(s, s.member);
    const r4 = await call('POST', `/api/v1/vicoba/loans/${lid4}/approve`, s.chair.token, {});
    check('[5d] MWENYEKITI cannot do the second step -> 403 role message', r4.status === 403 && r4.body.message === 'Mwekahazina au Katibu ndiye anayeidhinisha kiasi.' && (await loanRow(lid4)).status === 'PENDING', r4);
    const r5 = await call('POST', `/api/v1/vicoba/loans/${lid4}/approve`, s.member.token, {});
    check('[5e] plain member -> 403 role message', r5.status === 403 && r5.body.message === 'Mwekahazina au Katibu ndiye anayeidhinisha kiasi.', r5);
    const outsider = await user('outsider');
    await pool.query(`INSERT INTO user_service_subscriptions (user_id, service_key, status) VALUES ($1,'VICOBA','ACTIVE') ON CONFLICT DO NOTHING`, [outsider.id]);
    const r6 = await call('POST', `/api/v1/vicoba/loans/${lid4}/approve`, outsider.token, {});
    check('[5f] non-member -> 403 Hauko kwenye kikundi husika.', r6.status === 403 && r6.body.message === 'Hauko kwenye kikundi husika.', r6);
    const lid5 = await loan(s, s.member, { chairOk: false });
    const r7 = await call('POST', `/api/v1/vicoba/loans/${lid5}/approve`, s.treasurer.token, {});
    check('[5g] no chairman approval -> 400 (chair step still required first)', r7.status === 400 && r7.body.message === 'Ombi bado halijaidhinishwa na Mwenyekiti.' && (await loanRow(lid5)).status === 'PENDING', r7);
    const r8 = await call('POST', `/api/v1/vicoba/loans/${lid3}/approve`, s.treasurer.token, {});
    check('[5h] retry of a committed approval by the same (non-applicant) approver -> idempotent 200', r8.status === 200 && r8.body.success === true && (await txCount(lid3)) === 1, r8);
  }

  console.log('\n[6] static ordering');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/vicobaService.js'), 'utf8');
    const start = src.indexOf('async function approveLoan(');
    const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
    const iBegin = body.indexOf("client.query('BEGIN')");
    const iLock = body.indexOf('FOR UPDATE OF lr');
    const iSelf = body.indexOf(MSG);
    const iUpd = body.search(/UPDATE\s+[a-z_]+\s+SET/i); // first real UPDATE (not "FOR UPDATE OF lr")
    check('[6] self check after BEGIN and the loan row lock, before the first UPDATE', iBegin > 0 && iLock > iBegin && iSelf > iLock && iUpd > iSelf, { iBegin, iLock, iSelf, iUpd });
  }

  console.log('\n[7] race: legitimate KATIBU approval paused before COMMIT; applicant self-approves');
  {
    const s = await group(); const lid = await loan(s, s.treasurer); const w0 = await walletC(s.treasurer.id); const g0 = await groupC(s.g);
    const g = await pausedAt('COMMIT');
    let legit; let self; let selfSettledEarly = null;
    try {
      const pL = attempt(vicoba.approveLoan(s.secretary.id, lid, 30000));
      const didPause = await g.waitPaused();
      check('[7] setup: KATIBU approval paused before COMMIT (holds the loan row lock)', didPause);
      let settled = false;
      const pS = attempt(vicoba.approveLoan(s.treasurer.id, lid, 30000)).then((x) => { settled = true; return x; });
      await sleep(300); selfSettledEarly = settled;
      g.release();
      legit = await pL; self = await pS;
    } finally { gate.armed = false; g.release(); }
    check('[7] self-approval waited on the row lock (did not settle while the lock was held)', selfSettledEarly === false, selfSettledEarly);
    check('[7] legit approval OK; self-approval 403 with the message', legit.ok && !self.ok && self.status === 403 && self.msg === MSG, { legit, self });
    const row = await loanRow(lid);
    check('[7] DISBURSED by KATIBU; one transaction; applicant paid once', row.status === 'DISBURSED' && Number(row.treasurer_approved_by) === Number(s.secretary.id) && (await txCount(lid)) === 1 && (await walletC(s.treasurer.id)) === w0 + 3000000 && (await groupC(s.g)) === g0 - 3000000, row);
  }

  console.log('\n[8] two parallel self-approvals');
  {
    const s = await group(); const lid = await loan(s, s.treasurer); const w0 = await walletC(s.treasurer.id); const g0 = await groupC(s.g);
    const [a, b] = await Promise.all([
      call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.treasurer.token, {}),
      call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.treasurer.token, {}),
    ]);
    const u = await untouched(s, lid, s.treasurer, w0, g0);
    check('[8] both 403 with the message; nothing moved', selfRefused(a) && selfRefused(b) && u.ok, { a, b, row: u.row });
  }

  console.log('\n[9] legacy DISBURSED loan: applicant retries as approver');
  {
    const s = await group(); const lid = await loan(s, s.treasurer, { status: 'DISBURSED' });
    await pool.query('UPDATE vicoba_loan_requests SET treasurer_approval=TRUE, treasurer_approved_by=$2, approved_amount=requested_amount WHERE id=$1', [lid, s.treasurer.id]);
    const w0 = await walletC(s.treasurer.id); const g0 = await groupC(s.g);
    const r = await call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.treasurer.token, {});
    check('[9] -> 403 with the message (no idempotent success for a self-approver); nothing moved', selfRefused(r) && (await walletC(s.treasurer.id)) === w0 && (await groupC(s.g)) === g0 && (await loanRow(lid)).status === 'DISBURSED', r);
  }

  console.log(`\nR30 F-D5-5: ${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
