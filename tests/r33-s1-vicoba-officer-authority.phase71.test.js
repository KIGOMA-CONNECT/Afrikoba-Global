#!/usr/bin/env node
'use strict';
/* R33 S1 (G-0b / G-0c) — VICOBA profits/calculate and constitution need a valid officer of THAT
 * group. Group role comes from vicoba_members for req.user (MWENYEKITI, MWEKAHAZINA, KATIBU);
 * never from the body, never from the platform ADMIN role; a VICOBA subscription alone is not
 * enough. Before: any user with a VICOBA subscription (even a non-member) could create a profit
 * distribution with any totalProfit (which also bumped total_profit_earned / total_profit_pool)
 * and could upsert any group's constitution (share_price, max shares, ...).
 *  [1] positive: MWENYEKITI, MWEKAHAZINA, KATIBU each set the constitution (201) and calculate (201).
 *  [2] negative, both endpoints: plain member (MJUMBE), officer of ANOTHER group, platform ADMIN who
 *      is not an officer, subscription-only user -> 403 with the message. Body actor fields ignored.
 *      Every refusal: no DB change — row counts and row hashes of vicoba_groups,
 *      vicoba_profit_distributions, vicoba_profit_payouts, vicoba_group_constitutions,
 *      vicoba_members, users (wallets), transactions and journal_entries are identical.
 *  [3] concurrency: an officer's calculate holds the member row FOR SHARE; a concurrent demotion of
 *      that officer waits until the calculate commits; after the demotion, calculate -> 403.
 *      Two parallel non-officer calculates -> both 403, no change.
 *  [4] static: the officer check is after BEGIN and before any INSERT/UPDATE in calculate, and
 *      before the INSERT in createConstitution.
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
const mkoba = require(path.join(ROOT, 'src/services/mkobaService'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

const app = express();
app.use(express.json());
app.use('/api/v1/vicoba', require(path.join(ROOT, 'src/routes/vicobaRoutes')));
app.use('/api/v1/vicoba', require(path.join(ROOT, 'src/routes/mkobaRoutes')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));

const MSG_CONST = 'Viongozi wa kikundi pekee wanaweza kuweka katiba ya kikundi.';
const MSG_PROFIT = 'Viongozi wa kikundi pekee wanaweza kukokotoa mgawanyo wa faida.';
let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, code: e.code, msg: e.message }));
let seq = 0;
async function user(label, { role, subscribe = true } = {}) {
  seq++;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R33S1 ${label}`, `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
  if (role) await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, u.id]);
  if (subscribe) await pool.query(`INSERT INTO user_service_subscriptions (user_id, service_key, status) VALUES ($1,'VICOBA','ACTIVE') ON CONFLICT DO NOTHING`, [u.id]);
  const r = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]);
  return { id: r.id, token: signToken(r) };
}
let base;
async function call(method, p, token, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}
async function group(label) {
  const chair = await user(`${label} chair`); const treasurer = await user(`${label} treasurer`); const secretary = await user(`${label} secretary`); const member = await user(`${label} member`);
  const g = await q1(`INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ($1,$2,1000,'ACTIVE',500000) RETURNING id`, [`R33S1 ${label} ${++seq}`, chair.id]);
  for (const [u, role, shares] of [[chair, 'MWENYEKITI', 5], [treasurer, 'MWEKAHAZINA', 3], [secretary, 'KATIBU', 2], [member, 'MJUMBE', 10]]) {
    await pool.query('INSERT INTO vicoba_members (group_id, user_id, role_in_group, total_shares) VALUES ($1,$2,$3,$4)', [g.id, u.id, role, shares]);
  }
  return { g: g.id, chair, treasurer, secretary, member };
}
const TABLES = ['vicoba_groups', 'vicoba_profit_distributions', 'vicoba_profit_payouts', 'vicoba_group_constitutions', 'vicoba_members', 'users', 'transactions', 'journal_entries'];
async function snapshot() {
  const out = {};
  for (const t of TABLES) {
    const r = await q1(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x.id)), '') AS h FROM ${t} x`);
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}
const sameSnap = (a, b) => TABLES.every((t) => a[t] === b[t]);
const diffSnap = (a, b) => TABLES.filter((t) => a[t] !== b[t]);
const CONST_BODY = { sharePrice: 5000, maxSharesPerMember: 40, loanInterestRate: 12 };
const constOf = (s, by, body = CONST_BODY) => call('POST', `/api/v1/vicoba/groups/${s.g}/constitution`, by.token, body);
const calcOf = (s, by, body = {}) => call('POST', `/api/v1/vicoba/groups/${s.g}/profits/calculate`, by.token, { cycleNumber: 1, totalProfit: 20000, ...body });
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

  console.log('\n[1] positive: each officer role');
  {
    const s = await group('A');
    const c1 = await constOf(s, s.chair);
    const c2 = await constOf(s, s.treasurer, { ...CONST_BODY, sharePrice: 6000 });
    const c3 = await constOf(s, s.secretary, { ...CONST_BODY, sharePrice: 7000 });
    const row = await q1('SELECT share_price FROM vicoba_group_constitutions WHERE group_id=$1', [s.g]);
    check('[1a] MWENYEKITI / MWEKAHAZINA / KATIBU set the constitution -> 201 each; last write stored', c1.status === 201 && c2.status === 201 && c3.status === 201 && Number(row.share_price) === 7000, { c1: c1.status, c2: c2.status, c3: c3.status, row });
    const p1 = await calcOf(s, s.chair, { cycleNumber: 1 });
    const p2 = await calcOf(s, s.treasurer, { cycleNumber: 2 });
    const p3 = await calcOf(s, s.secretary, { cycleNumber: 3 });
    const n = Number((await q1('SELECT count(*) n FROM vicoba_profit_distributions WHERE group_id=$1', [s.g])).n);
    const pays = Number((await q1('SELECT count(*) n FROM vicoba_profit_payouts pp JOIN vicoba_profit_distributions pd ON pd.id=pp.distribution_id WHERE pd.group_id=$1', [s.g])).n);
    check('[1b] each officer calculates -> 201; 3 distributions with 4 payouts each', p1.status === 201 && p2.status === 201 && p3.status === 201 && n === 3 && pays === 12, { p1: p1.status, p2: p2.status, p3: p3.status, n, pays, b: p1.body });
  }

  console.log('\n[2] negative: non-officers -> 403, no DB change');
  {
    const s = await group('B');
    const other = await group('C');
    const admin = await user('platform admin', { role: 'ADMIN', subscribe: false });
    const subOnly = await user('subscription only');
    await constOf(s, s.chair); // existing constitution, so an upsert would be visible
    const actors = [['MJUMBE of the group', s.member], ['MWENYEKITI of another group', other.chair], ['platform ADMIN (not an officer)', admin], ['subscription-only user', subOnly]];
    for (const [label, a] of actors) {
      const before = await snapshot();
      const rc = await constOf(s, a, { ...CONST_BODY, sharePrice: 1, actorId: s.chair.id, userId: s.chair.id });
      const rp = await calcOf(s, a, { totalProfit: 999999, actorId: s.chair.id, userId: s.chair.id });
      const after = await snapshot();
      check(`[2] ${label}: constitution -> 403 with the message`, rc.status === 403 && rc.body && rc.body.message === MSG_CONST, rc);
      check(`[2] ${label}: profits/calculate -> 403 with the message`, rp.status === 403 && rp.body && rp.body.message === MSG_PROFIT, rp);
      check(`[2] ${label}: no DB mutation (counts + row hashes of ${TABLES.length} tables)`, sameSnap(before, after), diffSnap(before, after));
    }
    const a1 = await attempt(mkoba.calculateProfitDistribution(s.g, 9, 1000, s.member.id));
    const a2 = await attempt(mkoba.createConstitution(s.g, CONST_BODY, s.member.id));
    const a3 = await attempt(mkoba.calculateProfitDistribution(s.g, 9, 1000));
    const a4 = await attempt(mkoba.createConstitution(s.g, CONST_BODY));
    check('[2] service level: member -> 403; missing actor -> 403 (fails closed)', [a1, a2, a3, a4].every((a) => !a.ok && a.status === 403), { a1, a2, a3, a4 });
  }

  console.log('\n[3] concurrency');
  {
    const s = await group('D');
    const g = await pausedAt('INSERT INTO vicoba_profit_distributions');
    let calc; let demoteSettledEarly = null;
    try {
      const pC = attempt(mkoba.calculateProfitDistribution(s.g, 1, 20000, s.treasurer.id));
      const didPause = await g.waitPaused();
      check('[3a] setup: officer calculate paused after its role check (inside the transaction)', didPause);
      let settled = false;
      const pD = pool.query(`UPDATE vicoba_members SET role_in_group='MJUMBE' WHERE group_id=$1 AND user_id=$2`, [s.g, s.treasurer.id]).then(() => { settled = true; });
      await sleep(300); demoteSettledEarly = settled;
      g.release();
      calc = await pC; await pD;
    } finally { gate.armed = false; g.release(); }
    check('[3a] demotion waited for the calculate (member row held FOR SHARE)', demoteSettledEarly === false, demoteSettledEarly);
    check('[3a] the in-flight calculate committed', calc.ok, calc);
    const after = await attempt(mkoba.calculateProfitDistribution(s.g, 2, 20000, s.treasurer.id));
    check('[3a] after the demotion: calculate -> 403', !after.ok && after.status === 403 && after.msg === MSG_PROFIT, after);
    const before = await snapshot();
    const [x, y] = await Promise.all([calcOf(s, s.member), calcOf(s, s.member)]);
    const snap2 = await snapshot();
    check('[3b] two parallel non-officer calculates -> both 403; no DB change', x.status === 403 && y.status === 403 && sameSnap(before, snap2), { x: x.status, y: y.status, diff: diffSnap(before, snap2) });
  }

  console.log('\n[4] static ordering');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/services/mkobaService.js'), 'utf8');
    const body = (name) => { const s = src.indexOf(`async function ${name}(`); return src.slice(s, src.indexOf('\nasync function ', s + 10)); };
    const calc = body('calculateProfitDistribution');
    const iB = calc.indexOf("client.query('BEGIN')"); const iChk = calc.indexOf(MSG_PROFIT); const iW = calc.search(/INSERT INTO|UPDATE\s+[a-z_]+\s+SET/);
    check('[4a] calculate: check after BEGIN, before any INSERT/UPDATE', iB > 0 && iChk > iB && iW > iChk, { iB, iChk, iW });
    const cons = body('createConstitution');
    const iC = cons.indexOf(MSG_CONST); const iI = cons.indexOf('INSERT INTO vicoba_group_constitutions');
    check('[4b] createConstitution: check before the INSERT', iC > 0 && iI > iC, { iC, iI });
  }

  console.log(`\nR33 S1: ${passed} passed, ${failed} failed`);
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
