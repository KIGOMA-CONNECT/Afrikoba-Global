#!/usr/bin/env node
'use strict';
/* R30 F-D5-5 (owner decision 4) — VICOBA loan request maker-checker at creation.
 * vicobaService.requestLoan writes chairman_approval = TRUE, chairman_approved_by = creator. It now
 * refuses (403, 'Huwezi kuidhinisha ombi lako mwenyewe.') when the creator (req.user) is also the
 * applicant, before the INSERT. Before: a MWENYEKITI (or MWEKAHAZINA/KATIBU, who may also create)
 * created a request for themselves and the chair step was "approved" by the applicant.
 *  [1] MWENYEKITI creates a loan request for self (POST /groups/:id/loans) -> 403 + message, no row.
 *  [2] MWEKAHAZINA and KATIBU creating for self -> 403, no row.
 *  [3] body cannot change the creator (chairmanUserId/actorId/userId in the body ignored).
 *  [4] applicantUserId sent as a string of the creator's id -> 403.
 *  [5] unchanged: chair creates for a member -> 201 (chairman_approval TRUE, approved by chair);
 *      treasurer creates for a member -> 201; plain member -> 403 role message; full chain still
 *      ends DISBURSED (chair creates, treasurer approves).
 *  [6] governance-style sequence (same actor for both steps, actor = applicant): requestLoan
 *      refuses first, so no orphan PENDING loan is left behind.
 *  [7] static: the check sits before the INSERT in requestLoan.
 *  [8] parallel self-creations -> both 403, no row.
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
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, code: e.code, msg: e.message }));
let seq = 0;
async function user(label) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R30D4 ${label}`, `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
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
  const g = await q1(`INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ($1,$2,1000,'ACTIVE',500000) RETURNING id`, [`R30D4 g${++seq}`, chair.id]);
  for (const [u, role] of [[chair, 'MWENYEKITI'], [treasurer, 'MWEKAHAZINA'], [secretary, 'KATIBU'], [member, 'MJUMBE']]) {
    await pool.query('INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1,$2,$3)', [g.id, u.id, role]);
    await pool.query(`INSERT INTO user_service_subscriptions (user_id, service_key, status) VALUES ($1,'VICOBA','ACTIVE') ON CONFLICT DO NOTHING`, [u.id]);
  }
  return { g: g.id, chair, treasurer, secretary, member };
}
const loansOf = async (s, applicant) => Number((await q1('SELECT count(*) n FROM vicoba_loan_requests WHERE group_id=$1 AND applicant_user_id=$2', [s.g, applicant.id])).n);
const create = (s, by, applicantUserId, extra = {}) => call('POST', `/api/v1/vicoba/groups/${s.g}/loans`, by.token, { applicantUserId, requestedAmount: 30000, ...extra });
const selfRefused = (r) => r.status === 403 && r.body && r.body.message === MSG;

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n[1] MWENYEKITI creates a loan request for self');
  {
    const s = await group();
    const r = await create(s, s.chair, s.chair.id);
    check('[1] -> 403 with the owner message; no loan row', selfRefused(r) && (await loansOf(s, s.chair)) === 0, r);
  }

  console.log('\n[2] MWEKAHAZINA / KATIBU create for self');
  {
    const s = await group();
    const a = await create(s, s.treasurer, s.treasurer.id);
    const b = await create(s, s.secretary, s.secretary.id);
    check('[2] both -> 403 with the message; no rows', selfRefused(a) && selfRefused(b) && (await loansOf(s, s.treasurer)) === 0 && (await loansOf(s, s.secretary)) === 0, { a, b });
  }

  console.log('\n[3] body cannot change the creator');
  {
    const s = await group();
    const r = await create(s, s.chair, s.chair.id, { chairmanUserId: s.treasurer.id, actorId: s.treasurer.id, userId: s.treasurer.id });
    check('[3] -> still 403; no row', selfRefused(r) && (await loansOf(s, s.chair)) === 0, r);
  }

  console.log('\n[4] applicant id as a string');
  {
    const s = await group();
    const r = await create(s, s.chair, String(s.chair.id));
    const a = await attempt(vicoba.requestLoan(String(s.chair.id), { groupId: s.g, applicantUserId: s.chair.id, requestedAmount: 30000 }));
    check('[4] HTTP string applicant and service string creator -> 403; no row', selfRefused(r) && !a.ok && a.status === 403 && a.msg === MSG && (await loansOf(s, s.chair)) === 0, { r, a });
  }

  console.log('\n[5] unchanged paths');
  {
    const s = await group();
    const r = await create(s, s.chair, s.member.id);
    const row = r.body && r.body.loan;
    check('[5a] chair creates for a member -> 201, chairman_approval TRUE by chair, PENDING', r.status === 201 && row && row.chairman_approval === true && Number(row.chairman_approved_by) === Number(s.chair.id) && row.status === 'PENDING', r);
    const r2 = await create(s, s.treasurer, s.secretary.id);
    check('[5b] MWEKAHAZINA creates for the KATIBU -> 201', r2.status === 201 && Number(r2.body.loan.chairman_approved_by) === Number(s.treasurer.id), r2);
    const r3 = await create(s, s.member, s.secretary.id);
    check('[5c] plain member -> 403 role message', r3.status === 403 && r3.body.message === 'Mwenyekiti au Katibu ndiye anayeweza kuongeza ombi la mkopo.', r3);
    const ap = await call('POST', `/api/v1/vicoba/loans/${row.id}/approve`, s.treasurer.token, {});
    const st = (await q1('SELECT status FROM vicoba_loan_requests WHERE id=$1', [row.id])).status;
    check('[5d] full chain: chair created, treasurer approves -> 200 DISBURSED', ap.status === 200 && st === 'DISBURSED', { ap, st });
  }

  console.log('\n[6] governance-style sequence, actor = applicant');
  {
    const s = await group();
    const a = await attempt(vicoba.requestLoan(s.treasurer.id, { groupId: s.g, applicantUserId: s.treasurer.id, requestedAmount: 30000 }));
    check('[6] requestLoan refuses first (403); no orphan PENDING loan', !a.ok && a.status === 403 && a.msg === MSG && (await loansOf(s, s.treasurer)) === 0, a);
  }

  console.log('\n[7] static ordering');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/vicobaService.js'), 'utf8');
    const start = src.indexOf('async function requestLoan(');
    const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
    const iSelf = body.indexOf(MSG); const iIns = body.indexOf('INSERT INTO vicoba_loan_requests');
    check('[7] self check before the INSERT', iSelf > 0 && iIns > iSelf, { iSelf, iIns });
  }

  console.log('\n[8] parallel self-creations');
  {
    const s = await group();
    const [a, b] = await Promise.all([create(s, s.chair, s.chair.id), create(s, s.chair, s.chair.id)]);
    check('[8] both 403; no row', selfRefused(a) && selfRefused(b) && (await loansOf(s, s.chair)) === 0, { a, b });
  }

  console.log(`\nR30 D4: ${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
