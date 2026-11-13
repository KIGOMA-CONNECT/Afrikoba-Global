'use strict';
/* R36 shared harness: disposable r26-ci-db database only, network stubbed, Express app with the pilot
 * gates mounted exactly as server.js does (gates first, then the routers), DB snapshots. */
const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55481') {
  console.error('REFUSING: disposable r26-ci-db (127.0.0.1:55481, phase71_financial_audit_*) only'); process.exit(2);
}
process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
delete process.env.PILOT_MODE;
// R36B review #3: outside the pilot the catalog decides by NODE_ENV; the harness is always NODE_ENV=test.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
if (process.env.NODE_ENV !== 'test') { console.error(`REFUSING: NODE_ENV must be test (got ${process.env.NODE_ENV})`); process.exit(2); }
delete process.env.VICOBA_ADD_BONUS_ENABLED;
const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = { post: async () => { throw new Error('net off'); }, get: async () => { throw new Error('net off'); }, create() { return this; }, defaults: { headers: { common: {} } }, interceptors: { request: { use() {} }, response: { use() {} } } };
const express = require(path.join(ROOT, 'node_modules/express'));
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const attempt = (p) => Promise.resolve().then(() => p()).then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, code: e.code, msg: e.message }));

function buildApp(extra = []) {
  const app = express();
  app.use(express.json());
  for (const prefix of ['/api/v1', '/api']) {
    require(path.join(ROOT, 'src/config/pilot')).mountPilotGates(app, prefix);
    app.use(`${prefix}/vicoba`, require(path.join(ROOT, 'src/routes/vicobaRoutes')));
    app.use(`${prefix}/vicoba`, require(path.join(ROOT, 'src/routes/mkobaRoutes')));
    app.use(`${prefix}/wallet`, require(path.join(ROOT, 'src/routes/walletRoutes')));
    for (const [p, r] of extra) app.use(`${prefix}${p}`, r);
  }
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));
  return app;
}

let base = null; let server = null;
async function listen(app) {
  if (server) server.close();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function call(method, p, who, body, raw) {
  const headers = { 'content-type': 'application/json' };
  if (who) headers.authorization = `Bearer ${who.token}`;
  const r = await fetch(`${base}${p}`, { method, headers, body: (method === 'GET' || method === 'HEAD') ? undefined : (raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined)) });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}

let seq = 0;
async function user(label, balance = 0) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number, wallet_balance) VALUES ($1,$2,$3) RETURNING id',
    [`R36 ${label}`, `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`, balance]);
  const r = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]);
  await pool.query(`INSERT INTO user_service_subscriptions (user_id, service_key, status) VALUES ($1,'VICOBA','ACTIVE') ON CONFLICT DO NOTHING`, [r.id]);
  return { id: r.id, phone: r.phone_number, token: signToken(r) };
}
async function group(roles, balance = 500000, walletEach = 0) {
  const s = {};
  for (const [label] of roles) s[label] = await user(label, walletEach);
  s.g = (await q1(`INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ($1,$2,1000,'ACTIVE',$3) RETURNING id`,
    [`R36 g${++seq}`, s[roles[0][0]].id, balance])).id;
  for (const [label, role] of roles) await pool.query('INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1,$2,$3)', [s.g, s[label].id, role]);
  return s;
}

const SNAP_TABLES = [
  ['vicoba_groups', 'SELECT * FROM vicoba_groups'],
  ['vicoba_members', 'SELECT * FROM vicoba_members'],
  ['vicoba_bonus', 'SELECT * FROM vicoba_bonus'],
  ['vicoba_loan_requests', 'SELECT * FROM vicoba_loan_requests'],
  ['vicoba_withdrawals', 'SELECT * FROM vicoba_withdrawals'],
  ['vicoba_social_fund', 'SELECT * FROM vicoba_social_fund'],
  ['vicoba_social_fund_requests', 'SELECT * FROM vicoba_social_fund_requests'],
  ['transactions', 'SELECT * FROM transactions'],
  ['journal_entries', 'SELECT * FROM journal_entries'],
  ['wallet_ledger', 'SELECT * FROM wallet_ledger'],
  ['users', 'SELECT id, wallet_balance, phone_number FROM users'],
  ['outbox_events', 'SELECT * FROM outbox_events'],
  ['financial_operations', 'SELECT * FROM financial_operations'],
  ['recurrence_rules', 'SELECT * FROM recurrence_rules'],
  ['recurrence_executions', 'SELECT * FROM recurrence_executions'],
  ['scheduled_payments', 'SELECT * FROM scheduled_payments'],
];
async function snap() {
  const out = {};
  for (const [name, sql] of SNAP_TABLES) {
    const r = await q1(`SELECT count(*)::int n, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) h FROM (${sql}) t`);
    out[name] = `${r.n}:${r.h}`;
  }
  return out;
}
const diffSnap = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);

async function finish(title) {
  console.log(`\n${title}: ${passed} passed, ${failed} failed`);
  if (server) server.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
}
function fatal(e) { console.error('FATAL', e); pool.end().catch(() => {}).finally(() => process.exit(1)); }

module.exports = { ROOT, path, pool, check, q1, attempt, buildApp, listen, call, user, group, snap, diffSnap, finish, fatal, express };
