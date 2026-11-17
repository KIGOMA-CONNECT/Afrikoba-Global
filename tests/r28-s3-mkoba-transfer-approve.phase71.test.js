#!/usr/bin/env node
'use strict';
/* R28 S3 — mkobaService.approveTransfer must claim the VERIFIED transfer under a row lock.
 * Before: the transfer was read without FOR UPDATE and COMPLETED/REJECTED were written
 * unconditionally, so a second approval that read VERIFIED before the first committed debited the
 * group again after waiting for the group lock (EXTERNAL path: raw UPDATE + postJournal, no
 * idempotency -> group fund debited twice).
 *  [1] EXTERNAL: second approval paused-free race made deterministic (first approval paused at the
 *      group lock while the second starts): group debited once, one journal posting, COMPLETED,
 *      the loser gets the existing 400.
 *  [2] EXTERNAL: 4 parallel approvals -> exactly one success, group debited once.
 *  [3] MEMBER: 4 parallel approvals -> recipient credited once, exactly one TRANSFER transaction row.
 *  [4] approve racing reject (10 rounds): COMPLETED with one debit, or REJECTED with none.
 *  [5] unchanged: single approval works; non-chair 403; INITIATED (not verified) 400; reject works.
 * Requires a DISPOSABLE database phase71_financial_audit_<suffix> on 127.0.0.1:55481.
 */
