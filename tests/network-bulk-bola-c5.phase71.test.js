#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R26-C5: BOLA on POST /network/bulk/:id/process
 *
 *  OWASP API1 (BOLA) / ASVS V4.2.1. Only the owner of a bulk payment batch may
 *  process it. The ownership check runs inside the processing transaction on
 *  the batch row locked FOR UPDATE, before any effect. A refused request gets
 *  the same 404 'Batch hajapatikana.' as getBulkBatch (no existence leak) and
 *  is written to audit_logs (BULK_BATCH_PROCESS_DENIED).
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix> on
 * 127.0.0.1:55471. axios is stubbed: no real network.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55471') {
  console.error('REFUSING: DB_HOST/DB_PORT must be the disposable p71-ci-db (127.0.0.1:55471).');
  process.exit(2);
}

const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = {
  post: async () => { throw new Error('network disabled in test'); },
  get: async () => { throw new Error('network disabled in test'); },
};
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const network = require(path.join(ROOT, 'src/services/networkService'));

let passed = 0; let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
async function section(fn) {
  try { await fn(); } catch (e) { failed++; console.log(`  ✗ section aborted — ${e.message}`); }
}
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const num = async (sql, p) => Number(Object.values(await q1(sql, p))[0]);
let seq = 0;
async function user(label) {
  seq++;
  const phone = `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`C5T ${label} ${seq}`, phone])).id;
  return { id, phone };
}
async function fund(userId, amount) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fin.creditWallet({ client: c, userId, amount, reference: `C5T-FUND-${userId}-${seq}-${Date.now()}`, description: 'test funding' });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);
async function expectReject(fn) { try { await fn(); return null; } catch (e) { return e; } }
async function batchFor(owner, recips) {
  return network.createBulkBatch(owner.id, { batch_name: 'C5T', recipients: recips.map(([r, a]) => ({ phone: r.phone, amount: a })) });
}
const snapshot = async (b, owner, recips) => ({
  owner: await wallet(owner.id),
  recips: await Promise.all(recips.map((r) => wallet(r.id))),
  tx: await num(`SELECT COUNT(*) FROM transactions WHERE type='BULK_PAYMENT' AND (meta->>'batch_id')::int=$1`, [b.id]),
  ops: await num(`SELECT COUNT(*) FROM financial_operations WHERE reference_id IN (SELECT 'NET:'||id||':TR' FROM bulk_payment_items WHERE batch_id=$1)`, [b.id]),
  batch: (await q1('SELECT status FROM bulk_payment_batches WHERE id=$1', [b.id])).status,
  items: (await pool.query('SELECT status FROM bulk_payment_items WHERE batch_id=$1 ORDER BY id', [b.id])).rows.map((x) => x.status).join(','),
});
const denied = (batchId, userId) => num(
  `SELECT COUNT(*) FROM audit_logs WHERE action='BULK_BATCH_PROCESS_DENIED' AND entity_id=$1 AND user_id IS NOT DISTINCT FROM $2`, [batchId, userId]);

(async () => {
  const id = await q1('SELECT current_database() AS db, inet_server_port() AS port');
  console.log(`DB identity: ${id.db} port ${id.port}`);
  if (!DB_GUARD.test(id.db)) throw new Error('connected DB does not match guard');

  console.log('\n[1] non-owner cannot process another user\'s batch; nothing changes; attempt audited');
  await section(async () => {
    const o = await user('owner'); await fund(o.id, 10000);
    const r1 = await user('r1'); const r2 = await user('r2'); const x = await user('attacker');
    const b = await batchFor(o, [[r1, 300], [r2, 200]]);
    const before = await snapshot(b, o, [r1, r2]);
    const e = await expectReject(() => network.processBulkBatch(b.id, x.id));
    const after = await snapshot(b, o, [r1, r2]);
    check('rejected with 404 "Batch hajapatikana."', !!e && e.statusCode === 404 && e.message === 'Batch hajapatikana.', e && { s: e.statusCode, m: e.message });
    check('owner not debited, recipients not credited', after.owner === before.owner && JSON.stringify(after.recips) === JSON.stringify(before.recips), { before, after });
    check('no transactions row, no operation claim', after.tx === 0 && after.ops === 0, after);
    check('batch and items still PENDING', after.batch === 'PENDING' && after.items === 'PENDING,PENDING', after);
    check('one BULK_BATCH_PROCESS_DENIED audit row for the attacker', (await denied(b.id, x.id)) === 1);
    const row = await q1(`SELECT meta FROM audit_logs WHERE action='BULK_BATCH_PROCESS_DENIED' AND entity_id=$1 AND user_id=$2`, [b.id, x.id]);
    check('audit meta reason NOT_OWNER', row && row.meta && row.meta.reason === 'NOT_OWNER', row);
  });

  console.log('\n[2] refusal is indistinguishable from getBulkBatch for a non-owner (status + message)');
  await section(async () => {
    const o = await user('owner2'); const r = await user('r'); const x = await user('x2');
    const b = await batchFor(o, [[r, 10]]);
    const g = await expectReject(() => network.getBulkBatch(b.id, x.id));
    const p = await expectReject(() => network.processBulkBatch(b.id, x.id));
    check('same statusCode and message as getBulkBatch', !!g && !!p && g.statusCode === p.statusCode && g.message === p.message, { g: g && [g.statusCode, g.message], p: p && [p.statusCode, p.message] });
    const missing = 2000000000;
    const m = await expectReject(() => network.processBulkBatch(missing, x.id));
    check('non-existent batch: same 404 message', !!m && m.statusCode === 404 && m.message === g.message, m && [m.statusCode, m.message]);
    check('non-existent batch attempt audited (reason NOT_FOUND)', (await num(`SELECT COUNT(*) FROM audit_logs WHERE action='BULK_BATCH_PROCESS_DENIED' AND entity_id=$1 AND user_id=$2 AND meta->>'reason'='NOT_FOUND'`, [missing, x.id])) === 1);
  });

  console.log('\n[3] missing requester fails closed');
  await section(async () => {
    const o = await user('owner3'); await fund(o.id, 1000); const r = await user('r3');
    const b = await batchFor(o, [[r, 100]]);
    const e = await expectReject(() => network.processBulkBatch(b.id));
    const s = await snapshot(b, o, [r]);
    check('rejected 404 without requester id', !!e && e.statusCode === 404, e && e.message);
    check('nothing changed', s.owner === 1000 && s.tx === 0 && s.batch === 'PENDING', s);
    check('audited with null user', (await denied(b.id, null)) === 1);
  });

  console.log('\n[4] owner processes as before');
  await section(async () => {
    const o = await user('owner4'); await fund(o.id, 10000);
    const r1 = await user('r41'); const r2 = await user('r42');
    const b = await batchFor(o, [[r1, 300], [r2, 200]]);
    const res = await network.processBulkBatch(b.id, o.id);
    const s = await snapshot(b, o, [r1, r2]);
    check('result 2 success / 0 failed, existing message', res.success === 2 && res.failed === 0 && res.message === 'Batch imechakatwa.', res);
    check('owner 9,500; recipients 300 / 200', s.owner === 9500 && s.recips[0] === 300 && s.recips[1] === 200, s);
    check('2 transactions, batch COMPLETED, items SUCCESS', s.tx === 2 && s.batch === 'COMPLETED' && s.items === 'SUCCESS,SUCCESS', s);
    check('no denial audit for the owner', (await denied(b.id, o.id)) === 0);
    const again = await network.processBulkBatch(b.id, o.id);
    check('owner re-run gets existing "already processed" reply', again.message === 'Batch tayari imechakatwa.', again);
    const x = await user('x4');
    const e = await expectReject(() => network.processBulkBatch(b.id, x.id));
    check('non-owner on a COMPLETED batch gets 404 (status not leaked)', !!e && e.statusCode === 404 && e.message === 'Batch hajapatikana.', e && e.message);
  });

  console.log('\n[5] concurrent: owner + 3 non-owners in parallel');
  await section(async () => {
    const o = await user('owner5'); await fund(o.id, 10000);
    const r1 = await user('r51'); const r2 = await user('r52');
    const xs = [await user('x51'), await user('x52'), await user('x53')];
    const b = await batchFor(o, [[r1, 100], [r2, 200]]);
    const calls = [...xs.map((x) => () => network.processBulkBatch(b.id, x.id)), () => network.processBulkBatch(b.id, o.id)];
    const rs = await Promise.allSettled(calls.map((f) => f()));
    const s = await snapshot(b, o, [r1, r2]);
    check('3 non-owner calls rejected 404', rs.slice(0, 3).every((r) => r.status === 'rejected' && r.reason.statusCode === 404), rs.map((r) => r.status));
    check('owner call processed the batch once', rs[3].status === 'fulfilled' && rs[3].value.success === 2, rs[3]);
    check('owner debited 300 once; 2 transactions', s.owner === 9700 && s.tx === 2, s);
    check('3 denial audit rows', (await num(`SELECT COUNT(*) FROM audit_logs WHERE action='BULK_BATCH_PROCESS_DENIED' AND entity_id=$1`, [b.id])) === 3);
  });

  console.log('\n[6] route passes the authenticated requester');
  await section(async () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/networkRoutes.js'), 'utf8');
    const m = src.match(/router\.post\('\/bulk\/:id\/process'[\s\S]*?\n\}\);/);
    check('POST /bulk/:id/process uses authRequired', !!m && /authRequired/.test(m[0]));
    check('POST /bulk/:id/process calls processBulkBatch(req.params.id, req.user.id)', !!m && /processBulkBatch\(\s*req\.params\.id\s*,\s*req\.user\.id\s*\)/.test(m[0]), m && m[0]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.log('FATAL', e.stack || e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
