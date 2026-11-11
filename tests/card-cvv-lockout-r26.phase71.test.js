#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R26-C3: card CVV brute-force controls
 *
 *  C3a  POST /cards/:id/authorize carries the "Financial operations (strict)"
 *       limiter (financialLimiter, 100 / 15 min), ahead of authRequired.
 *  C3b  authorizeCard: under the card lock and BEFORE comparing the CVV, if the
 *       card has >= 5 INVALID_CVV declines in the last hour the attempt is
 *       rejected with CARD_CVV_LOCKED and recorded (DECLINED / CVV_LOCKED); the
 *       CVV is not compared. CVV declines are recorded inside the locked
 *       transaction so concurrent attempts cannot exceed the limit. No schema
 *       change.
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
delete process.env.DISABLE_RATE_LIMIT; delete process.env.RATE_LIMIT_DISABLED;

const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = {
  post: async () => { throw new Error('network disabled in test'); },
  get: async () => { throw new Error('network disabled in test'); },
  create() { return this; },
  defaults: { headers: { common: {} } },
  interceptors: { request: { use() {} }, response: { use() {} } },
};
const express = require(path.join(ROOT, 'node_modules/express'));
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const card = require(path.join(ROOT, 'src/services/cardService'));
const { ERROR_CODES } = require(path.join(ROOT, 'src/utils/errorCodes'));
const { financialLimiter } = require(path.join(ROOT, 'src/middleware/granularRateLimit'));
const { authRequired } = require(path.join(ROOT, 'src/middleware/auth'));
const cardRoutes = require(path.join(ROOT, 'src/routes/cardRoutes'));

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
  const phone = `2559${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  return (await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R26C3 ${label} ${seq}`, phone])).id;
}
async function fund(userId, amount) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fin.creditWallet({ client: c, userId, amount, reference: `R26C3-FUND-${userId}-${seq}-${Date.now()}`, description: 'test funding' });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
async function newCard(label, fundAmount = 10000) {
  const u = await user(label); await fund(u, fundAmount);
  const iss = await card.issueCard(u, { daily_limit: 1000000, per_txn_limit: 1000000 });
  const wrong = String((Number(iss.cvv) + 1) % 1000).padStart(String(iss.cvv).length, '0');
  return { u, id: iss.card.id, cvv: iss.cvv, wrong };
}
const auth = (c, cvv, amount = 100) => card.authorizeCard(c.u, c.id, { merchant_name: 'R26C3', amount, cvv });
async function attempt(c, cvv, amount) { try { return { ok: await auth(c, cvv, amount) }; } catch (e) { return { err: e }; } }
const declines = (cardId, reason) => num(`SELECT COUNT(*) FROM card_transactions WHERE card_id=$1 AND status='DECLINED' AND declined_reason=$2`, [cardId, reason]);
const holds = (cardId) => num(`SELECT COUNT(*) FROM card_transactions WHERE card_id=$1 AND status='AUTH_HOLD'`, [cardId]);
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);