const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55481') {
  console.error('REFUSING: disposable r26-ci-db (127.0.0.1:55481, phase71_financial_audit_*) only'); process.exit(2);
}
const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = { post: async () => { throw new Error('net off'); }, get: async () => { throw new Error('net off'); }, create() { return this; }, defaults: { headers: { common: {} } }, interceptors: { request: { use() {} }, response: { use() {} } } };
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
// Pause hook installed on the pg Client prototype BEFORE any client exists (db.js binds
// client.query per instance on first checkout).
const pgMod = require(path.join(ROOT, 'node_modules/pg'));
const gate = { armed: false, prefix: null, released: null, onPause: null };
{
  const origProtoQuery = pgMod.Client.prototype.query;
  pgMod.Client.prototype.query = function gated(sql, ...rest) {
    const text = typeof sql === 'string' ? sql : (sql && sql.text);
    if (gate.armed && typeof text === 'string' && text.startsWith(gate.prefix)) {
      gate.armed = false; gate.onPause();
      return gate.released.then(() => origProtoQuery.call(this, sql, ...rest));
    }
    return origProtoQuery.call(this, sql, ...rest);
  };
}
const mkoba = require(path.join(ROOT, 'src/services/mkobaService'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const cents = (v) => Math.round(Number(v) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.statusCode, msg: e.message }));
let seq = 0;
async function user(label) {
  seq++;
  return q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id, phone_number', [`R28S3 ${label}`, `2554${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
}
async function group(balance) {
  const g = await q1(`INSERT INTO vicoba_groups (group_name, share_value, group_wallet_balance) VALUES ($1, 1000, $2) RETURNING id`, [`R28S3 g${++seq}`, balance]);
  const chair = await user('chair'); const treas = await user('treasurer'); const member = await user('member');
  for (const [u, role] of [[chair, 'MWENYEKITI'], [treas, 'MWEKAHAZINA'], [member, 'MWANACHAMA']]) {
    await pool.query('INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1,$2,$3)', [g.id, u.id, role]);
  }
  return { id: g.id, chair, treas, member };
}
async function verifiedTransfer(g, amount, toMember) {
  const t = await mkoba.initiateTransfer(g.chair.id, g.id, { recipientUserId: toMember ? g.member.id : null, recipientPhone: toMember ? null : '255700000001', amount });
  await mkoba.verifyTransfer(g.treas.id, t.transfer.id, { approved: true });
  return t.transfer;
}
const groupC = async (id) => cents((await q1('SELECT group_wallet_balance FROM vicoba_groups WHERE id=$1', [id])).group_wallet_balance);
const tstatus = async (id) => (await q1('SELECT status FROM vicoba_fund_transfers WHERE id=$1', [id])).status;
const journalDrC = async (ref) => cents((await q1(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0) dr FROM journal_entries WHERE reference_id=$1`, [ref])).dr);
const walletC = async (id) => cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const txRows = async (transferId) => Number((await q1(`SELECT COUNT(*)::int n FROM transactions WHERE type='TRANSFER' AND meta->>'transfer_id' = $1`, [String(transferId)])).n);

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] EXTERNAL: deterministic second approval while the first is paused at the group lock');
  {
    const g = await group(100000);
    const t = await verifiedTransfer(g, 30000, false);
    const g0 = await groupC(g.id);
    let release; const released = new Promise((r) => { release = r; });
    let paused; const isPaused = new Promise((r) => { paused = r; });
    gate.prefix = 'SELECT group_wallet_balance FROM vicoba_groups WHERE id = $1 FOR UPDATE';
    gate.released = released; gate.onPause = paused; gate.armed = true;
    let a1; let a2;
    try {
      const p1 = attempt(mkoba.approveTransfer(g.chair.id, t.id, { approved: true }));
      const didPause = await Promise.race([isPaused.then(() => true), sleep(3000).then(() => false)]);
      check('[1] setup: first approval paused at the group lock', didPause);
      const p2 = attempt(mkoba.approveTransfer(g.chair.id, t.id, { approved: true }));
      await sleep(500);
      release();
      [a1, a2] = await Promise.all([p1, p2]);
    } finally { gate.armed = false; release(); }
    const okN = [a1, a2].filter((x) => x.ok).length;
    check('[1] exactly one approval succeeds; the other gets 400', okN === 1 && [a1, a2].some((x) => !x.ok && x.status === 400), [a1, a2]);
    check('[1] the first approval (holding the transfer row lock) is the one that succeeds; the second waited behind it', a1.ok && !a2.ok, { a1: a1.ok || a1.status, a2: a2.ok || a2.status });
    check('[1] group debited 30000 once', g0 - (await groupC(g.id)) === 3000000, { debited: (g0 - (await groupC(g.id))) / 100 });
    check('[1] one journal posting of 30000, status COMPLETED', (await journalDrC(`${t.reference_id}:GW`)) === 3000000 && (await tstatus(t.id)) === 'COMPLETED', { dr: (await journalDrC(`${t.reference_id}:GW`)) / 100, st: await tstatus(t.id) });
  }

  console.log('\n[2] EXTERNAL: 4 parallel approvals');
  {
    const g = await group(100000);
    const t = await verifiedTransfer(g, 20000, false);
    const g0 = await groupC(g.id);
    const rs = await Promise.all([0, 1, 2, 3].map(() => attempt(mkoba.approveTransfer(g.chair.id, t.id, { approved: true }))));
    check('[2] exactly one success', rs.filter((x) => x.ok).length === 1, rs.map((x) => x.ok || x.status));
    check('[2] group debited 20000 once, journal 20000 once', g0 - (await groupC(g.id)) === 2000000 && (await journalDrC(`${t.reference_id}:GW`)) === 2000000, { debited: (g0 - (await groupC(g.id))) / 100, dr: (await journalDrC(`${t.reference_id}:GW`)) / 100 });
  }

  console.log('\n[3] MEMBER: 4 parallel approvals');
  {
    const g = await group(100000);
    const t = await verifiedTransfer(g, 15000, true);
    const g0 = await groupC(g.id); const m0 = await walletC(g.member.id);
    const rs = await Promise.all([0, 1, 2, 3].map(() => attempt(mkoba.approveTransfer(g.chair.id, t.id, { approved: true }))));
    check('[3] exactly one success', rs.filter((x) => x.ok).length === 1, rs.map((x) => x.ok || x.status));
    check('[3] member +15000 once, group -15000 once', (await walletC(g.member.id)) - m0 === 1500000 && g0 - (await groupC(g.id)) === 1500000, { m: ((await walletC(g.member.id)) - m0) / 100, g: (g0 - (await groupC(g.id))) / 100 });
    check('[3] exactly one TRANSFER transaction row', (await txRows(t.id)) === 1, await txRows(t.id));
  }

  console.log('\n[4] approve racing reject (10 rounds)');
  {
    const bad = [];
    for (let i = 0; i < 10; i++) {
      const g = await group(100000);
      const t = await verifiedTransfer(g, 10000, false);
      const g0 = await groupC(g.id);
      const [ap, rj] = await Promise.all([attempt(mkoba.approveTransfer(g.chair.id, t.id, { approved: true })), attempt(mkoba.approveTransfer(g.chair.id, t.id, { approved: false }))]);
      const st = await tstatus(t.id); const deb = g0 - (await groupC(g.id)); const dr = await journalDrC(`${t.reference_id}:GW`);
      const completed = st === 'COMPLETED' && deb === 1000000 && dr === 1000000 && ap.ok && !rj.ok;
      const rejected = st === 'REJECTED' && deb === 0 && dr === 0 && rj.ok && !ap.ok;
      if (!(completed || rejected)) bad.push({ ap: ap.ok || ap.status, rj: rj.ok || rj.status, st, deb: deb / 100, dr: dr / 100 });
    }
    check('[4] every round COMPLETED+debited once or REJECTED+nothing debited, exactly one call succeeds', bad.length === 0, bad);
  }

  console.log('\n[5] sequential paths unchanged');
  {
    const g = await group(100000);
    const t = await verifiedTransfer(g, 5000, false);
    const notChair = await attempt(mkoba.approveTransfer(g.treas.id, t.id, { approved: true }));
    check('[5] non-chair refused 403', !notChair.ok && notChair.status === 403, notChair);
    const ok = await attempt(mkoba.approveTransfer(g.chair.id, t.id, { approved: true }));
    check('[5] chair approval succeeds, COMPLETED, response shape kept', ok.ok && ok.r.success === true && ok.r.referenceId === t.reference_id && (await tstatus(t.id)) === 'COMPLETED', ok);
    const t2 = (await mkoba.initiateTransfer(g.chair.id, g.id, { recipientPhone: '255700000002', amount: 1000 })).transfer;
    const notVerified = await attempt(mkoba.approveTransfer(g.chair.id, t2.id, { approved: true }));
    check('[5] INITIATED (not verified) refused 400', !notVerified.ok && notVerified.status === 400, notVerified);
    const t3 = await verifiedTransfer(g, 1000, false);
    const rej = await attempt(mkoba.approveTransfer(g.chair.id, t3.id, { approved: false }));
    check('[5] reject succeeds, REJECTED, nothing debited', rej.ok && (await tstatus(t3.id)) === 'REJECTED' && (await journalDrC(`${t3.reference_id}:GW`)) === 0, rej);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
