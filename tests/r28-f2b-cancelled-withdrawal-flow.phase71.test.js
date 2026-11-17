#!/usr/bin/env node
'use strict';
/* R28 F2b — an EVENT_WITHDRAWAL approval flow must not be reported as executed when its bound
 * withdrawal was cancelled (REJECTED) or has FAILED. Before: executeEventWithdrawal took its
 * "already processed" (dedup) branch, decideApprovalFlow marked the flow APPROVED and wrote
 * APPROVAL_FLOW_EXECUTED although no money moved.
 *  [1] a withdrawal bound to a pending flow is REJECTED (legacy cancel, before R29 D3); an admin approves ->
 *      409, flow stays PENDING (an admin can still REJECT it), no APPROVAL_FLOW_EXECUTED, nothing moves.
 *  [2] bound withdrawal FAILED (pool too small at approval) and the pool is refilled; approving
 *      again -> 409, flow PENDING, no APPROVAL_FLOW_EXECUTED, nothing moves.
 *  [3] the refused flow can still be REJECTED by an admin (flow REJECTED, nothing moves).
 *  [4] unchanged: a bound withdrawal already PAID by its own flow -> executor re-run returns dedup
 *      (no error, no second payment), so a retry after a post-payment failure still closes the flow.
 *  [5] unchanged: direct path (no flow) on a REJECTED row returns dedup, nothing moves.
 *  [6] concurrency: owner cancel racing the approval, 10 rounds: never PAID+REJECTED, never paid twice.
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
const cents = (v) => Math.round(Number(v) * 100);
let seq = 0;
async function user(label, role) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R28F2B ${label}`, `2559${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
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
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const poolC = async (ev) => cents((await q1('SELECT collected_amount FROM social_events WHERE id=$1', [ev])).collected_amount);
const wstatus = async (id) => (await q1('SELECT status FROM event_withdrawals WHERE id=$1', [id])).status;
const fstatus = async (id) => (await q1('SELECT status FROM approval_flows WHERE id=$1', [id])).status;
const executedAudits = async (flowId) => Number((await q1(`SELECT COUNT(*)::int n FROM audit_logs WHERE action='APPROVAL_FLOW_EXECUTED' AND entity_id=$1`, [flowId])).n);
async function eventWithMember(owner, collected) {
  const ev = await q1(`INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R28F2B ev',$1,10000000,$2) RETURNING id`, [owner.id, collected]);
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
  const B = await user('adminB', 'ADMIN');

  console.log('\n[1] cancelled withdrawal, flow approved afterwards');
  let flow1;
  {
    const owner = await user('owner1');
    const ev = await eventWithMember(owner, 50000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 20000, mode: 'FUNDRAISING' });
    flow1 = req.approvalFlowId;
    // R29 D3: the owner can no longer cancel a withdrawal with a live flow; a row cancelled
    // before D3 (legacy data) is set up directly so the executor guard stays covered.
    await pool.query(`UPDATE event_withdrawals SET status = 'REJECTED' WHERE id = $1 AND status = 'PENDING'`, [req.withdrawal.id]);
    check('[1] setup: bound flow created, row REJECTED (legacy cancel before R29 D3)', req.requiresApproval && (await wstatus(req.withdrawal.id)) === 'REJECTED');
    const o0 = await walletC(owner.id); const p0 = await poolC(ev);
    const d = await call('POST', `/api/v1/admin/approvals/${flow1}/decide`, B.token, { action: 'APPROVE' });
    check('[1] approve answered 409', d.status === 409, { status: d.status, body: d.body });
    check('[1] flow stays PENDING (not APPROVED)', (await fstatus(flow1)) === 'PENDING', await fstatus(flow1));
    check('[1] no APPROVAL_FLOW_EXECUTED audit', (await executedAudits(flow1)) === 0, await executedAudits(flow1));
    check('[1] nothing moved; row still REJECTED', (await walletC(owner.id)) === o0 && (await poolC(ev)) === p0 && (await wstatus(req.withdrawal.id)) === 'REJECTED');
  }

  console.log('\n[2] FAILED withdrawal, pool refilled, flow approved again');
  {
    const owner = await user('owner2');
    const ev = await eventWithMember(owner, 50000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 20000, mode: 'FUNDRAISING' });
    await pool.query('UPDATE social_events SET collected_amount = 100 WHERE id=$1', [ev]);
    const d1 = await call('POST', `/api/v1/admin/approvals/${req.approvalFlowId}/decide`, B.token, { action: 'APPROVE' });
    check('[2] setup: first approval fails, row FAILED, flow back to PENDING', d1.status !== 200 && (await wstatus(req.withdrawal.id)) === 'FAILED' && (await fstatus(req.approvalFlowId)) === 'PENDING', { d1: d1.status, w: await wstatus(req.withdrawal.id) });
    await pool.query('UPDATE social_events SET collected_amount = 50000 WHERE id=$1', [ev]);
    const o0 = await walletC(owner.id); const p0 = await poolC(ev);
    const d2 = await call('POST', `/api/v1/admin/approvals/${req.approvalFlowId}/decide`, B.token, { action: 'APPROVE' });
    check('[2] second approval answered 409', d2.status === 409, { status: d2.status, body: d2.body });
    check('[2] flow stays PENDING, no APPROVAL_FLOW_EXECUTED', (await fstatus(req.approvalFlowId)) === 'PENDING' && (await executedAudits(req.approvalFlowId)) === 0, { f: await fstatus(req.approvalFlowId), a: await executedAudits(req.approvalFlowId) });
    check('[2] nothing moved; row still FAILED', (await walletC(owner.id)) === o0 && (await poolC(ev)) === p0 && (await wstatus(req.withdrawal.id)) === 'FAILED');
  }

  console.log('\n[3] the refused flow can still be rejected');
  {
    const d = await call('POST', `/api/v1/admin/approvals/${flow1}/decide`, B.token, { action: 'REJECT' });
    check('[3] reject succeeds, flow REJECTED', d.status === 200 && (await fstatus(flow1)) === 'REJECTED', { status: d.status, f: await fstatus(flow1) });
  }

  console.log('\n[4] PAID by its own flow: executor re-run is a dedup');
  {
    const owner = await user('owner4');
    const ev = await eventWithMember(owner, 50000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 20000, mode: 'FUNDRAISING' });
    const d = await call('POST', `/api/v1/admin/approvals/${req.approvalFlowId}/decide`, B.token, { action: 'APPROVE' });
    const o0 = await walletC(owner.id); const p0 = await poolC(ev);
    let res; let err = null;
    try { res = await eventService.executeEventWithdrawal({ withdrawalId: req.withdrawal.id, flowId: req.approvalFlowId }); } catch (e) { err = e; }
    check('[4] setup: paid by its flow', d.status === 200 && (await wstatus(req.withdrawal.id)) === 'PAID');
    check('[4] re-run returns dedup, no error', !err && res && res.dedup === true, err ? `${err.statusCode} ${err.message}` : res);
    check('[4] no second payment', (await walletC(owner.id)) === o0 && (await poolC(ev)) === p0);
  }

  console.log('\n[5] direct path (no flow) on a REJECTED row');
  {
    const owner = await user('owner5');
    const ev = await eventWithMember(owner, 50000);
    const w = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status) VALUES ($1,$2,'FUNDRAISING',1000,$3,'REJECTED') RETURNING id`, [ev, owner.id, `R28F2B-${Date.now()}`]);
    const o0 = await walletC(owner.id); const p0 = await poolC(ev);
    let res; let err = null;
    try { res = await eventService.executeEventWithdrawal({ withdrawalId: w.id }); } catch (e) { err = e; }
    check('[5] direct path returns dedup, no error', !err && res && res.dedup === true, err ? `${err.statusCode} ${err.message}` : res);
    check('[5] nothing moved', (await walletC(owner.id)) === o0 && (await poolC(ev)) === p0 && (await wstatus(w.id)) === 'REJECTED');
  }

  console.log('\n[6] concurrency: owner cancel racing the approval (10 rounds)');
  {
    const bad = [];
    for (let i = 0; i < 10; i++) {
      const owner = await user(`owner6_${i}`);
      const ev = await eventWithMember(owner, 50000);
      const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 20000, mode: 'FUNDRAISING' });
      const o0 = await walletC(owner.id); const p0 = await poolC(ev);
      const [c, d] = await Promise.all([
        eventService.cancelEventWithdrawal(owner.id, ev, req.withdrawal.id).then(() => 'ok', (e) => `err${e.statusCode || ''}`),
        call('POST', `/api/v1/admin/approvals/${req.approvalFlowId}/decide`, B.token, { action: 'APPROVE' }).then((r) => r.status),
      ]);
      const w = await wstatus(req.withdrawal.id); const f = await fstatus(req.approvalFlowId);
      const dw = (await walletC(owner.id)) - o0; const dp = p0 - (await poolC(ev));
      const paid = w === 'PAID' && f === 'APPROVED' && c !== 'ok' && d === 200 && dw === 2000000 && dp === 2000000;
      const cancelled = w === 'REJECTED' && f === 'PENDING' && c === 'ok' && d === 409 && dw === 0 && dp === 0 && (await executedAudits(req.approvalFlowId)) === 0;
      if (!(paid || cancelled)) bad.push({ c, d, w, f, dw, dp });
    }
    check('[6] each round is either PAID-once/flow APPROVED/cancel refused or REJECTED/nothing moved/flow PENDING', bad.length === 0, bad);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
