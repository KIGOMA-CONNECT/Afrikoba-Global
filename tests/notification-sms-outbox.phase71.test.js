#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step C: createNotification SMS via the outbox
 *
 *  1. Static: notificationService.js no longer calls sendSMS( at all.
 *  2. createNotification enqueues NOTIFICATION_SMS on the SAME client/tx that
 *     writes the notification: reference NOTIF_SMS:<notification_id>,
 *     payload exactly { userId, notificationId } (no phone, no text).
 *  3. sms_enabled=false / no preferences / empty phone -> no event, no error.
 *  4. Replay (Step B conflict) returns the existing id and enqueues nothing
 *     new; a notifying handler called twice with the same referenceId leaves
 *     one NOTIFICATION_SMS event and, after dispatch, one SMS delivery.
 *  5. Rollback: createNotification inside the caller's tx + ROLLBACK leaves no
 *     notification and no NOTIFICATION_SMS event.
 *     Enqueue failure is isolated by a SAVEPOINT: notification kept, id
 *     returned (not null), error logged with notificationId, caller tx usable.
 *     Other failures: client path re-throws, pool path returns null.
 *  6. NOTIFICATION_SMS handler: SELECT-only reads; sendSMSIdempotent keyed by
 *     the outbox referenceId; SENT ok; UNKNOWN -> NonRetryableError
 *     SMS_DELIVERY_UNKNOWN; PENDING / FAILED -> ordinary Error; missing
 *     notification or missing phone -> returns, no error, no SMS.
 *
 * axios is stubbed: no real network. Run with a connection logger preload to
 * prove that only the local test database is contacted.
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix>.
 * Usage:
 *   DB_NAME=phase71_financial_audit_<suffix> DB_USER=... DB_PASSWORD=... \
 *     node tests/notification-sms-outbox.phase71.test.js
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- axios stub (must be installed before smsService is loaded) -----------
require('axios'); // populate require.cache before replacing exports
const axiosPath = require.resolve('axios');
const httpCalls = [];
require.cache[axiosPath].exports = {
  post: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.post not expected'); },
  get: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.get not expected'); },
};

const pool = require('../src/config/db');
const outbox = require('../src/services/outboxService');
const smsService = require('../src/services/smsService');
const logger = require('../src/utils/logger');
const { createNotification } = require('../src/services/notificationService');
const { registerAll } = require('../src/outbox/handlers');

const SERVICE_FILE = path.join(__dirname, '..', 'src', 'services', 'notificationService.js');
const tag = crypto.randomBytes(4).toString('hex');
let seq = 0;

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
async function safe(fn) {
  try { return { value: await fn() }; } catch (e) { return { error: e.message || String(e), err: e }; }
}

async function makeUser({ sms = true, prefs = true, phone } = {}) {
  seq += 1;
  const ph = phone !== undefined ? phone : `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const u = await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71C ${tag} ${seq}`, ph]
  );
  const id = u.rows[0].id;
  if (prefs) {
    await pool.query(
      `INSERT INTO notification_preferences (user_id, sms_enabled) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET sms_enabled = EXCLUDED.sms_enabled`,
      [id, sms]
    );
  }
  return { id, phone: ph };
}
async function smsEvents(notificationId) {
  return (await pool.query(
    `SELECT id, event_type, aggregate_id, payload, status, last_error FROM outbox_events
      WHERE event_type = 'NOTIFICATION_SMS' AND reference_id = $1`,
    [`NOTIF_SMS:${notificationId}`]
  )).rows;
}
async function smsEventsForUser(userId) {
  return (await pool.query(
    `SELECT COUNT(*)::int AS c FROM outbox_events
      WHERE event_type = 'NOTIFICATION_SMS' AND payload->>'userId' = $1`,
    [String(userId)]
  )).rows[0].c;
}
async function deliveries(key) {
  return (await pool.query('SELECT status, simulated, attempts FROM sms_deliveries WHERE idempotency_key = $1', [key])).rows;
}
function handlersMap() {
  const h = new Map();
  registerAll({ registerHandler: (t, fn) => h.set(t, fn) });
  return h;
}

// ---------------------------------------------------------------------------

