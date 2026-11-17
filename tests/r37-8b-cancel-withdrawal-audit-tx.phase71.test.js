#!/usr/bin/env node
'use strict';
/* R37 (8b) / ND3-F1: cancelEventWithdrawal writes its audit record INSIDE the same transaction.
 *  [1] a successful cancel (every related flow REJECTED, N-D3a) leaves the withdrawal REJECTED and exactly one
 *      audit_logs row EVENT_WITHDRAWAL_CANCELLED for that withdrawal, actor = owner.
 *  [2] atomicity: when the audit INSERT fails (temporary trigger on audit_logs in this disposable DB), the cancel
 *      fails and rolls back: the withdrawal stays PENDING and no cancel audit row exists.
 *  [3] a refused cancel (flow still PENDING -> 409) writes no cancel audit row.
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
  const bound = async (tag) => {
    const owner = await user(tag);
    const ev = await eventWithMember(owner, 50000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 20000, mode: 'FUNDRAISING' });
    return { owner, ev, wid: req.withdrawal.id, flow: req.approvalFlowId, ok: req.requiresApproval && req.approvalFlowId != null };
  };
  // Offset event ids so an event id can never be mistaken for a withdrawal id in the audit checks.
  await pool.query(`SELECT setval(pg_get_serial_sequence('social_events','id'), COALESCE((SELECT MAX(id) FROM social_events),0) + 500)`);
  const rejectFlow = (flowId) => pool.query(`UPDATE approval_flows SET status = 'REJECTED' WHERE id = $1`, [flowId]);
  const cancelAudits = async (wid) => (await pool.query(
    `SELECT user_id, entity_type, entity_id::text AS entity_id FROM audit_logs WHERE action = 'EVENT_WITHDRAWAL_CANCELLED' AND entity_id::text = $1`, [String(wid)])).rows;

  console.log('\n[1] successful cancel writes exactly one audit row');
  {
    const s = await bound('a1'); check('[1] setup: bound flow; event id differs from withdrawal id', s.ok && Number(s.ev) !== Number(s.wid), { ev: s.ev, wid: s.wid });
    await rejectFlow(s.flow);
    const c = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
    const rows = await cancelAudits(s.wid);
    check('[1] cancel succeeds, withdrawal REJECTED', c.ok && (await wstatus(s.wid)) === 'REJECTED', c);
    check('[1] exactly one EVENT_WITHDRAWAL_CANCELLED audit row for this withdrawal, actor = owner', rows.length === 1 && Number(rows[0].user_id) === Number(s.owner.id), rows);
  }

  console.log('\n[2] atomicity: audit failure rolls the cancel back');
  {
    const s = await bound('a2'); check('[2] setup: bound flow', s.ok);
    await rejectFlow(s.flow);
    await pool.query(`CREATE OR REPLACE FUNCTION r37_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'EVENT_WITHDRAWAL_CANCELLED' THEN RAISE EXCEPTION 'r37 audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER r37_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION r37_audit_fail()');
    let c;
    try { c = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid)); } finally {
      await pool.query('DROP TRIGGER IF EXISTS r37_audit_fail ON audit_logs'); await pool.query('DROP FUNCTION IF EXISTS r37_audit_fail()');
    }
    check('[2] cancel fails when its audit row cannot be written', !c.ok, c);
    check('[2] withdrawal still PENDING (rolled back)', (await wstatus(s.wid)) === 'PENDING');
    check('[2] no cancel audit row', (await cancelAudits(s.wid)).length === 0);
    const again = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
    check('[2] control: once auditing works again the same cancel succeeds with one audit row', again.ok && (await wstatus(s.wid)) === 'REJECTED' && (await cancelAudits(s.wid)).length === 1, again);
  }

  console.log('\n[3] refused cancel writes no cancel audit row');
  {
    const s = await bound('a3'); check('[3] setup: bound flow', s.ok);
    const c = await attempt(eventService.cancelEventWithdrawal(s.owner.id, s.ev, s.wid));
    check('[3] flow PENDING -> 409 EVENT_WITHDRAWAL_APPROVAL_OPEN', open409(c), c);
    check('[3] no cancel audit row, withdrawal PENDING', (await cancelAudits(s.wid)).length === 0 && (await wstatus(s.wid)) === 'PENDING');
  }

  server.close();
  await pool.end();
  console.log(`\nR37 (8b) cancelEventWithdrawal audit in the same transaction: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e && e.message); try { await pool.query('DROP TRIGGER IF EXISTS r37_audit_fail ON audit_logs'); await pool.end(); } catch (x) { /* */ } process.exit(1); });
