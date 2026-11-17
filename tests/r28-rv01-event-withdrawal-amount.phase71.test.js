#!/usr/bin/env node
'use strict';
/* R28 R27RV-01 — event withdrawal amounts are validated and rounded to NUMERIC(18,2) before the
 * event_withdrawals INSERT, so the row, the approval flow data, the wallet credit, the event pool
 * debit and the journal all carry the same 2-decimal amount.
 *  [1] direct 1000.005 -> 200, row PAID 1000.01, owner +1000.01, pool -1000.01, journal 1000.01,
 *      nothing left PENDING (R27 worktree: 409 + PENDING row reserving funds; HEAD: wallet +1000.01
 *      but pool -1000.00).
 *  [2] direct 1000.004 -> PAID 1000.00 everywhere.
 *  [3] direct string '2500.5' -> PAID 2500.50 (unchanged path).
 *  [3b] direct 1.005 -> PAID 1.01 (decimal rounding, not binary-float rounding).
 *  [3c] direct 4.015 -> PAID 4.02 (the +EPSILON rounding used elsewhere gives 4.01).
 *  [4] 0.004 rounds to 0.00 -> 400, no row written (previously a raw CHECK violation, 500).
 *  [5] above threshold 20000.005 -> flow data.amount == row.amount == 20000.01; 4 parallel
 *      approvals pay 20000.01 exactly once; pool -20000.01; journal balanced.
 *  [6] R27 mutant gap: an EVENT_WITHDRAWAL flow whose data.withdrawalId differs from its ref_id is
 *      refused (409) and neither withdrawal moves (kills a6_payload_id and a6_no_ref_claim_check).
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
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R28RV01 ${label}`, `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
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
const rowsOf = async (ev) => (await pool.query('SELECT id, status, amount::text AS amount, reference_id FROM event_withdrawals WHERE event_id=$1 ORDER BY id', [ev])).rows;
async function journalC(reference) {
  const r = await q1(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0) dr, COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0) cr, COUNT(*)::int n
                        FROM journal_entries WHERE reference_id=$1`, [reference]);
  return { dr: cents(r.dr), cr: cents(r.cr), n: r.n };
}
async function eventWithMember(owner, collected) {
  const ev = await q1(`INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R28RV01 ev',$1,10000000,$2) RETURNING id`, [owner.id, collected]);
  await pool.query(`INSERT INTO event_members (event_id, user_id, status) VALUES ($1,$2,'ACTIVE') ON CONFLICT DO NOTHING`, [ev.id, owner.id]);
  return ev.id;
}

async function direct(label, amount, expectC) {
  const owner = await user(label);
  const ev = await eventWithMember(owner, 5000);
  const w0 = await walletC(owner.id); const p0 = await poolC(ev);
  let res; let err = null;
  try { res = await eventService.requestEventWithdrawal(owner.id, ev, { amount, mode: 'FUNDRAISING' }); } catch (e) { err = e; }
  const rows = await rowsOf(ev);
  const row = rows[0] || {};
  const j = row.reference_id ? await journalC(row.reference_id) : { dr: 0, cr: 0, n: 0 };
  const dw = (await walletC(owner.id)) - w0; const dp = p0 - (await poolC(ev));
  const det = { err: err && `${err.statusCode} ${err.code || ''} ${err.message}`, rows, dw, dp, j };
  check(`${label}: ${JSON.stringify(amount)} settles directly (no error, no approval)`, !err && res && !res.requiresApproval, det);
  check(`${label}: row PAID with amount ${(expectC / 100).toFixed(2)}`, rows.length === 1 && row.status === 'PAID' && cents(row.amount) === expectC, det);
  check(`${label}: owner +${(expectC / 100).toFixed(2)} and pool -${(expectC / 100).toFixed(2)} (same cents)`, dw === expectC && dp === expectC, det);
  check(`${label}: journal balanced at ${(expectC / 100).toFixed(2)}`, j.n > 0 && j.dr === expectC && j.cr === expectC, det);
  check(`${label}: nothing left PENDING/APPROVED reserving the pool`, rows.every((r) => !['PENDING', 'APPROVED'].includes(r.status)), det);
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

  console.log('\n[1] direct 1000.005');
  await direct('[1]', 1000.005, 100001);
  console.log('\n[2] direct 1000.004');
  await direct('[2]', 1000.004, 100000);
  console.log('\n[3] direct string 2500.5');
  await direct('[3]', '2500.5', 250050);
  console.log('\n[3b] direct 1.005 (binary float 100.4999…, Postgres rounds the text to 1.01)');
  await direct('[3b]', 1.005, 101);
  console.log('\n[3c] direct 4.015 (Math.round((x + EPSILON) * 100) gives 4.01; Postgres gives 4.02)');
  await direct('[3c]', 4.015, 402);

  console.log('\n[4] 0.004 rounds to zero');
  {
    const owner = await user('owner4');
    const ev = await eventWithMember(owner, 5000);
    let err = null;
    try { await eventService.requestEventWithdrawal(owner.id, ev, { amount: 0.004, mode: 'FUNDRAISING' }); } catch (e) { err = e; }
    check('[4] refused with 400 (not a raw DB error)', err && err.statusCode === 400, err && { status: err.statusCode, code: err.code, msg: err.message });
    check('[4] no withdrawal row written', (await rowsOf(ev)).length === 0, await rowsOf(ev));
  }

  console.log('\n[5] above threshold 20000.005, 4 parallel approvals');
  {
    const owner = await user('owner5');
    const ev = await eventWithMember(owner, 50000);
    const req = await eventService.requestEventWithdrawal(owner.id, ev, { amount: 20000.005, mode: 'FUNDRAISING' });
    const flow = await q1('SELECT data FROM approval_flows WHERE id=$1', [req.approvalFlowId]);
    const row = (await rowsOf(ev))[0];
    check('[5] approval required; flow data.amount == row.amount == 20000.01', req.requiresApproval && String(flow.data.amount) === '20000.01' && row.amount === '20000.01', { data: flow.data, row });
    const w0 = await walletC(owner.id); const p0 = await poolC(ev);
    const ds = await Promise.all([0, 1, 2, 3].map(() => call('POST', `/api/v1/admin/approvals/${req.approvalFlowId}/decide`, B.token, { action: 'APPROVE' })));
    const ok = ds.filter((d) => d.status === 200).length;
    const dw = (await walletC(owner.id)) - w0; const dp = p0 - (await poolC(ev));
    const j = await journalC(row.reference_id);
    check('[5] exactly one approval executes', ok === 1, ds.map((d) => d.status));
    check('[5] owner +20000.01 once, pool -20000.01 once', dw === 2000001 && dp === 2000001, { dw, dp });
    check('[5] row PAID, journal balanced at 20000.01', (await rowsOf(ev))[0].status === 'PAID' && j.dr === 2000001 && j.cr === 2000001, { row: (await rowsOf(ev))[0], j });
  }

  console.log('\n[6] flow whose data.withdrawalId differs from its ref_id');
  {
    const owner = await user('owner6');
    const ev = await eventWithMember(owner, 40000);
    const t = Date.now();
    const w1 = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status) VALUES ($1,$2,'FUNDRAISING',1000,$3,'PENDING') RETURNING id`, [ev, owner.id, `R28RV01-W1-${t}`]);
    const w2 = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status) VALUES ($1,$2,'FUNDRAISING',2000,$3,'PENDING') RETURNING id`, [ev, owner.id, `R28RV01-W2-${t}`]);
    const o0 = await walletC(owner.id); const p0 = await poolC(ev);
    const cr = await call('POST', '/api/v1/admin/approvals', A.token, { actionType: 'EVENT_WITHDRAWAL', refType: 'EVENT_WITHDRAWAL', refId: w1.id, data: { withdrawalId: w2.id } });
    const d = cr.status === 200 ? await call('POST', `/api/v1/admin/approvals/${cr.body.flow.id}/decide`, B.token, { action: 'APPROVE' }) : { status: cr.status };
    const rows = await rowsOf(ev);
    check('[6] refused with 409', d.status === 409, { create: cr.status, decide: d.status, body: d.body });
    check('[6] neither withdrawal moved (owner +0, pool unchanged, both PENDING)', (await walletC(owner.id)) === o0 && (await poolC(ev)) === p0 && rows.every((r) => r.status === 'PENDING'), rows);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
