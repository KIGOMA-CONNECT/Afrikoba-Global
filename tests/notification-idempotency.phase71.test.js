#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step B: notification idempotency
 *
 *  1. Migration 147 (source_event_reference + partial unique index) is
 *     idempotent (applied twice), has no BEGIN/COMMIT, and creates the
 *     expected column and UNIQUE ... WHERE source_event_reference IS NOT NULL.
 *  2. createNotification({ sourceEventReference, client }):
 *     same reference twice -> same id, one row, never null, no second SMS;
 *     different references -> different rows; NULL references never collide;
 *     same reference for different users -> separate rows; client (tx) honoured.
 *  3. The outbox dispatcher passes referenceId and eventId to handlers.
 *  4. The five notifying handlers use sourceEventReference
 *     `${referenceId}:u${userId}`: a second call with the same referenceId
 *     leaves exactly one notification and does not throw.
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix> with
 * the full schema (db/schema.sql + db/migrations/*.sql) applied.
 * Usage:
 *   DB_NAME=phase71_financial_audit_<suffix> DB_USER=... DB_PASSWORD=... \
 *     node tests/notification-idempotency.phase71.test.js
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

// Stub the SMS provider before anything loads notificationService.
const smsCalls = [];
const smsPath = require.resolve('../src/services/smsService');
require.cache[smsPath] = {
  id: smsPath, filename: smsPath, loaded: true,
  exports: {
    sendSMS: async (phone, body) => { smsCalls.push({ phone, body }); return { success: true, simulated: true, provider: 'stub' }; },
    resolveProvider: () => 'stub', isProviderConfigured: () => false, providersAvailable: () => false,
  },
};

const pool = require('../src/config/db');
const outbox = require('../src/services/outboxService');
const { createNotification } = require('../src/services/notificationService');
const { registerAll } = require('../src/outbox/handlers');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '147_notification_idempotency.sql');
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

async function makeUser({ sms = false } = {}) {
  seq += 1;
  const phone = `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const u = await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71B ${tag} ${seq}`, phone]
  );
  const id = u.rows[0].id;
  await pool.query(
    `INSERT INTO notification_preferences (user_id, sms_enabled) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET sms_enabled = EXCLUDED.sms_enabled`,
    [id, sms]
  );
  return { id, phone };
}
async function countFor(userId) {
  return (await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1', [userId])).rows[0].c;
}
async function safe(fn) {
  try { return { value: await fn() }; } catch (e) { return { error: e.message || String(e) }; }
}

// ---------------------------------------------------------------------------

async function testMigration() {
  section('1. Migration 147: idempotent, no BEGIN/COMMIT, expected column + partial unique index');
  const exists = fs.existsSync(MIGRATION);
  expect(exists, 'db/migrations/147_notification_idempotency.sql exists');
  if (!exists) return;
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  expect(!/^\s*(BEGIN|COMMIT|START\s+TRANSACTION|ROLLBACK)\b/im.test(code), 'no BEGIN/COMMIT/ROLLBACK statements');
  expect(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+source_event_reference/i.test(code), 'ADD COLUMN IF NOT EXISTS');
  expect(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS/i.test(code), 'CREATE UNIQUE INDEX IF NOT EXISTS');

  const first = await safe(() => pool.query(sql));
  const second = await safe(() => pool.query(sql));
  expect(!first.error, 'apply #1 succeeds', first.error);
  expect(!second.error, 'apply #2 succeeds (idempotent)', second.error);

  const col = (await pool.query(
    `SELECT data_type, character_maximum_length AS len, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'notifications' AND column_name = 'source_event_reference'`
  )).rows[0];
  expect(col && col.data_type === 'character varying' && col.len === 200 && col.is_nullable === 'YES',
    'column source_event_reference VARCHAR(200) NULL', JSON.stringify(col));

  const idx = (await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'notifications' AND indexdef ILIKE '%source_event_reference%'`
  )).rows;
  expect(idx.length === 1, 'exactly one index on source_event_reference', JSON.stringify(idx));
  const def = idx[0] ? idx[0].indexdef : '';
  expect(/CREATE UNIQUE INDEX/i.test(def), 'index is UNIQUE', def);
  expect(/\(user_id, source_event_reference\)/.test(def), 'index columns (user_id, source_event_reference)', def);
  expect(/WHERE \(source_event_reference IS NOT NULL\)/.test(def), 'index is partial: WHERE source_event_reference IS NOT NULL', def);
}

async function testCreateNotification() {
  section('2. createNotification idempotency');

  // Same reference twice -> same id, one row, one SMS.
  const a = await makeUser({ sms: true });
  const smsBefore = smsCalls.length;
  const ref = `P71B-REF-${tag}`;
  const id1 = await createNotification(a.id, { title: 'T', body: 'B1', sourceEventReference: ref });
  const id2 = await createNotification(a.id, { title: 'T', body: 'B1', sourceEventReference: ref });
  expect(id1 !== null && id1 !== undefined, 'first call returns an id', id1);
  expect(id2 !== null && id2 !== undefined, 'replay never returns null', id2);
  expect(id1 === id2, 'replay returns the existing id', `${id1} vs ${id2}`);
  expect((await countFor(a.id)) === 1, 'exactly one row for the reference', await countFor(a.id));
  // Step C: the SMS is no longer sent inline; exactly one NOTIFICATION_SMS
  // outbox event is enqueued, and none on replay.
  const smsEvents = await safe(() => pool.query(
    `SELECT COUNT(*)::int AS c FROM outbox_events WHERE event_type = 'NOTIFICATION_SMS' AND reference_id = $1`,
    [`NOTIF_SMS:${id1}`]));
  expect(!smsEvents.error && smsEvents.value.rows[0].c === 1 && smsCalls.length === smsBefore,
    'one NOTIFICATION_SMS event, no inline SMS (not on replay)',
    smsEvents.error || `events=${smsEvents.value.rows[0].c} inlineSms=${smsCalls.length - smsBefore}`);
  const stored = await safe(() => pool.query('SELECT source_event_reference AS r FROM notifications WHERE id = $1', [id1]));
  expect(!stored.error && stored.value.rows[0] && stored.value.rows[0].r === ref,
    'source_event_reference persisted', stored.error || JSON.stringify(stored.value.rows));

  // Different references -> different rows.
  const b = await makeUser();
  const b1 = await createNotification(b.id, { title: 'T', body: 'x', sourceEventReference: `${ref}-1` });
  const b2 = await createNotification(b.id, { title: 'T', body: 'x', sourceEventReference: `${ref}-2` });
  expect(b1 && b2 && b1 !== b2 && (await countFor(b.id)) === 2, 'different references -> two rows', `${b1}/${b2}`);

  // NULL references never collide (legacy behaviour).
  const c = await makeUser();
  const c1 = await createNotification(c.id, { title: 'T', body: 'same' });
  const c2 = await createNotification(c.id, { title: 'T', body: 'same' });
  expect(c1 && c2 && c1 !== c2 && (await countFor(c.id)) === 2, 'two NULL-reference notifications -> two rows', `${c1}/${c2}`);

  // Same reference, different users -> separate rows (index is per user).
  const d1u = await makeUser();
  const d2u = await makeUser();
  const shared = `${ref}-shared`;
  const d1 = await createNotification(d1u.id, { title: 'T', body: 'x', sourceEventReference: shared });
  const d2 = await createNotification(d2u.id, { title: 'T', body: 'x', sourceEventReference: shared });
  expect(d1 && d2 && d1 !== d2 && (await countFor(d1u.id)) === 1 && (await countFor(d2u.id)) === 1,
    'same reference for two users -> one row each', `${d1}/${d2}`);

  // client (tx) is honoured: rollback leaves nothing, commit persists.
  const e = await makeUser();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eid = await createNotification(e.id, { title: 'T', body: 'tx', sourceEventReference: `${ref}-tx`, client });
    expect(eid !== null, 'insert inside tx returns id', eid);
    await client.query('ROLLBACK');
    expect((await countFor(e.id)) === 0, 'tx rollback -> no notification', await countFor(e.id));
    await client.query('BEGIN');
    await createNotification(e.id, { title: 'T', body: 'tx', sourceEventReference: `${ref}-tx`, client });
    await client.query('COMMIT');
    expect((await countFor(e.id)) === 1, 'tx commit -> one notification', await countFor(e.id));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  section('2b. sourceEventReference length guard (VARCHAR(200), counted in characters)');
  const g = await makeUser();
  const at200 = await safe(() => createNotification(g.id, { title: 'T', body: 'len', sourceEventReference: 'A'.repeat(200) }));
  expect(!at200.error && at200.value, 'exactly 200 ASCII characters -> accepted', at200.error || at200.value);
  const multi = await safe(() => createNotification(g.id, { title: 'T', body: 'len', sourceEventReference: 'é'.repeat(200) }));
  expect(!multi.error && multi.value, '200 multi-byte characters -> accepted (code points, not bytes)', multi.error || multi.value);
  const before201 = await countFor(g.id);
  const over = await safe(() => createNotification(g.id, { title: 'T', body: 'len', sourceEventReference: 'B'.repeat(201) }));
  expect(over.error && /^sourceEventReference exceeds 200 characters \(got 201\)$/.test(over.error),
    '201 characters -> throws a clear error (not null)', over.error || `returned ${over.value}`);
  expect((await countFor(g.id)) === before201, '201 characters -> no row written', await countFor(g.id));
}

async function testDispatcherPassesIds() {
  section('3. Dispatcher passes referenceId and eventId to the handler');
  let seen = null;
  outbox.registerHandler('P71B_CAPTURE', async (args) => { seen = args; });
  const reference = `P71B-CAP-${tag}`;
  const q = await outbox.enqueueOutbox({ eventType: 'P71B_CAPTURE', reference, payload: { k: 1 } });
  await pool.query(
    `UPDATE outbox_events SET status = 'DELIVERED' WHERE status IN ('PENDING','PROCESSING') AND reference_id <> $1`,
    [reference]
  );
  await outbox.dispatchOutbox({ batchSize: 50 });
  expect(seen !== null, 'handler invoked');
  expect(seen && seen.referenceId === reference, 'referenceId passed', seen && seen.referenceId);
  expect(seen && String(seen.eventId) === String(q.id), 'eventId passed', seen && seen.eventId);
  expect(seen && seen.eventType === 'P71B_CAPTURE' && seen.payload && seen.payload.k === 1,
    'eventType and payload still passed');
}

async function testHandlers() {
  section('4. Notifying handlers: same referenceId twice -> one notification, no error');
  const h = new Map();
  registerAll({ registerHandler: (n, f) => h.set(n, f) });

  const merchantUser = await makeUser();
  const m = await pool.query(
    'INSERT INTO merchants (user_id, name, phone) VALUES ($1, $2, $3) RETURNING id',
    [merchantUser.id, `P71B Merchant ${tag}`, merchantUser.phone]
  );
  const vicobaUser = await makeUser();
  const testUser = await makeUser();
  const revOwner = await makeUser();
  const divOwner = await makeUser();
  const revProject = (await pool.query('INSERT INTO projects (owner_user_id, name) VALUES ($1, $2) RETURNING id', [revOwner.id, `P71B Rev ${tag}`])).rows[0].id;
  const divProject = (await pool.query('INSERT INTO projects (owner_user_id, name) VALUES ($1, $2) RETURNING id', [divOwner.id, `P71B Div ${tag}`])).rows[0].id;

  const cases = [
    { type: 'MERCHANT_PAYOUT_EXECUTED', user: merchantUser.id, payload: { merchantId: m.rows[0].id, reference: 'R' } },
    { type: 'VICOBA_LOAN_APPROVED', user: vicobaUser.id, payload: { applicantUserId: vicobaUser.id, amount: 10 } },
    { type: 'OUTBOX_TEST', user: testUser.id, payload: { userId: testUser.id } },
    { type: 'PROJECT_REVENUE_PROCESSED', user: revOwner.id, payload: { projectId: revProject, amount: 10, reference: 'R', allocations: [] } },
    { type: 'PROJECT_DIVIDEND_PAID', user: divOwner.id, payload: { projectId: divProject, name: 'X', reference: 'R', paid: [] } },
  ];

  for (const c of cases) {
    const referenceId = `P71B-${c.type}-${tag}`;
    const args = { eventType: c.type, payload: c.payload, referenceId, eventId: 1 };
    const r1 = await safe(() => h.get(c.type)(args));
    const r2 = await safe(() => h.get(c.type)(args));
    expect(!r1.error, `${c.type}: first call succeeds`, r1.error);
    expect(!r2.error, `${c.type}: second call (same referenceId) does not throw`, r2.error);
    expect((await countFor(c.user)) === 1, `${c.type}: exactly one notification`, await countFor(c.user));
    const ref = await safe(() => pool.query(
      'SELECT source_event_reference AS r FROM notifications WHERE user_id = $1', [c.user]));
    const expected = `${referenceId}:u${c.user}`;
    expect(!ref.error && ref.value.rows.length === 1 && ref.value.rows[0].r === expected,
      `${c.type}: sourceEventReference = ${'${referenceId}:u${userId}'}`, ref.error || JSON.stringify(ref.value.rows));
  }

  // A different referenceId produces a new notification.
  const other = await safe(() => h.get('VICOBA_LOAN_APPROVED')({
    eventType: 'VICOBA_LOAN_APPROVED', payload: { applicantUserId: vicobaUser.id, amount: 10 },
    referenceId: `P71B-VICOBA-OTHER-${tag}`, eventId: 2,
  }));
  expect(!other.error && (await countFor(vicobaUser.id)) === 2, 'different referenceId -> second notification',
    other.error || await countFor(vicobaUser.id));

  // A notifying handler without referenceId fails loudly instead of silently dropping idempotency.
  const noRef = await safe(() => h.get('OUTBOX_TEST')({ eventType: 'OUTBOX_TEST', payload: { userId: testUser.id } }));
  expect(noRef.error && /referenceId is required/.test(noRef.error), 'missing referenceId -> throws', noRef.error);

  // A referenceId that makes `${referenceId}:u${userId}` exceed 200 characters fails clearly.
  const testBefore = await countFor(testUser.id);
  const tooLong = await safe(() => h.get('OUTBOX_TEST')({
    eventType: 'OUTBOX_TEST', payload: { userId: testUser.id }, referenceId: 'X'.repeat(199), eventId: 3,
  }));
  expect(tooLong.error && /^OUTBOX_TEST: sourceEventReference exceeds 200 characters \(got \d+\)$/.test(tooLong.error),
    'handler: over-long sourceEventReference -> clear error', tooLong.error);
  expect((await countFor(testUser.id)) === testBefore, 'handler: over-long reference -> no notification written',
    await countFor(testUser.id));

  section('5. End-to-end: redelivered outbox event does not duplicate the notification');
  registerAll(outbox);
  const u = await makeUser();
  const reference = `P71B-E2E-${tag}`;
  const q = await outbox.enqueueOutbox({ eventType: 'VICOBA_LOAN_APPROVED', reference, payload: { applicantUserId: u.id, amount: 5 } });
  const s1 = await outbox.dispatchOutbox({ batchSize: 50 });
  // Simulate a redelivery (e.g. acknowledgement lost, lease expired).
  await pool.query(
    `UPDATE outbox_events SET status = 'PENDING', next_attempt_at = NOW() - INTERVAL '1 second',
            lease_token = NULL, locked_until = NULL WHERE id = $1`, [q.id]
  );
  const s2 = await outbox.dispatchOutbox({ batchSize: 50 });
  const row = (await pool.query('SELECT status, last_error FROM outbox_events WHERE id = $1', [q.id])).rows[0];
  expect(s1.delivered >= 1 && s2.delivered >= 1 && row.status === 'DELIVERED',
    'both deliveries succeed', JSON.stringify({ s1, s2, row }));
  expect((await countFor(u.id)) === 1, 'exactly one notification after redelivery', await countFor(u.id));
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

    const silenced = console.error;
    console.error = () => {};
    try {
      for (const t of [testMigration, testCreateNotification, testDispatcherPassesIds, testHandlers]) {
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