(async () => {
  const id = await q1('SELECT current_database() db, inet_server_port() port, inet_server_addr() addr');
  console.log(`DB identity: database=${id.db} server_addr=${id.addr} server_port=${id.port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] 5 wrong CVVs lock the card; the 6th attempt is refused even with the correct CVV');
  await section(async () => {
    const c = await newCard('lock');
    const w0 = await wallet(c.u);
    for (let i = 1; i <= 5; i++) {
      const r = await attempt(c, c.wrong);
      check(`wrong CVV #${i} → CARD_INVALID_CVV (400)`, r.err && r.err.code === 'CARD_INVALID_CVV' && r.err.statusCode === 400, r.err ? `${r.err.statusCode}:${r.err.code}` : 'accepted');
    }
    check('5 INVALID_CVV declines recorded', (await declines(c.id, 'INVALID_CVV')) === 5);
    const r6 = await attempt(c, c.cvv);
    check('6th attempt with the CORRECT CVV → CARD_CVV_LOCKED', r6.err && r6.err.code === 'CARD_CVV_LOCKED', r6.err ? `${r6.err.statusCode}:${r6.err.code}` : 'accepted');
    check('CARD_CVV_LOCKED has a stable status (429) and message', r6.err && r6.err.statusCode === 429 && ERROR_CODES.CARD_CVV_LOCKED && ERROR_CODES.CARD_CVV_LOCKED.status === 429);
    check('locked attempt recorded as DECLINED / CVV_LOCKED', (await declines(c.id, 'CVV_LOCKED')) === 1);
    check('no AUTH_HOLD, wallet and locked balance unchanged', (await holds(c.id)) === 0 && (await wallet(c.u)) === w0 && (await num('SELECT locked_balance FROM users WHERE id=$1', [c.u])) === 0);
    const r7 = await attempt(c, c.wrong);
    check('wrong CVV while locked → CARD_CVV_LOCKED (CVV not compared, not counted as INVALID_CVV)',
      r7.err && r7.err.code === 'CARD_CVV_LOCKED' && (await declines(c.id, 'INVALID_CVV')) === 5 && (await declines(c.id, 'CVV_LOCKED')) === 2, r7.err && r7.err.code);
  });

  console.log('\n[2] boundary: 4 wrong CVVs do not lock');
  await section(async () => {
    const c = await newCard('four');
    for (let i = 0; i < 4; i++) await attempt(c, c.wrong);
    const r = await attempt(c, c.cvv);
    check('correct CVV after 4 failures → AUTH_HOLD', r.ok && r.ok.status === 'AUTH_HOLD', r.err && r.err.code);
  });

  console.log('\n[3] the lock expires when failures leave the 1-hour window');
  await section(async () => {
    const c = await newCard('window');
    for (let i = 0; i < 5; i++) await attempt(c, c.wrong);
    check('locked before the window passes', (await attempt(c, c.cvv)).err?.code === 'CARD_CVV_LOCKED');
    // Age one failure past the window (disposable DB only): 4 left → not locked.
    await pool.query(`UPDATE card_transactions SET created_at = NOW() - interval '61 minutes'
                       WHERE id = (SELECT MIN(id) FROM card_transactions WHERE card_id=$1 AND declined_reason='INVALID_CVV')`, [c.id]);
    const r4 = await attempt(c, c.wrong);
    check('4 failures in window: a wrong CVV is compared again (CARD_INVALID_CVV)', r4.err && r4.err.code === 'CARD_INVALID_CVV', r4.err && r4.err.code);
    check('that failure re-locks the card (5 in window)', (await attempt(c, c.cvv)).err?.code === 'CARD_CVV_LOCKED');
    await pool.query(`UPDATE card_transactions SET created_at = NOW() - interval '61 minutes' WHERE card_id=$1 AND declined_reason='INVALID_CVV'`, [c.id]);
    const ok = await attempt(c, c.cvv);
    check('all failures older than 1 hour: correct CVV → AUTH_HOLD', ok.ok && ok.ok.status === 'AUTH_HOLD', ok.err && ok.err.code);
    await pool.query(`UPDATE card_transactions SET created_at = NOW() - interval '59 minutes' WHERE card_id=$1 AND declined_reason='INVALID_CVV'`, [c.id]);
    check('failures 59 minutes old still count (locked)', (await attempt(c, c.cvv)).err?.code === 'CARD_CVV_LOCKED');
  });

  console.log('\n[4] other cards are not affected');
  await section(async () => {
    const a = await newCard('a');
    for (let i = 0; i < 5; i++) await attempt(a, a.wrong);
    const iss2 = await card.issueCard(a.u, { daily_limit: 1000000, per_txn_limit: 1000000 });
    const sameUser = await attempt({ u: a.u, id: iss2.card.id }, iss2.cvv);
    check("same user's other card still authorizes", sameUser.ok && sameUser.ok.status === 'AUTH_HOLD', sameUser.err && sameUser.err.code);
    const b = await newCard('b');
    const other = await attempt(b, b.cvv);
    check("another user's card still authorizes", other.ok && other.ok.status === 'AUTH_HOLD', other.err && other.err.code);
    check('first card still locked', (await attempt(a, a.cvv)).err?.code === 'CARD_CVV_LOCKED');
  });

  console.log('\n[5] concurrent attempts cannot exceed the limit');
  await section(async () => {
    const c = await newCard('race');
    const r = await Promise.all(Array.from({ length: 12 }, () => attempt(c, c.wrong)));
    const inv = r.filter((x) => x.err && x.err.code === 'CARD_INVALID_CVV').length;
    const lck = r.filter((x) => x.err && x.err.code === 'CARD_CVV_LOCKED').length;
    check('12 concurrent wrong CVVs: exactly 5 compared (CARD_INVALID_CVV), 7 locked', inv === 5 && lck === 7, { inv, lck });
    check('exactly 5 INVALID_CVV and 7 CVV_LOCKED rows', (await declines(c.id, 'INVALID_CVV')) === 5 && (await declines(c.id, 'CVV_LOCKED')) === 7);
  });
  await section(async () => {
    const c = await newCard('race2');
    for (let i = 0; i < 3; i++) await attempt(c, c.wrong);
    const r = await Promise.all([...Array.from({ length: 8 }, () => attempt(c, c.wrong)), attempt(c, c.cvv)]);
    const inv = await declines(c.id, 'INVALID_CVV');
    check('mixed race (3 prior + 8 wrong + 1 correct concurrently): INVALID_CVV never exceeds 5', inv === 5, inv);
    check('mixed race: at most one hold, and only if it ran before the lock', (await holds(c.id)) <= 1, await holds(c.id));
    check('card locked afterwards', (await attempt(c, c.cvv)).err?.code === 'CARD_CVV_LOCKED');
    void r;
  });

  console.log('\n[6] other declines unchanged (recorded outside the card transaction as before)');
  await section(async () => {
    const c = await newCard('limits');
    await pool.query('UPDATE virtual_cards SET per_txn_limit=50 WHERE id=$1', [c.id]);
    const r = await attempt(c, c.cvv, 100);
    check('over per-txn limit → CARD_OVER_PER_TXN_LIMIT, recorded once', r.err && r.err.code === 'CARD_OVER_PER_TXN_LIMIT' && (await declines(c.id, 'OVER_TRANSACTION_LIMIT')) === 1, r.err && r.err.code);
    await card.freezeCard(c.u, c.id, true);
    for (let i = 0; i < 6; i++) await attempt(c, c.wrong);
    check('frozen card: CARD_INACTIVE first, CVV never evaluated (0 INVALID_CVV)', (await declines(c.id, 'CARD_FROZEN')) === 6 && (await declines(c.id, 'INVALID_CVV')) === 0);
  });

  console.log('\n[7] C3a: financialLimiter on POST /cards/:id/authorize');
  await section(async () => {
    const layer = cardRoutes.stack.find((l) => l.route && l.route.path === '/:id/authorize' && l.route.methods.post);
    const handles = layer ? layer.route.stack.map((s) => s.handle) : [];
    check('route stack: financialLimiter first, then authRequired', handles[0] === financialLimiter && handles[1] === authRequired, handles.map((h) => h.name));
    const app = express(); app.use(express.json()); app.use('/api/v1/cards', cardRoutes);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/api/v1/cards/1/authorize`;
    const codes = [];
    for (let i = 0; i < 101; i++) codes.push((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    const last = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await last.json().catch(() => null);
    server.close();
    check('first 100 requests reach auth (401)', codes.slice(0, 100).every((s) => s === 401), [...new Set(codes.slice(0, 100))]);
    check('request 101 and later → 429 RATE_LIMIT (before auth)', codes[100] === 429 && last.status === 429 && body && body.code === 'RATE_LIMIT', { c101: codes[100], last: last.status, body });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
