#!/usr/bin/env node
'use strict';
/* R29 D5 (owner decision, option A) — VICOBA group operations are never authorised through the
 * system-admin four-eyes queue. Group authority comes only from the group role (MWEKAHAZINA,
 * KATIBU, MWENYEKITI) of req.user on the direct VICOBA routes; the actor is never taken from a
 * body or a payload. Before: /admin/four-eyes/actions/vicoba-* put req.body.actorId into the
 * payload and the executors called approveLoan / approveSocialFundDisbursement as that user, so
 * two system admins could disburse "as" any group treasurer.
 *  [1] admin launcher vicoba-loan-disburse (actorId = treasurer) -> 403
 *      VICOBA_GROUP_AUTHORITY_REQUIRED, no request row, loan untouched, nothing moves.
 *  [2] admin launcher vicoba-social-disburse -> 403, no request, social fund request untouched.
 *  [3] generic POST /requests with a VICOBA action_code -> 403, no request row.
 *  [4] VICOBA requests that already exist (legacy rows): approve -> never EXECUTED (FAILED with
 *      the code), loan untouched; retry of a FAILED one -> still not executed.
 *  [5] an admin who is also the group's MWEKAHAZINA: four-eyes path refused; the direct VICOBA
 *      route as that user still approves (group role, req.user).
 *  [6] direct routes unchanged: treasurer approves a loan (body actorId ignored, actor =
 *      req.user); plain member -> 403; chair approves social fund; self-approval -> 403.
 *  [7] static: fourEyesRoutes.js never reads actorId from a body or a payload.
 *  [8] concurrency: two admins approve the same legacy VICOBA request at once -> never EXECUTED.
 *  [9] unchanged: a non-VICOBA launcher (large-refund) still creates its request (201).
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
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const vicoba = require(path.join(ROOT, 'src/services/vicobaService'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

const app = express();
app.use(express.json());
app.use('/api/v1/admin/four-eyes', require(path.join(ROOT, 'src/routes/fourEyesRoutes')));
app.use('/api/v1/vicoba', require(path.join(ROOT, 'src/routes/vicobaRoutes')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
const CODE = 'VICOBA_GROUP_AUTHORITY_REQUIRED';
let seq = 0;
async function user(label, role) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R29D5 ${label}`, `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (role) await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, u.id]);
  const r = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]);
  return { id: r.id, token: signToken(r) };
}
let base;
async function call(method, p, token, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}
const refused = (r) => r.status === 403 && r.body && r.body.code === CODE;
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const reqCount = async () => Number((await q1(`SELECT count(*) n FROM four_eyes_requests WHERE action_code IN ('VICOBA_LOAN_DISBURSE','VICOBA_SOCIAL_FUND_DISBURSE')`)).n);
async function group(extra = {}) {
  const chair = extra.chair || await user('chair');
  const treasurer = extra.treasurer || await user('treasurer');
  const member = await user('member');
  const g = await q1(`INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ($1,$2,1000,'ACTIVE',500000) RETURNING id`, [`R29D5 g${++seq}`, chair.id]);
  for (const [u, role] of [[chair, 'MWENYEKITI'], [treasurer, 'MWEKAHAZINA'], [member, 'MJUMBE']]) {
    await pool.query('INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1,$2,$3)', [g.id, u.id, role]);
    // direct VICOBA routes require an ACTIVE service subscription (serviceGuard)
    await pool.query(`INSERT INTO user_service_subscriptions (user_id, service_key, status) VALUES ($1,'VICOBA','ACTIVE') ON CONFLICT DO NOTHING`, [u.id]);
  }
  const fund = await q1(`INSERT INTO vicoba_social_fund (group_id, total_balance, total_collected, monthly_contribution) VALUES ($1,100000,100000,5000) RETURNING id`, [g.id]);
  return { g: g.id, fund: fund.id, chair, treasurer, member };
}
const loan = async (s, amount = 30000) => (await q1(`INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, requested_amount, chairman_approval, chairman_approved_by, status) VALUES ($1,$2,$3,TRUE,$4,'PENDING') RETURNING id`, [s.g, s.member.id, amount, s.chair.id])).id;
const loanRow = async (id) => q1('SELECT status, treasurer_approval, treasurer_approved_by FROM vicoba_loan_requests WHERE id=$1', [id]);
const sfReq = async (s, by) => (await vicoba.requestSocialFundDisbursement(s.g, by.id, { reasonType: 'ILLNESS', reasonDetail: 'r29d5', requestedAmount: 20000 }));
const sfId = (r) => (r && (r.requestId || r.id || (r.request && r.request.id)));
const sfRow = async (id) => q1('SELECT status FROM vicoba_social_fund_requests WHERE id=$1', [id]);
const legacy = async (requester, code, payload, status = 'PENDING') => (await q1(`INSERT INTO four_eyes_requests (action_code, requester_id, payload, status) VALUES ($1,$2,$3,$4) RETURNING id`, [code, requester.id, JSON.stringify(payload), status])).id;
const feRow = async (id) => q1('SELECT status, error FROM four_eyes_requests WHERE id=$1', [id]);

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  await pool.query(`UPDATE feature_flags SET enabled = TRUE, rollout_percent = 100 WHERE flag_key = 'FOUR_EYES'`);
  await pool.query(`UPDATE four_eyes_policies SET enabled = TRUE WHERE action_code IN ('VICOBA_LOAN_DISBURSE','VICOBA_SOCIAL_FUND_DISBURSE','ADMIN_LARGE_REFUND')`);
  const A = await user('adminA', 'ADMIN'); const B = await user('adminB', 'ADMIN'); const C = await user('adminC', 'ADMIN');

  console.log('\n[1] admin launcher vicoba-loan-disburse');
  {
    const s = await group(); const lid = await loan(s); const n0 = await reqCount(); const w0 = await walletC(s.member.id);
    const r = await call('POST', '/api/v1/admin/four-eyes/actions/vicoba-loan-disburse', A.token, { actorId: s.treasurer.id, loanId: lid });
    let execd = null;
    if (r.status === 201 && r.body && r.body.request) execd = await call('POST', `/api/v1/admin/four-eyes/requests/${r.body.request.id}/approve`, B.token, {});
    check('[1] launcher -> 403 VICOBA_GROUP_AUTHORITY_REQUIRED', refused(r), { status: r.status, body: r.body, approve: execd && execd.body && execd.body.request && execd.body.request.status });
    check('[1] no four-eyes request created; loan still PENDING without treasurer approval; borrower not paid', (await reqCount()) === n0 && (await loanRow(lid)).status === 'PENDING' && (await loanRow(lid)).treasurer_approval === false && (await walletC(s.member.id)) === w0, { loan: await loanRow(lid) });
  }

  console.log('\n[2] admin launcher vicoba-social-disburse');
  {
    const s = await group(); const sr = sfId(await sfReq(s, s.member)); const n0 = await reqCount();
    const r = await call('POST', '/api/v1/admin/four-eyes/actions/vicoba-social-disburse', A.token, { actorId: s.chair.id, requestId: sr });
    if (r.status === 201 && r.body && r.body.request) await call('POST', `/api/v1/admin/four-eyes/requests/${r.body.request.id}/approve`, B.token, {});
    check('[2] setup: social fund request exists', Number.isInteger(Number(sr)) && sr != null, sr);
    check('[2] launcher -> 403; no request; social fund request still PENDING', refused(r) && (await reqCount()) === n0 && (await sfRow(sr)).status === 'PENDING', { status: r.status, body: r.body, sf: await sfRow(sr) });
  }

  console.log('\n[3] generic POST /requests with a VICOBA action_code');
  {
    const s = await group(); const lid = await loan(s); const n0 = await reqCount();
    const r1 = await call('POST', '/api/v1/admin/four-eyes/requests', A.token, { action_code: 'VICOBA_LOAN_DISBURSE', payload: { actorId: s.treasurer.id, loanId: lid } });
    const r2 = await call('POST', '/api/v1/admin/four-eyes/requests', A.token, { action_code: 'vicoba_social_fund_disburse', payload: { actorId: s.chair.id, requestId: 1 } });
    check('[3] both -> 403 with the code; no request rows; loan untouched', refused(r1) && refused(r2) && (await reqCount()) === n0 && (await loanRow(lid)).status === 'PENDING', { r1: r1.status, r2: r2.status, b1: r1.body });
  }

  console.log('\n[4] legacy VICOBA requests already in the queue');
  {
    const s = await group(); const lid = await loan(s); const w0 = await walletC(s.member.id);
    const fid = await legacy(A, 'VICOBA_LOAN_DISBURSE', { actorId: s.treasurer.id, loanId: lid });
    const ap = await call('POST', `/api/v1/admin/four-eyes/requests/${fid}/approve`, B.token, {});
    const row = await feRow(fid);
    check('[4] approve does not execute: request FAILED with the code, loan PENDING, nothing paid', row.status === 'FAILED' && String(row.error || '').includes(CODE) && (await loanRow(lid)).status === 'PENDING' && (await walletC(s.member.id)) === w0, { ap: ap.status, row, loan: await loanRow(lid) });
    const rt = await call('POST', `/api/v1/admin/four-eyes/requests/${fid}/retry`, C.token, {});
    const row2 = await feRow(fid);
    check('[4] retry of the FAILED request still does not execute', row2.status !== 'EXECUTED' && (await loanRow(lid)).status === 'PENDING' && (await walletC(s.member.id)) === w0, { rt: rt.status, row2 });
    const sr = sfId(await sfReq(s, s.member));
    const fid2 = await legacy(A, 'VICOBA_SOCIAL_FUND_DISBURSE', { actorId: s.chair.id, requestId: sr });
    await call('POST', `/api/v1/admin/four-eyes/requests/${fid2}/approve`, B.token, {});
    check('[4] legacy social fund request: not executed, social fund request PENDING', (await feRow(fid2)).status === 'FAILED' && (await sfRow(sr)).status === 'PENDING', { fe: await feRow(fid2), sf: await sfRow(sr) });
  }

  console.log('\n[5] admin who is also the group treasurer');
  {
    const T = await user('adminTreasurer', 'ADMIN');
    const s = await group({ treasurer: T }); const lid = await loan(s); const w0 = await walletC(s.member.id);
    const r = await call('POST', '/api/v1/admin/four-eyes/actions/vicoba-loan-disburse', T.token, { loanId: lid });
    const fid = await legacy(A, 'VICOBA_LOAN_DISBURSE', { loanId: lid }); // no actorId: the old fallback was the approver
    await call('POST', `/api/v1/admin/four-eyes/requests/${fid}/approve`, T.token, {});
    check('[5] four-eyes path refused for the admin-treasurer (launcher 403; approve fallback does not execute)', refused(r) && (await feRow(fid)).status === 'FAILED' && (await loanRow(lid)).status === 'PENDING', { r: r.status, fe: await feRow(fid) });
    const d = await call('POST', `/api/v1/vicoba/loans/${lid}/approve`, T.token, {});
    const lr = await loanRow(lid);
    check('[5] direct VICOBA route as that user approves (group role, req.user)', d.status === 200 && lr.treasurer_approval === true && lr.treasurer_approved_by === T.id && (await walletC(s.member.id)) > w0, { d: d.status, body: d.body, lr });
  }

  console.log('\n[6] direct VICOBA routes unchanged');
  {
    const s = await group(); const lid = await loan(s); const w0 = await walletC(s.member.id);
    const m = await call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.member.token, {});
    check('[6] plain member -> 403 (group role, not the service guard)', m.status === 403 && (!m.body || m.body.code !== 'SERVICE_NOT_SUBSCRIBED'), m);
    const d = await call('POST', `/api/v1/vicoba/loans/${lid}/approve`, s.treasurer.token, { actorId: s.member.id, approverUserId: s.member.id });
    const lr = await loanRow(lid);
    check('[6] treasurer approves; actor = req.user (body actorId ignored); borrower paid', d.status === 200 && lr.treasurer_approved_by === s.treasurer.id && (await walletC(s.member.id)) - w0 === 3000000, { d: d.status, lr });
    const sr = sfId(await sfReq(s, s.member));
    const self = await sfReq(s, s.chair); const selfId = sfId(self);
    const sa = await call('POST', `/api/v1/vicoba/social-fund-requests/${selfId}/approve`, s.chair.token, {});
    check('[6] social fund self-approval -> 403 (not the service guard)', sa.status === 403 && (!sa.body || sa.body.code !== 'SERVICE_NOT_SUBSCRIBED'), sa);
    const ok = await call('POST', `/api/v1/vicoba/social-fund-requests/${sr}/approve`, s.chair.token, {});
    check('[6] chair approves a member\'s social fund request -> 200', ok.status === 200 && (await sfRow(sr)).status !== 'PENDING', { ok: ok.status, body: ok.body });
  }

  console.log('\n[7] static');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/fourEyesRoutes.js'), 'utf8');
    check('[7] fourEyesRoutes.js does not read actorId from a body or a payload', !/req\.body\.actorId/.test(src) && !/payload\.actorId/.test(src));
  }

  console.log('\n[8] concurrency: two admins approve the same legacy VICOBA request');
  {
    const bad = [];
    for (let i = 0; i < 5; i++) {
      const s = await group(); const lid = await loan(s); const w0 = await walletC(s.member.id);
      const fid = await legacy(A, 'VICOBA_LOAN_DISBURSE', { actorId: s.treasurer.id, loanId: lid });
      const [x, y] = await Promise.all([
        call('POST', `/api/v1/admin/four-eyes/requests/${fid}/approve`, B.token, {}),
        call('POST', `/api/v1/admin/four-eyes/requests/${fid}/approve`, C.token, {}),
      ]);
      const row = await feRow(fid);
      if (row.status === 'EXECUTED' || (await loanRow(lid)).status !== 'PENDING' || (await walletC(s.member.id)) !== w0) bad.push({ x: x.status, y: y.status, row });
    }
    check('[8] never EXECUTED, loan never touched', bad.length === 0, bad);
  }

  console.log('\n[9] non-VICOBA launcher unchanged');
  {
    const tgt = await user('refundee');
    const r = await call('POST', '/api/v1/admin/four-eyes/actions/large-refund', A.token, { userId: tgt.id, amount: 1000 });
    check('[9] large-refund launcher still 201 with a request', r.status === 201 && r.body && r.body.request && r.body.request.action_code === 'ADMIN_LARGE_REFUND', { status: r.status, body: r.body });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
