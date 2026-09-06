/* ============================================================
 * AFRIKOBA GLOBAL - OUTBOX + EVENT BUS
 * Transaction-aware enqueue (dedup via reference_id), dispatcher
 * (SKIP LOCKED claim), exponential backoff, dead-letter + requeue.
 * ============================================================ */
const BASE = process.env.OUTBOX_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const outbox = require('../src/services/outboxService');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
  return refresh.data.token;
}

function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const admin = await register(`255731${suffix}`, 'Outbox Admin');
  const player = await register(`255732${suffix}`, 'Outbox Player');
  const adminToken = await makeAdmin(admin);
  await expect(!!adminToken && !!player.data.token, 'Users registered + admin');
  const userId = player.data.user.id;
  const ref = `OUT:TEST:${suffix}`;

  // ---------- enqueue + dedup ----------
  await section('Enqueue (dedup via reference_id)');
  let enqueued = await outbox.enqueueOutbox({ eventType: 'OUTBOX_TEST', aggregateId: 'u', payload: { userId }, reference: ref });
  await expect(enqueued.queued === true && enqueued.id > 0, 'Event queued PENDING', JSON.stringify(enqueued));
  const dup = await outbox.enqueueOutbox({ eventType: 'OUTBOX_TEST', payload: { userId }, reference: ref });
  await expect(dup.queued === false, 'Duplicate reference de-duplicated (returned id null)', JSON.stringify(dup));
  let rowCount = await pool.query("SELECT COUNT(*)::int AS n FROM outbox_events WHERE reference_id = $1", [ref]);
  await expect(rowCount.rows[0].n === 1, 'Only one row exists for the reference', `n=${rowCount.rows[0].n}`);

  await outbox.enqueueOutbox({ eventType: 'UNREGISTERED_EVENT', payload: { x: 1 }, reference: `OUT:UNREG:${suffix}` });

  // ---------- permissions ----------
  await section('Admin-only endpoints');
  let anon = await api('GET', '/api/outbox/stats', null, null);
  await expect(anon.status === 401, 'Anonymous blocked from stats', `status=${anon.status}`);
  let nonAdmin = await api('GET', '/api/outbox/stats', player.data.token, null);
  await expect(nonAdmin.status === 403, 'Non-admin blocked from stats', `status=${nonAdmin.status}`);

  // ---------- dispatch ----------
  await section('Dispatcher (delivered + unregistered)');
  let dispatched = await api('POST', '/api/outbox/dispatch', adminToken, { batchSize: 20 });
  await expect(dispatched.status === 200 && dispatched.data.result.claimed >= 2, 'Dispatch claimed events (incl. events from earlier suites)', `status=${dispatched.status} ${JSON.stringify(dispatched.data.result)}`);
  let notif = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND title = $2', [userId, 'Outbox heartbeat']);
  await expect(notif.rows[0].n === 1, 'OUTBOX_TEST handler created a notification', `n=${notif.rows[0].n}`);
  let txType = await pool.query("SELECT status FROM outbox_events WHERE reference_id = $1", [ref]);
  await expect(txType.rows[0].status === 'DELIVERED', 'Handled event DELIVERED', `status=${txType.rows[0].status}`);
  let unreg = await pool.query("SELECT status FROM outbox_events WHERE event_type = 'UNREGISTERED_EVENT'");
  await expect(unreg.rows[0].status === 'FAILED', 'Unregistered event escalated to FAILED', `status=${unreg.rows[0].status}`);
  let stats = await api('GET', '/api/outbox/stats', adminToken, null);
  await expect(stats.status === 200 && stats.data.stats.counts.DELIVERED >= 1, 'Stats reflect DELIVERED', `status=${stats.status}`);

  // ---------- retry + backoff + eventual delivery ----------
  await section('Retry with backoff -> eventual delivery');
  const retryRef = `OUT:RETRY:${suffix}`;
  await outbox.enqueueOutbox({ eventType: 'OUTBOX_RETRY', payload: {}, reference: retryRef, maxAttempts: 3 });
  let retryStatus = 'PENDING';
  for (let i = 0; i < 3 && retryStatus === 'PENDING'; i++) {
    await pool.query("UPDATE outbox_events SET next_attempt_at = NOW() WHERE reference_id = $1 AND status = 'PENDING'", [retryRef]);
    await api('POST', '/api/outbox/dispatch', adminToken, { batchSize: 5 });
    const r = await pool.query("SELECT status, attempts FROM outbox_events WHERE reference_id = $1", [retryRef]);
    retryStatus = r.rows[0].status;
    const attempts = r.rows[0].attempts;
    if (i < 2 && retryStatus === 'FAILED') { /* intermediate (PO state kept in PENDING) */ }
    else if (i === 0) {
      await expect(attempts >= 1, `First retry attempt recorded (attempts=${attempts})`);
    }
  }
  const finalRetry = await pool.query("SELECT status, attempts FROM outbox_events WHERE reference_id = $1", [retryRef]);
  await expect(finalRetry.rows[0].status === 'DELIVERED', 'Event delivered after retries', `status=${finalRetry.rows[0].status} attempts=${finalRetry.rows[0].attempts}`);

  // ---------- dead-letter + requeue ----------
  await section('Dead-letter + requeue');
  const deadRef = `OUT:DEAD:${suffix}`;
  await outbox.enqueueOutbox({ eventType: 'OUTBOX_RETRY', payload: {}, reference: deadRef, maxAttempts: 1 });
  await pool.query("UPDATE outbox_events SET next_attempt_at = NOW() WHERE reference_id = $1", [deadRef]);
  await api('POST', '/api/outbox/dispatch', adminToken, { batchSize: 5 });
  let deadRow = await pool.query("SELECT status, attempts FROM outbox_events WHERE reference_id = $1", [deadRef]);
  await expect(deadRow.rows[0].status === 'DEAD' && deadRow.rows[0].attempts === 1, 'Failed past max_attempts goes DEAD', `status=${deadRow.rows[0].status} attempts=${deadRow.rows[0].attempts}`);
  let requeue = await api('POST', '/api/outbox/dead/requeue', adminToken, {});
  await expect(requeue.status === 200 && requeue.data.result.requeued >= 1, 'Requeue returns DEAD rows to PENDING', `status=${requeue.status} ${JSON.stringify(requeue.data.result)}`);
  deadRow = await pool.query("SELECT status FROM outbox_events WHERE reference_id = $1", [deadRef]);
  await expect(deadRow.rows[0].status === 'PENDING', 'Dead letter now PENDING again', `status=${deadRow.rows[0].status}`);

  // ---------- pending list ----------
  const pendingList = await api('GET', '/api/outbox/pending?limit=10', adminToken, null);
  await expect(pendingList.status === 200 && Array.isArray(pendingList.data.events), 'Admin lists pending events', `status=${pendingList.status} n=${pendingList.data?.events?.length}`);

  console.log(`\n===== OUTBOX: ${passed} passed, ${failed} failed =====`);
  if (failed > 0) {
    console.log('FAILURES:', failures.join(' | '));
    process.exit(1);
  }
  await pool.end();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});