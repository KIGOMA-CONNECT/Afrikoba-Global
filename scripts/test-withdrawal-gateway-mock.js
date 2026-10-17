'use strict';
/* ============================================================================
 * AFRIKOBA — withdrawal / reconciliation SCENARIO test (mock gateway)
 * ----------------------------------------------------------------------------
 * Must be started WITH the mock preloaded, e.g.:
 *   AZAMPAY_ENABLED=true AZAMPAY_ENV=sandbox AZAMPAY_MOCK_SCENARIO=SUCCESS \
 *   TEST_BASE=http://127.0.0.1:3102 \
 *   node -r ./tests/mocks/azampayMock.js scripts/test-withdrawal-gateway-mock.js
 *
 * Verifies, against a DETERMINISTIC mock gateway (no real egress):
 *   SCENARIO = SUCCESS | FAILED | PENDING | UNKNOWN | TIMEOUT
 *   1. hold is placed on withdrawal
 *   2. reconciliation settles strictly by gateway state
 *   3. duplicate reference (Idempotency-Key) does not double-hold
 *   4. idempotency: a second reconciliation does not double-move money
 *   5. egress kill-switch is provably active (positive control)
 * ==========================================================================*/
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
const fs = require('fs');
const https = require('https');
const pool = require('../src/config/db');
const config = require('../src/config');
const { reconcilePendingDeposits } = require('../src/jobs/reconciliationCron');

const SCENARIO = String(process.env.AZAMPAY_MOCK_SCENARIO || 'SUCCESS').toUpperCase();
const MOCK_LOG = process.env.AZAMPAY_MOCK_LOG || '/tmp/azampay-mock-calls.jsonl';
const AMOUNT = parseInt(process.env.WD_AMOUNT || '5000', 10);

let passed = 0; let failed = 0; const failures = [];
function ok(l) { passed++; console.log(`  ✓ ${l}`); }
function bad(l, e) { failed++; failures.push(l); console.log(`  ✗ ${l}${e ? ' :: ' + e : ''}`); }
async function expect(c, l, e) { if (c) ok(l); else bad(l, e); }

function rnd(n = 8) { const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let o = ''; for (let i = 0; i < n; i++) o += c[Math.floor(Math.random() * c.length)]; return o; }
function tail() { return String(Date.now()).slice(-6); }

