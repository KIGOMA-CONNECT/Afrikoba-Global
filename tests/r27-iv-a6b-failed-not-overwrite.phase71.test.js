#!/usr/bin/env node
'use strict';
/* R27 IV-A-6 (sweep, principle c) — executeEventWithdrawal's failure path must not
 * overwrite a withdrawal another transaction already PAID.
 *
 *  [1] tx1 locks the row and marks it PAID, holding the lock ~4.5s. A concurrent
 *      executeEventWithdrawal waits, hits lock_timeout (3s), and its catch block
 *      writes FAILED. tx1 then commits. The row must stay PAID (HEAD: FAILED).
 *  [2] a genuine failure after the claim (event pool too small) still marks the
 *      row FAILED and moves nothing (existing behaviour preserved).
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
const eventService = require(path.join(ROOT, 'src/services/eventService'));

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
async function user(label) {
  seq++;
  return q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R27A6B ${label}`, `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`]);
}
async function setup(collected, amount) {
  const owner = await user('owner');
  const ev = await q1(`INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R27A6B ev',$1,1000000,$2) RETURNING id`, [owner.id, collected]);
  const ref = `R27A6B-${Date.now()}-${seq}`;
  const w = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status) VALUES ($1,$2,'FUNDRAISING',$3,$4,'PENDING') RETURNING id`, [ev.id, owner.id, amount, ref]);
  return { owner, ev: ev.id, wid: w.id, ref, amount };
}
const wallet = async (id) => Number((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance);
const status = async (id) => (await q1('SELECT status FROM event_withdrawals WHERE id=$1', [id])).status;

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] lock-timeout failure while another tx pays the row');
  {
    const s = await setup(40000, 2000);
    const tx1 = await pool.connect();
    let execErr = null;
    try {
      await tx1.query('BEGIN');
      await tx1.query('SELECT id FROM event_withdrawals WHERE id=$1 FOR UPDATE', [s.wid]);
      await tx1.query(`UPDATE event_withdrawals SET status='PAID', paid_at=NOW() WHERE id=$1`, [s.wid]);
      const exec = eventService.executeEventWithdrawal({ eventId: s.ev, withdrawalId: s.wid, mode: 'FUNDRAISING', amount: s.amount, userId: s.owner.id, reference: s.ref })
        .then(() => null, (e) => { execErr = e; return e; });
      await sleep(4500); // past exec's 3s lock_timeout, before its FAILED write times out
      await tx1.query('COMMIT');
      await exec;
    } finally { tx1.release(); }
    check('concurrent attempt failed (lock timeout)', execErr && /lock/i.test(String(execErr.message)), execErr && execErr.message);
    check('row PAID by tx1 stays PAID (not overwritten to FAILED)', (await status(s.wid)) === 'PAID', await status(s.wid));
    check('no money moved by the failed attempt', (await wallet(s.owner.id)) === 0, await wallet(s.owner.id));
  }

  console.log('\n[2] genuine failure after the claim still marks FAILED');
  {
    const s = await setup(1000, 5000); // pool smaller than the withdrawal
    const e = await eventService.executeEventWithdrawal({ eventId: s.ev, withdrawalId: s.wid, mode: 'FUNDRAISING', amount: s.amount, userId: s.owner.id, reference: s.ref }).then(() => null, (x) => x);
    check('execution rejected', !!e, e && e.message);
    check('row FAILED', (await status(s.wid)) === 'FAILED', await status(s.wid));
    check('owner +0, pool unchanged', (await wallet(s.owner.id)) === 0 && Number((await q1('SELECT collected_amount FROM social_events WHERE id=$1', [s.ev])).collected_amount) === 1000);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.stack); try { await pool.end(); } catch (x) { /* */ } process.exit(3); });