async function testStatic() {
  section('1. Static: no sendSMS( in notificationService.js');
  const src = fs.readFileSync(SERVICE_FILE, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(!/\bsendSMS\s*\(/.test(code), 'no sendSMS( call', (code.match(/.*\bsendSMS\s*\(.*/g) || []).join(' | '));
  expect(!/\bsendSMS\b/.test(code), 'sendSMS not imported/referenced');
  expect(/NOTIFICATION_SMS/.test(code), 'NOTIFICATION_SMS referenced');
}

async function testEnqueue() {
  section('2. createNotification enqueues NOTIFICATION_SMS (reference + minimal payload)');
  const a = await makeUser({ sms: true });
  const id = await createNotification(a.id, { title: 'T', body: `Siri ${tag} 0712`, sourceEventReference: `P71C-E-${tag}` });
  expect(Number.isInteger(id), 'returns an id', id);
  const ev = await smsEvents(id);
  expect(ev.length === 1, 'exactly one NOTIFICATION_SMS event with reference NOTIF_SMS:<id>', ev.length);
  if (ev[0]) {
    const keys = Object.keys(ev[0].payload).sort();
    expect(JSON.stringify(keys) === JSON.stringify(['notificationId', 'userId']),
      'payload keys are exactly { notificationId, userId }', JSON.stringify(keys));
    expect(Number(ev[0].payload.userId) === a.id && Number(ev[0].payload.notificationId) === id,
      'payload values match user and notification', JSON.stringify(ev[0].payload));
    const raw = JSON.stringify(ev[0].payload);
    expect(!raw.includes(a.phone) && !raw.includes('Siri'), 'payload holds no phone and no SMS text', raw);
    expect(ev[0].status === 'PENDING', 'event is PENDING (not sent inline)', ev[0].status);
  }
  expect(httpCalls.length === 0, 'no provider call inline', httpCalls.length);

  // Without sourceEventReference: still one event.
  const id2 = await createNotification(a.id, { title: 'T', body: 'no-ref' });
  expect((await smsEvents(id2)).length === 1, 'no-reference notification also enqueues one event');
}

async function testNoEvent() {
  section('3. No event: sms_enabled=false, no preferences, empty phone');
  const off = await makeUser({ sms: false });
  const r1 = await safe(() => createNotification(off.id, { title: 'T', body: 'off' }));
  expect(!r1.error && Number.isInteger(r1.value), 'sms_enabled=false: notification created', r1.error || r1.value);
  expect((await smsEventsForUser(off.id)) === 0, 'sms_enabled=false: no NOTIFICATION_SMS event');

  const noPrefs = await makeUser({ prefs: false });
  const r2 = await safe(() => createNotification(noPrefs.id, { title: 'T', body: 'noprefs' }));
  expect(!r2.error && Number.isInteger(r2.value), 'no preferences row: notification created', r2.error || r2.value);
  expect((await smsEventsForUser(noPrefs.id)) === 0, 'no preferences row: no event');

  // users.phone_number is UNIQUE NOT NULL: the empty string is the only
  // "missing phone" value; reuse the row if a previous run left one.
  let empty = (await pool.query(`SELECT id FROM users WHERE phone_number = ''`)).rows[0];
  if (!empty) empty = await makeUser({ sms: true, phone: '' });
  else await pool.query(
    `INSERT INTO notification_preferences (user_id, sms_enabled) VALUES ($1, TRUE)
     ON CONFLICT (user_id) DO UPDATE SET sms_enabled = TRUE`, [empty.id]);
  const before = await smsEventsForUser(empty.id);
  const r3 = await safe(() => createNotification(empty.id, { title: 'T', body: 'nophone' }));
  expect(!r3.error && Number.isInteger(r3.value), 'empty phone: notification created, no error', r3.error || r3.value);
  expect((await smsEventsForUser(empty.id)) === before, 'empty phone: no event');
}

async function testReplay() {
  section('4. Replay: no second event; handler twice -> one event, one SMS');
  const a = await makeUser({ sms: true });
  const ref = `P71C-R-${tag}`;
  const id1 = await createNotification(a.id, { title: 'T', body: 'replay', sourceEventReference: ref });
  const id2 = await createNotification(a.id, { title: 'T', body: 'replay', sourceEventReference: ref });
  expect(id1 === id2, 'replay returns the existing id', `${id1} vs ${id2}`);
  expect((await smsEventsForUser(a.id)) === 1, 'one NOTIFICATION_SMS event after replay', await smsEventsForUser(a.id));

  const h = handlersMap();
  const u = await makeUser({ sms: true });
  const referenceId = `OUTBOX_TEST:P71C:${tag}`;
  const args = { eventType: 'OUTBOX_TEST', payload: { userId: u.id }, referenceId, eventId: 1 };
  const r1 = await safe(() => h.get('OUTBOX_TEST')(args));
  const r2 = await safe(() => h.get('OUTBOX_TEST')(args));
  expect(!r1.error && !r2.error, 'handler called twice without error', r1.error || r2.error);
  const nid = (await pool.query(
    'SELECT id FROM notifications WHERE user_id = $1 AND source_event_reference = $2',
    [u.id, `${referenceId}:u${u.id}`])).rows[0];
  expect(!!nid && (await smsEventsForUser(u.id)) === 1, 'one NOTIFICATION_SMS event for the handler replay', await smsEventsForUser(u.id));

  const ev = nid ? (await smsEvents(nid.id))[0] : undefined;
  expect(!!ev, 'handler replay event exists for dispatch');
  if (ev) {
    await outbox.dispatchOutbox({ batchSize: 200 });
    // Force a redelivery of the same event: still one SMS delivery row.
    await pool.query(
      `UPDATE outbox_events SET status = 'PENDING', next_attempt_at = NOW() - INTERVAL '1 second',
              lease_token = NULL, locked_until = NULL WHERE id = $1`, [ev.id]);
    await outbox.dispatchOutbox({ batchSize: 200 });
    const d = await deliveries(`NOTIF_SMS:${nid.id}`);
    const after = (await pool.query('SELECT status FROM outbox_events WHERE id = $1', [ev.id])).rows[0];
    expect(d.length === 1 && d[0].status === 'SENT' && d[0].attempts === 1,
      'one SMS delivery (SENT, attempts=1) after dispatch + redelivery', JSON.stringify(d));
    expect(after.status === 'DELIVERED', 'event DELIVERED', after.status);
  }
}

async function testRollback() {
  section('5. Rollback: caller tx ROLLBACK leaves no notification and no event');
  const a = await makeUser({ sms: true });
  const client = await pool.connect();
  let id = null;
  let seenInTx = 0;
  try {
    await client.query('BEGIN');
    id = await createNotification(a.id, { title: 'T', body: 'rollback', client, sourceEventReference: `P71C-RB-${tag}` });
    seenInTx = (await client.query(
      `SELECT COUNT(*)::int AS c FROM outbox_events WHERE reference_id = $1`, [`NOTIF_SMS:${id}`])).rows[0].c;
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  expect(Number.isInteger(id), 'id returned inside the tx', id);
  expect(seenInTx === 1, 'event visible inside the caller tx', seenInTx);
  const n = (await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE id = $1', [id])).rows[0].c;
  expect(n === 0, 'no notification after ROLLBACK', n);
  const e = (await smsEvents(id)).length;
  expect(e === 0, 'no NOTIFICATION_SMS event after ROLLBACK', e);

  // Force the NOTIFICATION_SMS enqueue to fail: predict the next notification
  // id and plant an outbox row with the same reference but another payload
  // (enqueueOutbox -> "Outbox reference payload conflict").
  async function plantConflict() {
    const next = Number((await pool.query(`SELECT nextval('notifications_id_seq') AS v`)).rows[0].v) + 1;
    await pool.query(
      `INSERT INTO outbox_events (event_type, aggregate_id, payload, reference_id)
       VALUES ('NOTIFICATION_SMS', 'x', '{"conflict":true}'::jsonb, $1)`, [`NOTIF_SMS:${next}`]);
    return next;
  }
  const loggedErrors = [];
  const realLogError = logger.error;
  logger.error = (scope, msg) => { loggedErrors.push(String(msg)); };
  try {
    section('5b. (a) enqueue failure (own tx): notification kept, id returned, error logged');
    const b = await makeUser({ sms: true });
    const next = await plantConflict();
    const r = await safe(() => createNotification(b.id, { title: 'T', body: `savepoint ${tag}` }));
    const kept = (await pool.query('SELECT id FROM notifications WHERE user_id = $1', [b.id])).rows;
    expect(!r.error && r.value === next, 'createNotification returns the notification id (not null)', r.error || r.value);
    expect(kept.length === 1 && kept[0].id === next, 'notification kept after the failed enqueue', JSON.stringify(kept));
    const ev = (await pool.query(`SELECT payload FROM outbox_events WHERE reference_id = $1`, [`NOTIF_SMS:${next}`])).rows;
    expect(ev.length === 1 && ev[0].payload.conflict === true, 'no NOTIFICATION_SMS event of ours (only the planted row)', JSON.stringify(ev));
    expect(loggedErrors.some((m) => m.includes(`notificationId=${next}`) && /NOTIFICATION_SMS enqueue failed/.test(m)),
      'enqueue failure logged with the notificationId', JSON.stringify(loggedErrors));

    section('5b. (b) enqueue failure inside the caller tx: caller tx stays usable');
    const c = await makeUser({ sms: true });
    const next2 = await plantConflict();
    const ctx = await pool.connect();
    let id = null;
    let after = null;
    let commit = null;
    try {
      await ctx.query('BEGIN');
      id = await createNotification(c.id, { title: 'T', body: `caller ${tag}`, client: ctx });
      after = await safe(() => ctx.query(
        `UPDATE notification_preferences SET updated_at = NOW() WHERE user_id = $1 RETURNING user_id`, [c.id]));
      commit = await safe(() => ctx.query('COMMIT'));
    } finally {
      await ctx.query('ROLLBACK').catch(() => {});
      ctx.release();
    }
    expect(id === next2, 'createNotification(client) returns the id after the failed enqueue', id);
    expect(!after.error && after.value.rowCount === 1, 'caller runs another statement in the same tx', after.error);
    expect(!commit.error && commit.value.command === 'COMMIT', 'caller tx COMMITs (not aborted)', commit.error || (commit.value && commit.value.command));
    const n = (await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE id = $1', [next2])).rows[0].c;
    expect(n === 1, 'notification committed with the caller tx', n);
  } finally {
    logger.error = realLogError;
  }

  section('5c. Other failures: client path re-throws, pool path returns null');
  const d = await makeUser({ sms: true });
  const longTitle = 'X'.repeat(151); // notifications.title is VARCHAR(150)
  const c5 = await pool.connect();
  let thrown;
  try {
    await c5.query('BEGIN');
    thrown = await safe(() => createNotification(d.id, { title: longTitle, body: 'b', client: c5 }));
    await c5.query('ROLLBACK');
  } finally {
    c5.release();
  }
  expect(!!thrown.error && /too long/i.test(thrown.error), 'client path: error re-thrown to the tx owner', thrown.error || thrown.value);
  const viaPool = await safe(() => createNotification(d.id, { title: longTitle, body: 'b' }));
  expect(!viaPool.error && viaPool.value === null, 'pool path: returns null as before', viaPool.error || viaPool.value);
  const none = (await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1', [d.id])).rows[0].c;
  expect(none === 0, 'no notification row for the failed calls', none);
}

async function testHandler() {
  section('6. NOTIFICATION_SMS handler');
  const h = handlersMap();
  const fn = h.get('NOTIFICATION_SMS');
  expect(typeof fn === 'function', 'NOTIFICATION_SMS handler registered');
  if (!fn) return;

  // SELECT-only: spy on pool.query used by the handler.
  const u = await makeUser({ sms: true });
  const id = await createNotification(u.id, { title: 'T', body: `H ${tag}`, sourceEventReference: `P71C-H-${tag}` });
  const refId = `NOTIF_SMS:${id}`;
  const real = pool._getPool();
  const statements = [];
  const spy = new Proxy(real, {
    get(t, p) {
      if (p === 'query') return (text, ...rest) => { statements.push(typeof text === 'string' ? text : text.text); return t.query(text, ...rest); };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const realSend = smsService.sendSMSIdempotent;
  const sendCalls = [];
  smsService.sendSMSIdempotent = async (...a) => { sendCalls.push(a); return realSend(...a); };
  pool._setPool(spy);
  let sent;
  try {
    sent = await safe(() => fn({ eventType: 'NOTIFICATION_SMS', payload: { userId: u.id, notificationId: id }, referenceId: refId, eventId: 1 }));
  } finally {
    pool._setPool(real);
  }
  const ownSql = statements.filter((s) => /notifications|users/i.test(s) && !/sms_deliveries/i.test(s));
  expect(ownSql.length >= 1 && ownSql.every((s) => /^\s*SELECT\b/i.test(s)),
    'handler reads notification/user with SELECT only', JSON.stringify(ownSql));
  expect(!sent.error && sent.value && sent.value.success === true, 'SENT -> success', sent.error || JSON.stringify(sent.value));
  expect(sendCalls.length === 1 && sendCalls[0][0] === refId && sendCalls[0][1] === u.phone && sendCalls[0][2] === `H ${tag}`,
    'sendSMSIdempotent(referenceId, user phone, notification body)', JSON.stringify(sendCalls.map((c) => c[0])));
  const d = await deliveries(refId);
  expect(d.length === 1 && d[0].status === 'SENT', 'sms_deliveries row SENT for the reference', JSON.stringify(d));

  // Status mapping with a controlled sendSMSIdempotent.
  const cases = [
    { status: 'UNKNOWN', check: (r) => r.err instanceof outbox.NonRetryableError && r.err.code === 'SMS_DELIVERY_UNKNOWN', label: 'UNKNOWN -> NonRetryableError(SMS_DELIVERY_UNKNOWN)' },
    { status: 'PENDING', inFlight: true, check: (r) => r.error && !(r.err instanceof outbox.NonRetryableError), label: 'PENDING -> ordinary Error' },
    { status: 'FAILED', check: (r) => r.error && !(r.err instanceof outbox.NonRetryableError), label: 'FAILED -> ordinary Error' },
  ];
  try {
    for (const c of cases) {
      smsService.sendSMSIdempotent = async () => ({ status: c.status, inFlight: c.inFlight, error: 'beem:ETIMEDOUT' });
      const r = await safe(() => fn({ eventType: 'NOTIFICATION_SMS', payload: { userId: u.id, notificationId: id }, referenceId: refId, eventId: 1 }));
      expect(c.check(r), c.label, r.error || JSON.stringify(r.value));
    }
  } finally {
    smsService.sendSMSIdempotent = realSend;
  }

  // Real UNKNOWN row -> dispatcher marks DEAD with SMS_DELIVERY_UNKNOWN, no provider call.
  const v = await makeUser({ sms: true });
  const vid = await createNotification(v.id, { title: 'T', body: `U ${tag}`, sourceEventReference: `P71C-U-${tag}` });
  const vkey = `NOTIF_SMS:${vid}`;
  await pool.query(
    `INSERT INTO sms_deliveries (idempotency_key, phone_hash, phone_last4, body_hash, status, attempts)
     VALUES ($1, $2, $3, $4, 'UNKNOWN', 1)`,
    [vkey, smsService._hash(smsService._normalizePhone(v.phone)), v.phone.slice(-4), smsService._hash(`U ${tag}`)]);
  await outbox.dispatchOutbox({ batchSize: 200 });
  const vev = (await smsEvents(vid))[0];
  expect(vev && vev.status === 'DEAD' && /^SMS_DELIVERY_UNKNOWN/.test(vev.last_error || ''),
    'UNKNOWN delivery -> event DEAD, last_error SMS_DELIVERY_UNKNOWN', vev && `${vev.status} ${vev.last_error}`);

  // Missing notification / missing phone -> no error, no SMS.
  const calls = [];
  smsService.sendSMSIdempotent = async (...a) => { calls.push(a); return { status: 'SENT' }; };
  try {
    const m1 = await safe(() => fn({ eventType: 'NOTIFICATION_SMS', payload: { userId: u.id, notificationId: 2147483000 }, referenceId: 'NOTIF_SMS:2147483000', eventId: 1 }));
    expect(!m1.error, 'missing notification -> returns without error', m1.error);
    const m2 = await safe(() => fn({ eventType: 'NOTIFICATION_SMS', payload: { userId: v.id, notificationId: id }, referenceId: refId, eventId: 1 }));
    expect(!m2.error, 'notification of another user -> returns without error', m2.error);
    let empty = (await pool.query(`SELECT id FROM users WHERE phone_number = ''`)).rows[0];
    if (!empty) empty = await makeUser({ sms: true, phone: '' });
    const en = (await pool.query(
      `INSERT INTO notifications (user_id, title, body) VALUES ($1, 'T', 'x') RETURNING id`, [empty.id])).rows[0].id;
    const m3 = await safe(() => fn({ eventType: 'NOTIFICATION_SMS', payload: { userId: empty.id, notificationId: en }, referenceId: `NOTIF_SMS:${en}`, eventId: 1 }));
    expect(!m3.error, 'user without phone -> returns without error', m3.error);
    expect(calls.length === 0, 'no SMS for missing notification / missing phone', calls.length);
  } finally {
    smsService.sendSMSIdempotent = realSend;
  }
  expect(httpCalls.length === 0, 'no real provider HTTP call in the whole suite', httpCalls.length);
}

// ---------------------------------------------------------------------------

(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr,
              inet_server_addr()::text AS addr, inet_server_port() AS port`
    );
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);
    registerAll(outbox); // the dispatcher needs the real handlers

    const silenced = console.error;
    console.error = () => {};
    try {
      for (const t of [testStatic, testEnqueue, testNoEvent, testReplay, testRollback, testHandler]) {
        const res = await safe(t);
        if (res.error) bad(`${t.name} aborted`, res.error);
      }
    } finally {
      console.error = silenced;
    }
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
