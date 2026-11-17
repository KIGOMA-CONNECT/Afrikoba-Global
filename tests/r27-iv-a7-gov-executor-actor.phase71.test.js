#!/usr/bin/env node
'use strict';
/* R27 IV-A-7 — governance executors BUSINESS_LOAN_DISBURSE / CREDIT_LOAN_DISBURSE must take the acting
 * admin from the approval_flows row (requester_id, set from req.user at creation), never data.requesterId,
 * and the loan from flow.ref_id (data.loanId may only repeat it).
 *  [1] flow via POST /admin/approvals with data.requesterId = decoy -> service audit actor is the maker.
 *  [2] data.loanId != ref_id -> refused (409); neither loan disbursed.
 *  [3] fixture-style flow without ref_id (data.loanId only) still executes; actor = requester.
 *  [4] flow whose ref_type is not the loan type -> refused, nothing disbursed.
 * Requires a DISPOSABLE database phase71_financial_audit_<suffix> on 127.0.0.1:55481.
 */
const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55481') {
  console.error('REFUSING: disposable r26-ci-db (127.0.0.1:55481, phase71_financial_audit_*) only'); process.exit(2);
}
process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = { post: async () => { throw new Error('net off'); }, get: async () => { throw new Error('net off'); }, create() { return this; }, defaults: { headers: { common: {} } }, interceptors: { request: { use() {} }, response: { use() {} } } };
const express = require(path.join(ROOT, 'node_modules/express'));
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const gov = require(path.join(ROOT, 'src/services/governanceService'));
const business = require(path.join(ROOT, 'src/services/businessService'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

const app = express();
app.use(express.json());
app.use('/api/v1/admin', require(path.join(ROOT, 'src/routes/adminRoutes')));
require(path.join(ROOT, 'src/routes/businessRoutes'));
require(path.join(ROOT, 'src/routes/creditRoutes'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const num = async (s, p) => Number(Object.values(await q1(s, p))[0]);
let seq = 0;
async function user(label, role) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R27A7 ${label}`, `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
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
async function bizLoan(amount = 9000) {
  const owner = await user('biz-owner');
  const biz = await business.registerBusiness(owner.id, { business_name: `R27A7 shop ${seq}` });
  return (await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status) VALUES ($1,$2,$3,10,12,'APPROVED') RETURNING id`, [biz.id, owner.id, amount])).id;
}
async function microLoan(amount = 7000) {
  const b = await user('borrower');
  return (await q1(`INSERT INTO micro_loans (user_id, amount, interest_rate, term_months, status, approved_at) VALUES ($1,$2,10,1,'APPROVED',NOW()) RETURNING id`, [b.id, amount])).id;
}
const bizStatus = async (id) => (await q1('SELECT status FROM business_loans WHERE id=$1', [id])).status;
const mlStatus = async (id) => (await q1('SELECT status FROM micro_loans WHERE id=$1', [id])).status;
const lastAudit = (action, after) => q1('SELECT user_id FROM audit_logs WHERE id>$1 AND action=$2 ORDER BY id DESC LIMIT 1', [after, action]);
const maxAudit = () => num('SELECT COALESCE(MAX(id),0) FROM audit_logs');

const KINDS = [
  { t: 'BUSINESS_LOAN_DISBURSE', ref: 'BUSINESS_LOAN', mk: bizLoan, amount: 9000, audit: 'LOAN_DISBURSED', st: bizStatus, done: 'DISBURSED', untouched: 'APPROVED' },
  { t: 'CREDIT_LOAN_DISBURSE', ref: 'MICRO_LOAN', mk: microLoan, amount: 7000, audit: 'MICRO_LOAN_DISBURSED', st: mlStatus, done: 'ACTIVE', untouched: 'APPROVED' },
];

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const A = await user('maker', 'ADMIN');
  const B = await user('checker', 'ADMIN');
  const decoy = await user('decoy', 'ADMIN');

  for (const k of KINDS) {
    console.log(`\n[1] ${k.t}: data.requesterId=decoy`);
    {
      const loanId = await k.mk();
      const g0 = await maxAudit();
      const f = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: k.t, refType: k.ref, refId: loanId, data: { loanId, requesterId: decoy.id, amount: k.amount } });
      const d = await call('POST', `/api/v1/admin/approvals/${f.body.flow.id}/decide`, B.token, { action: 'APPROVE' });
      const a = await lastAudit(k.audit, g0);
      check(`${k.t}: executed (loan ${k.done})`, d.status === 200 && (await k.st(loanId)) === k.done, { decide: d.status, st: await k.st(loanId) });
      check(`${k.t}: ${k.audit} actor is the flow requester (maker), not data.requesterId`, a && Number(a.user_id) === A.id, { actor: a && a.user_id, maker: A.id, decoy: decoy.id });
    }

    console.log(`\n[2] ${k.t}: data.loanId differs from ref_id`);
    {
      const refLoan = await k.mk();
      const otherLoan = await k.mk();
      const f = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: k.t, refType: k.ref, refId: refLoan, data: { loanId: otherLoan, amount: k.amount } });
      const d = await call('POST', `/api/v1/admin/approvals/${f.body.flow.id}/decide`, B.token, { action: 'APPROVE' });
      check(`${k.t}: refused with 409`, d.status === 409, { decide: d.status, body: d.body && d.body.message });
      check(`${k.t}: neither loan disbursed`, (await k.st(refLoan)) === k.untouched && (await k.st(otherLoan)) === k.untouched, { ref: await k.st(refLoan), other: await k.st(otherLoan) });
    }

    console.log(`\n[3] ${k.t}: flow without ref_id (data.loanId only)`);
    {
      const loanId = await k.mk();
      const g0 = await maxAudit();
      const flow = await gov.createApprovalFlow({ requesterId: A.id, actionType: k.t, refType: k.ref, data: { loanId, requesterId: decoy.id, amount: k.amount } });
      const out = await gov.decideApprovalFlow(flow.id, B.id, 'APPROVE');
      const a = await lastAudit(k.audit, g0);
      check(`${k.t}: executes from data.loanId when ref_id is NULL`, out.flow.status === 'APPROVED' && (await k.st(loanId)) === k.done);
      check(`${k.t}: actor = requester`, a && Number(a.user_id) === A.id, { actor: a && a.user_id });
    }

    console.log(`\n[4] ${k.t}: ref_type is not ${k.ref}`);
    {
      const loanId = await k.mk();
      const f = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: k.t, refType: 'GENERIC', refId: loanId, data: { loanId, amount: k.amount } });
      const d = await call('POST', `/api/v1/admin/approvals/${f.body.flow.id}/decide`, B.token, { action: 'APPROVE' });
      check(`${k.t}: wrong ref_type refused (409), loan untouched`, d.status === 409 && (await k.st(loanId)) === k.untouched, { decide: d.status, st: await k.st(loanId) });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
