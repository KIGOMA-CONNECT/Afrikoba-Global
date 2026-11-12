#!/usr/bin/env node
'use strict';
/* R29 D3 (owner decision) — the event owner cannot cancel a withdrawal that has an approval flow.
 * cancelEventWithdrawal must refuse with 409 EVENT_WITHDRAWAL_APPROVAL_OPEN while a related
 * EVENT_WITHDRAWAL flow is PENDING, APPROVED or REJECTED (no auto-reject of the flow); the
 * message tells the owner to finish or reject the approval first. The flow check runs inside a
 * transaction under the withdrawal row lock. Before: cancel was an unlocked conditional UPDATE
 * that turned a PENDING row REJECTED even with a live flow (R28 F2b then had to refuse the approval).
 *  [1] flow PENDING -> 409; row PENDING, flow PENDING, nothing moves.
 *  [2] flow REJECTED by an admin -> 409; row PENDING.
 *  [3] flow APPROVED while the row is still PENDING (executor in flight) -> 409.
 *  [4] flow found by ref_id even when event_withdrawals.approval_flow_id is not set yet -> 409.
 *  [5] deterministic race: the approval has claimed the flow (APPROVED) and its executor is paused
 *      before locking the row; the owner cancels -> 409; executor resumes -> PAID once, flow
 *      APPROVED, approve 200.
 *  [6] deterministic race: executor holds the row lock (before marking PAID); cancel waits on the
 *      lock -> refused (existing 400, already processed); PAID once.
 *  [6b] same with the direct path (no flow): cancel waits on the lock -> 400; row stays PAID.
 *  [7] concurrency, 10 rounds cancel || approve: cancel never succeeds, PAID once, flow APPROVED.
 *  [8] unchanged: PENDING row with no flow -> cancelled (REJECTED, { success, withdrawal });
 *      non-owner -> 403; PAID row without flow -> 400; unknown id -> 400.
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
// Pause hook on the pg Client prototype, installed BEFORE any client exists. Matches a query
// text prefix once per arming.
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
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R29D3 ${label}`, `2559${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
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
  const ev = await q1(`INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R29D3 ev',$1,10000000,$2) RETURNING id`, [owner.id, collected]);
  await pool.query(`INSERT INTO event_members (event_id, user_id, status) VALUES ($1,$2,'ACTIVE') ON CONFLICT DO NOTHING`, [ev.id, owner.id]);
  return ev.id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, code: e.code, msg: e.message }));
const open409 = (x) => !x.ok && x.status === 409 && x.code === 'EVENT_WITHDRAWAL_APPROVAL_OPEN' && /idhini/i.test(x.msg || '');
async function pausedAt(prefix) {
  let release; const released = new Promise((x) => { release = x; });
  let paused; const isPaused = new Promise((x) => { paused = x; });
  gate.prefix = prefix; gate.released = released; gate.onPause = paused; gate.armed = true;
  return { release, waitPaused: () => Promise.race([isPaused.then(() => true), sleep(5000).then(() => false)]) };
}
const EXEC_LOCK = 'SELECT * FROM event_withdrawals WHERE id = $1 FOR UPDATE';
const EXEC_PAID = 'UPDATE event_withdrawals\n          SET status = \'PAID\'';

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  await pool.query(`INSERT INTO config_settings (key, value) VALUES ('EVENT_WITHDRAWAL_THRESHOLD','10000')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const B = await user('adminB', 'ADMIN');
  const bound = async (tag) => {
    const owner = await user(tag);
    const ev = await eventWithMember(owner, 50000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 20000, mode: 'FUNDRAISING' });
    return { owner, ev, wid: req.withdrawal.id, flow: req.approvalFlowId, ok: req.requiresApproval && req.approvalFlowId != null };
  };

  console.log('\n[1] flow PENDING');
  {
    const s = await bound('o1'); const o0 = await walletC(s.owner.id); const p0 = await poolC(s.ev);
    const c = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
    check('[1] setup: bound flow', s.ok);
    check('[1] cancel -> 409 EVENT_WITHDRAWAL_APPROVAL_OPEN (message points to the approval)', open409(c), c);
    check('[1] row PENDING, flow PENDING, nothing moved', (await wstatus(s.wid)) === 'PENDING' && (await fstatus(s.flow)) === 'PENDING' && (await walletC(s.owner.id)) === o0 && (await poolC(s.ev)) === p0);
  }

  console.log('\n[2] flow REJECTED');
  {
    const s = await bound('o2');
    const d = await call('POST', `/api/v1/admin/approvals/${s.flow}/decide`, B.token, { action: 'REJECT' });
    const c = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
    check('[2] setup: admin rejected the flow', d.status === 200 && (await fstatus(s.flow)) === 'REJECTED', d.status);
    check('[2] cancel -> 409; row stays PENDING (no auto-reject)', open409(c) && (await wstatus(s.wid)) === 'PENDING', c);
  }

  console.log('\n[3] flow APPROVED, row still PENDING');
  {
    const s = await bound('o3');
    await pool.query(`UPDATE approval_flows SET status='APPROVED', decided_at=NOW() WHERE id=$1`, [s.flow]);
    const c = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
    check('[3] cancel -> 409; row PENDING', open409(c) && (await wstatus(s.wid)) === 'PENDING', c);
  }

  console.log('\n[4] flow linked only by ref_id (approval_flow_id not yet written)');
  {
    const s = await bound('o4');
    await pool.query('UPDATE event_withdrawals SET approval_flow_id = NULL WHERE id=$1', [s.wid]);
    const c = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
    check('[4] cancel -> 409; row PENDING', open409(c) && (await wstatus(s.wid)) === 'PENDING', c);
  }

  console.log('\n[5] race: flow claimed APPROVED, executor paused before locking the row; owner cancels');
  {
    const s = await bound('o5'); const o0 = await walletC(s.owner.id); const p0 = await poolC(s.ev);
    const g = await pausedAt(EXEC_LOCK);
    let d; let c;
    try {
      const pD = call('POST', `/api/v1/admin/approvals/${s.flow}/decide`, B.token, { action: 'APPROVE' });
      const didPause = await g.waitPaused();
      check('[5] setup: executor paused with the flow APPROVED', didPause && (await fstatus(s.flow)) === 'APPROVED');
      c = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
      g.release();
      d = await pD;
    } finally { gate.armed = false; g.release(); }
    check('[5] cancel -> 409 EVENT_WITHDRAWAL_APPROVAL_OPEN', open409(c), c);
    check('[5] approve 200; row PAID; flow APPROVED; paid once', d.status === 200 && (await wstatus(s.wid)) === 'PAID' && (await fstatus(s.flow)) === 'APPROVED' && (await walletC(s.owner.id)) - o0 === 2000000 && p0 - (await poolC(s.ev)) === 2000000, { d: d.status, body: d.body, w: await wstatus(s.wid) });
  }

  console.log('\n[6] race: executor holds the row lock; cancel waits on it');
  {
    const s = await bound('o6'); const o0 = await walletC(s.owner.id);
    const g = await pausedAt(EXEC_PAID);
    let d; let c;
    try {
      const pD = call('POST', `/api/v1/admin/approvals/${s.flow}/decide`, B.token, { action: 'APPROVE' });
      const didPause = await g.waitPaused();
      check('[6] setup: executor paused holding the row lock', didPause);
      const pC = attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
      await sleep(400);
      g.release();
      [d, c] = await Promise.all([pD, pC]);
    } finally { gate.armed = false; g.release(); }
    check('[6] cancel refused with the existing 400 (already processed); approve 200; row PAID once', !c.ok && c.status === 400 && d.status === 200 && (await wstatus(s.wid)) === 'PAID' && (await walletC(s.owner.id)) - o0 === 2000000, { c, d: d.status });
  }

  console.log('\n[6b] race: direct-path executor (no flow) holds the row lock; cancel waits on it');
  {
    const owner = await user('o6b');
    const ev = await eventWithMember(owner, 50000);
    const w = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status) VALUES ($1,$2,'FUNDRAISING',1000,$3,'PENDING') RETURNING id`, [ev, owner.id, `R29D3-6B-${Date.now()}`]);
    const o0 = await walletC(owner.id);
    const g = await pausedAt(EXEC_PAID);
    let x; let c;
    try {
      const pX = attempt(eventService.executeEventWithdrawal({ withdrawalId: w.id }));
      const didPause = await g.waitPaused();
      check('[6b] setup: direct executor paused holding the row lock', didPause);
      const pC = attempt(eventService.cancelEventWithdrawal(owner.id, ev, w.id));
      await sleep(400);
      g.release();
      [x, c] = await Promise.all([pX, pC]);
    } finally { gate.armed = false; g.release(); }
    check('[6b] executor pays; cancel gets the existing 400; row stays PAID (never REJECTED after payment)', x.ok && !c.ok && c.status === 400 && (await wstatus(w.id)) === 'PAID' && (await walletC(owner.id)) - o0 === 100000, { x, c, w: await wstatus(w.id) });
  }

  console.log('\n[7] concurrency: cancel || approve, 10 rounds');
  {
    const bad = [];
    for (let i = 0; i < 10; i++) {
      const s = await bound(`o7_${i}`); const o0 = await walletC(s.owner.id); const p0 = await poolC(s.ev);
      const [c, d] = await Promise.all([
        attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid)),
        call('POST', `/api/v1/admin/approvals/${s.flow}/decide`, B.token, { action: 'APPROVE' }),
      ]);
      const w = await wstatus(s.wid); const f = await fstatus(s.flow);
      const dw = (await walletC(s.owner.id)) - o0; const dp = p0 - (await poolC(s.ev));
      if (!(!c.ok && d.status === 200 && w === 'PAID' && f === 'APPROVED' && dw === 2000000 && dp === 2000000)) bad.push({ c: c.ok ? 'ok' : c.status, d: d.status, w, f, dw, dp });
    }
    check('[7] every round: cancel refused, approve 200, PAID once, flow APPROVED', bad.length === 0, bad);
  }

  console.log('\n[8] unchanged behaviour (no flow)');
  {
    const owner = await user('o8'); const other = await user('o8x');
    const ev = await eventWithMember(owner, 50000);
    const mk = async (status) => (await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status) VALUES ($1,$2,'FUNDRAISING',1000,$3,$4) RETURNING id`, [ev, owner.id, `R29D3-${status}-${Date.now()}-${++seq}`, status])).id;
    const w1 = await mk('PENDING');
    const n = await attempt(eventService.cancelEventWithdrawal(other.id, ev, w1));
    check('[8] non-owner -> 403', !n.ok && n.status === 403, n);
    const a = await attempt(eventService.cancelEventWithdrawal(owner.id, ev, w1));
    check('[8] PENDING without flow -> { success, withdrawal } and REJECTED', a.ok && a.r.success === true && a.r.withdrawal && a.r.withdrawal.id === w1 && a.r.withdrawal.status === 'REJECTED' && (await wstatus(w1)) === 'REJECTED', a);
    const w2 = await mk('PAID');
    const b = await attempt(eventService.cancelEventWithdrawal(owner.id, ev, w2));
    check('[8] PAID without flow -> existing 400; stays PAID', !b.ok && b.status === 400 && (await wstatus(w2)) === 'PAID', b);
    const u = await attempt(eventService.cancelEventWithdrawal(owner.id, ev, 987654321));
    check('[8] unknown withdrawal -> 400', !u.ok && u.status === 400, u);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
