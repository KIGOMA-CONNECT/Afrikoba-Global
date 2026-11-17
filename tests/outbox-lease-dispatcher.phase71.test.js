#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step 0: outbox lease dispatcher assurance
 *
 * Requires a DISPOSABLE database whose name starts with phase71_financial_audit_.
 * The test applies migrations 087 + 146 (both idempotent) and TRUNCATEs
 * outbox_events between cases, so it must never touch a real database.
 *
 * Usage:
 *   DB_NAME=phase71_financial_audit_<suffix> DB_USER=... DB_PASSWORD=... \
 *     node tests/outbox-lease-dispatcher.phase71.test.js
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(
    `REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`
  );
  process.exit(2);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../src/config/db');
const outbox = require('../src/services/outboxService');

let passed = 0;
let failed = 0;
const failures = [];
function ok(label) { passed++; console.log('  ✓ ' + label); }
function bad(label, extra) {
  failed++;
  failures.push(label);
  console.log('  ✗ ' + label + (extra !== undefined ? ' :: ' + extra : ''));
}
function expect(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function section(label) { console.log('\n--- ' + label + ' ---'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertConnectedDb() {
  const r = await pool.query(
    `SELECT current_database() AS db, current_user AS usr,
            inet_server_addr()::text AS addr, inet_server_port() AS port`
  );
  const { db: actual, usr, addr, port } = r.rows[0];
  console.log(`DB identity: database=${actual} user=${usr} server_addr=${addr} server_port=${port}`);
  if (actual !== targetDb || !DB_GUARD.test(actual)) {
    throw new Error(`REFUSING: connected to '${actual}', expected '${targetDb}'.`);
  }
}

async function bootstrapSchema() {
  for (const f of ['087_outbox_event_bus.sql', '146_outbox_dispatch_leases.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8');
    await pool.query(sql);
  }
}

async function reset() {
  await pool.query('TRUNCATE outbox_events RESTART IDENTITY');
}

async function insertEvent({
  eventType, status = 'PENDING', attempts = 0, maxAttempts = 5,
  lockedUntilSql = null, leaseToken = null, payload = {},
}) {
  const ref = 'P71-' + crypto.randomBytes(6).toString('hex');
  const r = await pool.query(
    `INSERT INTO outbox_events
       (event_type, payload, reference_id, status, attempts, max_attempts,
        next_attempt_at, lease_token, locked_until)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, NOW() - INTERVAL '1 second', $7,
             ${lockedUntilSql ? lockedUntilSql : 'NULL'})
     RETURNING id`,
    [eventType, JSON.stringify(payload), ref, status, attempts, maxAttempts, leaseToken]
  );
  return { id: r.rows[0].id, ref };
}

async function getEvent(id) {
  return (await pool.query('SELECT * FROM outbox_events WHERE id = $1', [id])).rows[0];
}

// ---------------------------------------------------------------------------

async function testExpiredLeaseReclaimed() {
  section('1. Expired PROCESSING lease is reclaimed and attempts increment');
  await reset();
  let calls = 0;
  outbox.registerHandler('P71_RECLAIM', async () => { calls += 1; });
  const { id } = await insertEvent({
    eventType: 'P71_RECLAIM', status: 'PROCESSING', attempts: 1,
    leaseToken: crypto.randomUUID(), lockedUntilSql: "NOW() - INTERVAL '1 minute'",
  });
  const s = await outbox.dispatchOutbox({ batchSize: 10 });
  const row = await getEvent(id);
  expect(s.claimed === 1 && s.delivered === 1, 'dispatcher claims and delivers the expired event', JSON.stringify(s));
  expect(calls === 1, 'handler invoked exactly once', calls);
  expect(row.status === 'DELIVERED', 'status DELIVERED', row.status);
  expect(row.attempts === 2, 'attempts incremented 1 -> 2', row.attempts);
  expect(row.lease_token === null && row.locked_until === null, 'lease cleared on delivery');
}

async function testLiveLeaseNotStolen() {
  section('2. Unexpired PROCESSING lease is not reclaimed');
  await reset();
  let calls = 0;
  outbox.registerHandler('P71_LIVE', async () => { calls += 1; });
  const token = crypto.randomUUID();
  const { id } = await insertEvent({
    eventType: 'P71_LIVE', status: 'PROCESSING', attempts: 1,
    leaseToken: token, lockedUntilSql: "NOW() + INTERVAL '5 minutes'",
  });
  const s = await outbox.dispatchOutbox({ batchSize: 10 });
  const row = await getEvent(id);
  expect(s.claimed === 0 && calls === 0, 'live lease untouched', JSON.stringify(s));
  expect(row.status === 'PROCESSING' && row.lease_token === token, 'owner token preserved');
}

async function testExpiredLeaseAtMaxGoesDead() {
  section('3. Expired lease with attempts >= max_attempts goes DEAD without handler call');
  await reset();
  let calls = 0;
  outbox.registerHandler('P71_EXHAUSTED', async () => { calls += 1; });
  const { id } = await insertEvent({
    eventType: 'P71_EXHAUSTED', status: 'PROCESSING', attempts: 3, maxAttempts: 3,
    leaseToken: crypto.randomUUID(), lockedUntilSql: "NOW() - INTERVAL '1 minute'",
  });
  const s = await outbox.dispatchOutbox({ batchSize: 10 });
  const row = await getEvent(id);
  expect(calls === 0, 'handler NOT invoked', calls);
  expect(s.claimed === 0, 'not claimed', JSON.stringify(s));
  expect(row.status === 'DEAD', 'status DEAD', row.status);
  expect(row.lease_token === null && row.locked_until === null, 'lease cleared');
  expect(/lease expired/i.test(row.last_error || ''), 'last_error explains lease expiry', row.last_error);
}

async function testStaleTokenAckRejected() {
  section('4. Acknowledgement with a stale lease token is rejected');
  await reset();
  const foreignToken = crypto.randomUUID();
  let targetId;
  outbox.registerHandler('P71_STOLEN', async () => {
    // Simulate another worker taking over the lease mid-flight.
    await pool.query('UPDATE outbox_events SET lease_token = $1 WHERE id = $2', [foreignToken, targetId]);
  });
  ({ id: targetId } = await insertEvent({ eventType: 'P71_STOLEN' }));
  const s = await outbox.dispatchOutbox({ batchSize: 10 });
  const row = await getEvent(targetId);
  expect(s.lostLease === 1 && s.delivered === 0, 'summary reports lostLease, not delivered', JSON.stringify(s));
  expect(row.status === 'PROCESSING' && row.lease_token === foreignToken, 'new owner state not overwritten');
}

async function testConcurrentDispatchersNoDoubleDelivery() {
  section('5. Two concurrent dispatchers never deliver the same event twice');
  await reset();
  const seen = new Map();
  outbox.registerHandler('P71_CONCURRENT', async ({ payload }) => {
    seen.set(payload.n, (seen.get(payload.n) || 0) + 1);
    await sleep(25);
  });
  const N = 12;
  for (let n = 0; n < N; n++) await insertEvent({ eventType: 'P71_CONCURRENT', payload: { n } });
  const [a, b] = await Promise.all([
    outbox.dispatchOutbox({ batchSize: 20 }),
    outbox.dispatchOutbox({ batchSize: 20 }),
  ]);
  const dupes = [...seen.values()].filter((c) => c !== 1).length;
  expect(a.claimed + b.claimed === N, `claims sum to ${N}`, `${a.claimed}+${b.claimed}`);
  expect(seen.size === N && dupes === 0, 'each event handled exactly once', JSON.stringify([...seen]));
  const delivered = (await pool.query(
    "SELECT COUNT(*)::int AS c FROM outbox_events WHERE status = 'DELIVERED'"
  )).rows[0].c;
  expect(delivered === N, `all ${N} DELIVERED`, delivered);
}

async function testHandlerFailureBackoffAndDead() {
  section('6. Handler failure -> PENDING with backoff; at max_attempts -> DEAD');
  await reset();
  outbox.registerHandler('P71_FAIL', async () => { throw new Error('boom-p71'); });
  const { id: retryId } = await insertEvent({ eventType: 'P71_FAIL', maxAttempts: 3 });
  const { id: deadId } = await insertEvent({ eventType: 'P71_FAIL', maxAttempts: 1 });
  const s = await outbox.dispatchOutbox({ batchSize: 10 });
  const retry = await getEvent(retryId);
  const dead = await getEvent(deadId);
  expect(s.failed === 1 && s.dead === 1, 'summary failed=1 dead=1', JSON.stringify(s));
  expect(retry.status === 'PENDING' && retry.attempts === 1, 'retry row PENDING, attempts=1', `${retry.status}/${retry.attempts}`);
  expect(new Date(retry.next_attempt_at) > new Date(), 'next_attempt_at pushed into the future');
  expect(retry.last_error === 'boom-p71', 'last_error recorded', retry.last_error);
  expect(retry.lease_token === null && retry.locked_until === null, 'lease cleared on failure');
  expect(dead.status === 'DEAD' && dead.attempts === 1, 'exhausted row DEAD', `${dead.status}/${dead.attempts}`);
}

async function testUnregisteredGoesFailed() {
  section('7. Event without a handler -> FAILED (not retried)');
  await reset();
  const { id } = await insertEvent({ eventType: 'P71_NO_HANDLER_' + crypto.randomBytes(3).toString('hex') });
  const s = await outbox.dispatchOutbox({ batchSize: 10 });
  const row = await getEvent(id);
  expect(s.unregistered === 1, 'summary unregistered=1', JSON.stringify(s));
  expect(row.status === 'FAILED' && /No handler registered/.test(row.last_error || ''), 'status FAILED with reason');
}

async function testAckFailureDoesNotRequeue() {
  section('8. Ack DB error after successful handler does not requeue');
  await reset();
  let calls = 0;
  outbox.registerHandler('P71_ACKFAIL', async () => { calls += 1; });
  const { id } = await insertEvent({ eventType: 'P71_ACKFAIL' });

  const realPool = pool._getPool();
  const failingPool = new Proxy(realPool, {
    get(target, prop) {
      if (prop === 'query') {
        return (sql, ...rest) => {
          const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
          if (/SET status = 'DELIVERED'/.test(text)) {
            return Promise.reject(new Error('simulated ack failure'));
          }
          return target.query(sql, ...rest);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const origError = console.error;
  console.error = () => {};
  pool._setPool(failingPool);
  let s;
  try {
    s = await outbox.dispatchOutbox({ batchSize: 10 });
  } finally {
    pool._setPool(realPool);
    console.error = origError;
  }
  const row = await getEvent(id);
  expect(calls === 1, 'handler ran once', calls);
  expect(s.acknowledgementFailed === 1 && s.failed === 0, 'counted as acknowledgementFailed, not failed', JSON.stringify(s));
  expect(row.status === 'PROCESSING' && row.lease_token !== null, 'row stays PROCESSING under same lease (no immediate requeue)', row.status);

  const again = await outbox.dispatchOutbox({ batchSize: 10 });
  expect(again.claimed === 0 && calls === 1, 'not re-dispatched while lease is live', JSON.stringify(again));
}

async function testEnqueueReplayAndConflict() {
  section('9. enqueueOutbox: identical replay is idempotent; conflicting payload throws');
  await reset();
  const reference = 'P71-ENQ-' + crypto.randomBytes(4).toString('hex');
  const first = await outbox.enqueueOutbox({ eventType: 'P71_ENQ', reference, payload: { a: 1, b: 'x' } });
  const replay = await outbox.enqueueOutbox({ eventType: 'P71_ENQ', reference, payload: { b: 'x', a: 1 } });
  expect(first.queued === true, 'first enqueue queued');
  expect(replay.queued === false && replay.id === first.id, 'identical replay returns existing id without error');

  let payloadErr = null;
  try { await outbox.enqueueOutbox({ eventType: 'P71_ENQ', reference, payload: { a: 2 } }); }
  catch (e) { payloadErr = e; }
  expect(payloadErr && /payload conflict/.test(payloadErr.message), 'different payload throws payload conflict', payloadErr && payloadErr.message);

  let typeErr = null;
  try { await outbox.enqueueOutbox({ eventType: 'P71_OTHER', reference, payload: { a: 1, b: 'x' } }); }
  catch (e) { typeErr = e; }
  expect(typeErr && /payload conflict/.test(typeErr.message), 'different eventType throws conflict', typeErr && typeErr.message);

  const count = (await pool.query('SELECT COUNT(*)::int AS c FROM outbox_events WHERE reference_id = $1', [reference])).rows[0].c;
  expect(count === 1, 'exactly one row for the reference', count);

  // Inside a transaction that rolls back, nothing persists.
  const client = await pool.connect();
  const txRef = reference + '-tx';
  try {
    await client.query('BEGIN');
    await outbox.enqueueOutbox({ eventType: 'P71_ENQ', reference: txRef, payload: {}, tx: client });
    await client.query('ROLLBACK');
  } finally { client.release(); }
  const txCount = (await pool.query('SELECT COUNT(*)::int AS c FROM outbox_events WHERE reference_id = $1', [txRef])).rows[0].c;
  expect(txCount === 0, 'enqueue with tx is rolled back with the transaction', txCount);
}

async function testSplitDuplicateRollsBack() {
  section('10. runSplitPayment duplicate period: ROLLBACK + release, no COMMIT, no enqueue');
  const calls = [];
  let released = false;
  const fakeClient = {
    query: async (sql) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/FROM investment_projects/.test(text)) return { rows: [{ id: 1, phone_number: '255700000000', full_name: 'T' }] };
      if (/FROM revenue_split_runs/.test(text)) return { rows: [{ '?column?': 1 }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const realPool = pool._getPool();
  pool._setPool({ connect: async () => fakeClient, query: async () => { throw new Error('unexpected pool.query'); } });
  let result;
  try {
    const { runSplitPayment } = require('../src/services/splitPaymentService');
    result = await runSplitPayment(1, 1, 2026);
  } finally {
    pool._setPool(realPool);
  }
  // LIMITATION: the ROLLBACK seen here may come from runSplitPayment itself OR
  // from the src/config/db.js safeRelease() wrapper, which rolls back a client
  // released mid-transaction. This asserts the rollback/release OUTCOME only,
  // not the literal ROLLBACK statement in splitPaymentService.
  expect(result && result.duplicate === true, 'returns duplicate=true', JSON.stringify(result));
  expect(calls.includes('ROLLBACK') && released, 'rollback/release path verified', JSON.stringify(calls));
  expect(!calls.includes('COMMIT'), 'no COMMIT', JSON.stringify(calls));
  expect(!calls.some((c) => /INSERT INTO outbox_events/.test(c)), 'no outbox insert');
}

// ---------------------------------------------------------------------------

(async () => {
  console.log(`Phase 71 / Step 0 — outbox lease dispatcher (db=${targetDb})`);
  try {
    await assertConnectedDb();
    await bootstrapSchema();
    await testExpiredLeaseReclaimed();
    await testLiveLeaseNotStolen();
    await testExpiredLeaseAtMaxGoesDead();
    await testStaleTokenAckRejected();
    await testConcurrentDispatchersNoDoubleDelivery();
    await testHandlerFailureBackoffAndDead();
    await testUnregisteredGoesFailed();
    await testAckFailureDoesNotRequeue();
    await testEnqueueReplayAndConflict();
    await testSplitDuplicateRollsBack();
  } catch (e) {
    bad('unexpected error', e && e.stack || e);
  } finally {
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})();
