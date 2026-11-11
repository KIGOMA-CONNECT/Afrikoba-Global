#!/usr/bin/env node
'use strict';
/* R27 IV-A-6 — EVENT_WITHDRAWAL executor must pay from the locked event_withdrawals row,
 * never from approval_flows.data, and a flow must be bound to the withdrawal it executes.
 *
 *  [1] admin-authored flow (POST /admin/approvals) on a customer's withdrawal that already
 *      has its own approval flow, data {amount:30000, userId:adminA}: approve -> no money to A,
 *      pool unchanged, withdrawal stays PENDING (not FAILED, not PAID), flow back to PENDING.
 *  [2] admin-authored flow on a withdrawal with no bound flow, data overriding amount/userId:
 *      payload/row mismatch is refused (409), nothing moves, withdrawal not FAILED.
 *  [3] the customer's own (production) flow whose stored data was tampered: refused, nothing moves.
 *  [4] the customer's own untampered flow: pays the recorded amount to the recorded user once.
 *  [5] direct (below-threshold) withdrawal still settles immediately.
 *  [6] concurrency: 4 parallel approvals of a bound flow pay exactly once.
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
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const gov = require(path.join(ROOT, 'src/services/governanceService'));
const eventService = require(path.join(ROOT, 'src/services/eventService'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

const app = express();
app.use(express.json());
app.use('/api/v1/admin', require(path.join(ROOT, 'src/routes/adminRoutes')));
require(path.join(ROOT, 'src/routes/eventRoutes')); // registers the EVENT_WITHDRAWAL executor
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const num = async (s, p) => Number(Object.values(await q1(s, p))[0]);
let seq = 0;
async function user(label, role) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R27A6 ${label}`, `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
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
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);
const poolBal = (ev) => num('SELECT collected_amount FROM social_events WHERE id=$1', [ev]);
const wrow = (id) => q1('SELECT status, amount::float AS amount, user_id FROM event_withdrawals WHERE id=$1', [id]);
const flowStatus = async (id) => (await q1('SELECT status FROM approval_flows WHERE id=$1', [id])).status;

async function eventWithMember(owner, collected) {
  const ev = await q1(`INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R27A6 ev',$1,10000000,$2) RETURNING id`, [owner.id, collected]);
  await pool.query(`INSERT INTO event_members (event_id, user_id, status) VALUES ($1,$2,'ACTIVE') ON CONFLICT DO NOTHING`, [ev.id, owner.id]);
  return ev.id;
}

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  await pool.query(`INSERT INTO config_settings (key, value) VALUES ('EVENT_WITHDRAWAL_THRESHOLD','10000')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const A = await user('adminA', 'ADMIN');
  const B = await user('adminB', 'ADMIN');

  console.log('\n[1] admin-authored flow on a withdrawal bound to the customer\'s own flow');
  {
    const owner = await user('owner1');
    const ev = await eventWithMember(owner, 100000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 20000, mode: 'FUNDRAISING' });
    check('setup: high-value withdrawal requires approval and is bound to a flow', req.requiresApproval && req.approvalFlowId > 0, req);
    const wid = req.withdrawal.id; const ref = req.withdrawal.reference_id;
    const a0 = await wallet(A.id); const p0 = await poolBal(ev);
    const cr = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: 'EVENT_WITHDRAWAL', refType: 'EVENT_WITHDRAWAL', refId: wid, data: { eventId: ev, withdrawalId: wid, mode: 'FUNDRAISING', amount: 30000, userId: A.id, reference: ref } });
    const d = cr.status === 200 ? await call('POST', `/api/v1/admin/approvals/${cr.body.flow.id}/decide`, B.token, { action: 'APPROVE' }) : { status: cr.status };
    check('forged flow does not pay admin A', (await wallet(A.id)) - a0 === 0, { decide: d.status, paid: (await wallet(A.id)) - a0 });
    check('event pool untouched', (await poolBal(ev)) === p0, { before: p0, after: await poolBal(ev) });
    const r = await wrow(wid);
    check('customer withdrawal still PENDING (not FAILED/PAID)', r.status === 'PENDING', r);
    check('forged flow answered 409, not executed', d.status === 409 && (cr.status !== 200 || (await flowStatus(cr.body.flow.id)) === 'PENDING'), { decide: d.status, body: d.body });
    // the customer's own flow still works afterwards
    const o0 = await wallet(owner.id);
    const d2 = await call('POST', `/api/v1/admin/approvals/${req.approvalFlowId}/decide`, B.token, { action: 'APPROVE' });
    check('[4] own flow pays the recorded 20000 to the owner', d2.status === 200 && (await wallet(owner.id)) - o0 === 20000, { decide: d2.status, got: (await wallet(owner.id)) - o0 });
    check('[4] row PAID 20000 to owner, pool -20000', (await wrow(wid)).status === 'PAID' && (await poolBal(ev)) === p0 - 20000);
  }

  console.log('\n[2] admin-authored flow on an unbound withdrawal row, payload overriding amount/userId');
  {
    const owner = await user('owner2');
    const ev = await eventWithMember(owner, 40000);
    const ref = `R27A6-EVW-${Date.now()}`;
    const w = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status, requires_approval) VALUES ($1,$2,'FUNDRAISING',1000,$3,'PENDING',TRUE) RETURNING id`, [ev, owner.id, ref]);
    const a0 = await wallet(A.id); const p0 = await poolBal(ev);
    const cr = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: 'EVENT_WITHDRAWAL', refType: 'EVENT_WITHDRAWAL', refId: w.id, data: { eventId: ev, withdrawalId: w.id, mode: 'FUNDRAISING', amount: 30000, userId: A.id, reference: ref } });
    const d = cr.status === 200 ? await call('POST', `/api/v1/admin/approvals/${cr.body.flow.id}/decide`, B.token, { action: 'APPROVE' }) : { status: cr.status };
    check('payload amount/userId never paid (A +0)', (await wallet(A.id)) - a0 === 0, { decide: d.status, paid: (await wallet(A.id)) - a0 });
    check('pool not debited 30000', (await poolBal(ev)) >= p0 - 1000, { before: p0, after: await poolBal(ev) });
    const r = await wrow(w.id);
    check('row not marked FAILED by a refused flow', r.status !== 'FAILED', r);
    check('mismatched payload refused with 409', d.status === 409, { decide: d.status, body: d.body });
  }

  console.log('\n[3] customer\'s own flow with tampered stored data');
  {
    const owner = await user('owner3');
    const thief = await user('thief');
    const ev = await eventWithMember(owner, 100000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 15000, mode: 'FUNDRAISING' });
    await pool.query(`UPDATE approval_flows SET data = jsonb_set(jsonb_set(data::jsonb,'{amount}','50000'),'{userId}',to_jsonb($2::int)) WHERE id=$1`, [req.approvalFlowId, thief.id]);
    const t0 = await wallet(thief.id); const o0 = await wallet(owner.id); const p0 = await poolBal(ev);
    const d = await call('POST', `/api/v1/admin/approvals/${req.approvalFlowId}/decide`, B.token, { action: 'APPROVE' });
    check('tampered data: thief gets nothing', (await wallet(thief.id)) - t0 === 0, (await wallet(thief.id)) - t0);
    check('tampered data: pool never debited 50000', p0 - (await poolBal(ev)) !== 50000, { before: p0, after: await poolBal(ev) });
    check('tampered data: owner not paid a different amount', [0, 15000].includes((await wallet(owner.id)) - o0), (await wallet(owner.id)) - o0);
    check('tampered data refused (409) and row not FAILED', d.status === 409 && (await wrow(req.withdrawal.id)).status === 'PENDING', { decide: d.status, row: await wrow(req.withdrawal.id) });
  }

  console.log('\n[5] direct (below-threshold) withdrawal');
  {
    const owner = await user('owner5');
    const ev = await eventWithMember(owner, 40000);
    const o0 = await wallet(owner.id);
    const r = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 3000, mode: 'FUNDRAISING' });
    check('direct withdrawal settles immediately (owner +3000, row PAID)', !r.requiresApproval && (await wallet(owner.id)) - o0 === 3000 && (await wrow(r.withdrawal.id)).status === 'PAID', { r: r.requiresApproval, got: (await wallet(owner.id)) - o0 });
  }

  console.log('\n[6] concurrency: 4 parallel approvals of a bound flow');
  {
    const owner = await user('owner6');
    const ev = await eventWithMember(owner, 100000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 25000, mode: 'FUNDRAISING' });
    const checkers = [];
    for (let i = 0; i < 4; i++) checkers.push(await user(`chk${i}`, 'ADMIN'));
    const o0 = await wallet(owner.id); const p0 = await poolBal(ev);
    const res = await Promise.all(checkers.map((c) => call('POST', `/api/v1/admin/approvals/${req.approvalFlowId}/decide`, c.token, { action: 'APPROVE' })));
    const ok = res.filter((x) => x.status === 200).length;
    check('exactly one approval succeeds', ok === 1, res.map((x) => x.status));
    check('owner paid once (+25000), pool -25000', (await wallet(owner.id)) - o0 === 25000 && p0 - (await poolBal(ev)) === 25000, { got: (await wallet(owner.id)) - o0, pool: p0 - (await poolBal(ev)) });
  }

  console.log('\n[7] a second flow on an already PAID (unbound) withdrawal pays nothing');
  {
    const owner = await user('owner7');
    const ev = await eventWithMember(owner, 40000);
    const ref = `R27A6-PAID-${Date.now()}`;
    const w = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status, requires_approval) VALUES ($1,$2,'FUNDRAISING',2000,$3,'PAID',TRUE) RETURNING id`, [ev, owner.id, ref]);
    const o0 = await wallet(owner.id); const p0 = await poolBal(ev);
    const cr = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: 'EVENT_WITHDRAWAL', refType: 'EVENT_WITHDRAWAL', refId: w.id, data: { eventId: ev, withdrawalId: w.id, mode: 'FUNDRAISING', amount: 2000, userId: owner.id, reference: `${ref}-2` } });
    const cr2 = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: 'EVENT_WITHDRAWAL', refType: 'EVENT_WITHDRAWAL', refId: w.id, data: { eventId: ev, withdrawalId: w.id, mode: 'FUNDRAISING', amount: 2000, userId: owner.id, reference: ref } });
    await call('POST', `/api/v1/admin/approvals/${cr.body.flow.id}/decide`, B.token, { action: 'APPROVE' });
    await call('POST', `/api/v1/admin/approvals/${cr2.body.flow.id}/decide`, B.token, { action: 'APPROVE' });
    check('PAID row is never paid again (owner +0, pool unchanged)', (await wallet(owner.id)) - o0 === 0 && (await poolBal(ev)) === p0, { got: (await wallet(owner.id)) - o0, pool: p0 - (await poolBal(ev)) });
  }

  console.log('\n[1b] admin-authored flow whose data MATCHES a row bound to another flow');
  {
    const owner = await user('owner1b');
    const ev = await eventWithMember(owner, 100000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 12000, mode: 'FUNDRAISING' });
    const wid = req.withdrawal.id;
    const o0 = await wallet(owner.id); const p0 = await poolBal(ev);
    const cr = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: 'EVENT_WITHDRAWAL', refType: 'EVENT_WITHDRAWAL', refId: wid, data: { eventId: ev, withdrawalId: wid, mode: 'FUNDRAISING', amount: 12000, userId: owner.id, reference: req.withdrawal.reference_id } });
    const d = await call('POST', `/api/v1/admin/approvals/${cr.body.flow.id}/decide`, B.token, { action: 'APPROVE' });
    check('a flow other than the bound one cannot execute the withdrawal (409, nothing moves, row PENDING)',
      d.status === 409 && (await wallet(owner.id)) === o0 && (await poolBal(ev)) === p0 && (await wrow(wid)).status === 'PENDING',
      { decide: d.status, got: (await wallet(owner.id)) - o0, row: await wrow(wid) });
  }

  console.log('\n[8] EVENT_WITHDRAWAL flow whose ref_type is not EVENT_WITHDRAWAL');
  {
    const owner = await user('owner8');
    const ev = await eventWithMember(owner, 40000);
    const ref = `R27A6-RT-${Date.now()}`;
    const w = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status, requires_approval) VALUES ($1,$2,'FUNDRAISING',2500,$3,'PENDING',TRUE) RETURNING id`, [ev, owner.id, ref]);
    const o0 = await wallet(owner.id);
    const cr = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: 'EVENT_WITHDRAWAL', refType: 'GENERIC', refId: w.id, data: { eventId: ev, withdrawalId: w.id, mode: 'FUNDRAISING', amount: 2500, userId: owner.id, reference: ref } });
    const d = await call('POST', `/api/v1/admin/approvals/${cr.body.flow.id}/decide`, B.token, { action: 'APPROVE' });
    check('flow not typed EVENT_WITHDRAWAL is refused (409, owner +0, row PENDING)', d.status === 409 && (await wallet(owner.id)) === o0 && (await wrow(w.id)).status === 'PENDING', { decide: d.status, row: await wrow(w.id) });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