async function api(method, path, token, body, ext) {
  const headers = { 'Content-Type': 'application/json', ...(ext || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}
async function sendOtp(phone) { return (await api('POST', '/api/auth/send-otp', null, { phoneNumber: phone })).data.devOtp; }
async function register(phone, name) { const otp = await sendOtp(phone); return api('POST', '/api/auth/register', null, { fullName: name, phoneNumber: phone, otp }); }
async function balanceOf(userId) {
  const r = await pool.query('SELECT wallet_balance, locked_balance FROM users WHERE id = $1', [userId]);
  return { wallet: Number(r.rows[0].wallet_balance), locked: Number(r.rows[0].locked_balance) };
}
async function fundWallet(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = 'TST-' + rnd();
    const tx = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1,$2,$3,0,$3,'SUCCESS','DEPOSIT',$4) RETURNING id`,
      [ref, userId, amount, JSON.stringify({ note: 'mock-scenario-funding' })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
    await client.query('INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description) VALUES ($1,$2,$3,$4,$5)',
      [tx.rows[0].id, ref, userId, amount, 'mock scenario funding']);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}
async function txRow(ref) {
  const r = await pool.query('SELECT status, failure_reason FROM transactions WHERE reference_id = $1', [ref]);
  return r.rows[0] || null;
}
async function opsCount(ref) {
  const r = await pool.query('SELECT count(*)::int n FROM financial_operations WHERE reference_id = $1', [ref]);
  return r.rows[0].n;
}
async function journalCount(ref) {
  const r = await pool.query('SELECT count(*)::int n FROM journal_entries WHERE reference_id = $1', [ref]);
  return r.rows[0].n;
}
async function exceptionCount(ref) {
  const r = await pool.query(`SELECT count(*)::int n FROM reconciliation_exceptions WHERE reference_id = $1 AND exception_type = 'STALE_WITHDRAWAL'`, [ref]);
  return r.rows[0].n;
}
function readLog() {
  try { return fs.readFileSync(MOCK_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
}
function probeEgress() {
  return new Promise((resolve) => {
    const req = https.request({ hostname: 'egress-probe.invalid', port: 443, path: '/', method: 'GET' }, () => resolve({ blocked: false }));
    req.on('error', (e) => resolve({ blocked: e.code === 'EGRESS_BLOCKED', code: e.code }));
    req.setTimeout(3000, () => req.destroy(new Error('probe timeout')));
    req.end();
  });
}

(async function main() {
  console.log('================================================');
  console.log(`WITHDRAWAL/RECON MOCK SCENARIO TEST — ${SCENARIO}`);
  console.log('================================================');

  const mock = globalThis.__AZAMPAY_MOCK__;
  await expect(!!mock && mock.active === true, 'Mock kill-switch imewekwa (preload active)', JSON.stringify(mock));
  await expect(config.azampay.enabled === true, 'Provider enabled (AZAMPAY_ENABLED=true)', String(config.azampay.enabled));
  await expect(config.azampay.env !== 'production', 'Non-production env (sandbox URLs only)', String(config.azampay.env));

  // positive control: the kill-switch must actually block real egress
  const probe = await probeEgress();
  await expect(probe.blocked === true, 'Egress kill-switch inazuia host halisi (EGRESS_BLOCKED)', JSON.stringify(probe));

  const phone = '255727' + tail();
  const reg = await register(phone, 'Mock Scenario User');
  const userId = reg.data.user.id;
  await fundWallet(userId, 100000);
  const base = await balanceOf(userId);

  // --- withdrawal #1 (carries an Idempotency-Key) ---------------------------
  const KEY = 'WD-DUP-' + tail();
  const wd1 = await api('POST', '/api/wallet/withdraw', reg.data.token, { amount: AMOUNT, provider: 'Mpesa' }, { 'Idempotency-Key': KEY });
  await expect(wd1.status === 200 && !!wd1.data.referenceId, 'Withdrawal #1 inafanikiwa (PROCESSING)', `${wd1.status} ${JSON.stringify(wd1.data)}`);
  const ref1 = wd1.data.referenceId;
  const held = await balanceOf(userId);
  await expect(held.wallet === base.wallet - AMOUNT && held.locked === base.locked + AMOUNT,
    'Hold imewekwa (available -amount, locked +amount)', `wallet=${held.wallet} locked=${held.locked} base=${JSON.stringify(base)}`);

  // --- duplicate reference (same Idempotency-Key => cached, no 2nd hold) ----
  const wdDup = await api('POST', '/api/wallet/withdraw', reg.data.token, { amount: AMOUNT, provider: 'Mpesa' }, { 'Idempotency-Key': KEY });
  const afterDup = await balanceOf(userId);
  await expect(wdDup.status === 200 && wdDup.data.referenceId === ref1,
    'Duplicate reference key inarudisha jibu lilelile (no re-execution)', `${wdDup.status} ${wdDup.data.referenceId} vs ${ref1}`);
  await expect(afterDup.wallet === held.wallet && afterDup.locked === held.locked,
    'Duplicate reference HAIONGEZI hold ya pili', `wallet=${afterDup.wallet} locked=${afterDup.locked} (expected ${held.wallet}/${held.locked})`);

  // --- age + reconcile #1 ---------------------------------------------------
  await pool.query(`UPDATE transactions SET created_at = NOW() - INTERVAL '16 minutes' WHERE reference_id = $1`, [ref1]);
  const recon1 = await reconcilePendingDeposits();
  await expect(recon1.processedWithdrawals.length >= 1, 'Reconciliation ilichakata withdrawal', JSON.stringify(recon1));

  const row1 = await txRow(ref1);
  const bal1 = await balanceOf(userId);
  const capOps = await opsCount(`${ref1}-CAPTURE`);
  const relOps = await opsCount(`${ref1}-RELEASE`);
  const capJ = await journalCount(`${ref1}-CAPTURE`);
  const relJ = await journalCount(`${ref1}-RELEASE`);
  const stale1 = await exceptionCount(ref1);

  if (SCENARIO === 'SUCCESS') {
    await expect(row1.status === 'SUCCESS', 'Gateway SUCCESS => withdrawal SUCCESS', JSON.stringify(row1));
    await expect(bal1.wallet === base.wallet - AMOUNT && bal1.locked === 0, 'Hold imekamatwa (locked=0, available bado imepungua)', `wallet=${bal1.wallet} locked=${bal1.locked}`);
    await expect(capOps === 1 && capJ >= 1, 'Journal ya CAPTURE imeandikwa mara moja', `capOps=${capOps} capJ=${capJ}`);
    await expect(relOps === 0, 'HAKUNA release', `relOps=${relOps}`);
    await expect(stale1 === 0, 'HAKUNA stale exception', String(stale1));
  } else if (SCENARIO === 'FAILED') {
    await expect(row1.status === 'FAILED', 'Gateway FAILED => withdrawal FAILED', JSON.stringify(row1));
    await expect(bal1.wallet === base.wallet && bal1.locked === 0, 'Fedha zimerudishwa (available=base, locked=0)', `wallet=${bal1.wallet} locked=${bal1.locked}`);
    await expect(relOps === 1 && relJ >= 1, 'Journal ya RELEASE imeandikwa mara moja', `relOps=${relOps} relJ=${relJ}`);
    await expect(capOps === 0, 'HAKUNA capture', `capOps=${capOps}`);
    await expect(stale1 === 0, 'HAKUNA stale exception', String(stale1));
  } else {
    // PENDING / UNKNOWN / TIMEOUT -> never auto-refund, surface exception
    await expect(row1.status === 'PROCESSING', 'Gateway isiyojulikana => PROCESSING inabaki', JSON.stringify(row1));
    await expect(bal1.wallet === base.wallet - AMOUNT && bal1.locked === base.locked + AMOUNT,
      'Fedha ZINABAKI kwenye hold (hakuna refund ya kubahatisha)', `wallet=${bal1.wallet} locked=${bal1.locked}`);
    await expect(stale1 >= 1, 'Exception STALE_WITHDRAWAL imefunguliwa', String(stale1));
    await expect(capOps === 0 && relOps === 0, 'HAKUNA capture wala release', `cap=${capOps} rel=${relOps}`);
  }

  // --- idempotency: reconcile #2 --------------------------------------------
  const recon2 = await reconcilePendingDeposits();
  const row2 = await txRow(ref1);
  const bal2 = await balanceOf(userId);
  const capOps2 = await opsCount(`${ref1}-CAPTURE`);
  const relOps2 = await opsCount(`${ref1}-RELEASE`);
  const capJ2 = await journalCount(`${ref1}-CAPTURE`);
  const relJ2 = await journalCount(`${ref1}-RELEASE`);

  await expect(capOps2 <= 1 && relOps2 <= 1, 'Operations hazijarudiwa (capture/release <= 1)', `cap=${capOps2} rel=${relOps2}`);
  await expect(capJ2 === capJ && relJ2 === relJ, 'Journal HAIRUDIIWA baada ya reconciliation ya pili', `capJ ${capJ}->${capJ2} relJ ${relJ}->${relJ2}`);
  await expect(bal2.wallet === bal1.wallet && bal2.locked === bal1.locked, 'Salio HALIBADILIKI kwenye reconciliation ya pili', `w ${bal1.wallet}->${bal2.wallet} l ${bal1.locked}->${bal2.locked}`);
  await expect(row2.status === row1.status, 'Hali ya transaction haibadiliki reconciliation ya pili', `${row1.status}->${row2.status}`);
  console.log(`  ℹ reconcile#2 processedWithdrawals=${recon2.processedWithdrawals.length}`);

  // --- mock log + egress assertions -----------------------------------------
  const log = readLog();
  const blockedProbe = log.filter((e) => e.kind === 'blocked' && e.host === 'egress-probe.invalid');
  const blockedOther = log.filter((e) => e.kind === 'blocked' && e.host !== 'egress-probe.invalid');
  const gateway = log.filter((e) => e.kind === 'gateway');
  const auth = gateway.filter((e) => /AppAuthentication\/Token/i.test(e.path || ''));
  const query = gateway.filter((e) => /payment\/query/i.test(e.path || ''));
  await expect(blockedProbe.length >= 1, 'Positive control: nyumbani host nje ya mtandao IMEZUILIWA', String(blockedProbe.length));
  await expect(blockedOther.length === 0,
    'HAKUNA egress nyingine iliyoruhusiwa (0 real outbound requests)', `${blockedOther.length} blocked: ${blockedOther.map((b) => b.host).join(',')}`);
  await expect(auth.length >= 1, 'Auth ya mock ilihitajika (token)', String(auth.length));
  await expect(query.length >= 1, 'Query ya mock ilitumika (gateway status)', String(query.length));
  if (process.env.AZAMPAY_EXPECT_CHECKOUT === '1') {
    const checkout = gateway.filter((e) => /mno\/checkout/i.test(e.path || ''));
    await expect(checkout.length >= 1, 'Checkout/payout dispatch ilifika gateway', String(checkout.length));
  }

  console.log('------------------------------------------------');
  console.log(`RESULT [${SCENARIO}]: ${passed} PASSED, ${failed} FAILED`);
  if (failed) { console.log('FAILED: ' + failures.join(' | ')); process.exitCode = 1; }
  await pool.end().catch(() => {});
})();
