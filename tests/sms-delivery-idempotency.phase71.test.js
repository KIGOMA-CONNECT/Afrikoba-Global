#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step D: SMS delivery idempotency, no failover on UNKNOWN
 *
 *  1. Migration 148 (sms_deliveries) is idempotent, has no BEGIN/COMMIT, and
 *     stores no full phone number or SMS text.
 *  2. Error/response classification table (DEFINITE failure vs UNKNOWN).
 *  3. sendSMSIdempotent(key, phone, body):
 *     PENDING row committed before any provider call; SENT -> no resend;
 *     UNKNOWN -> no resend; stale PENDING -> UNKNOWN, no resend; FAILED ->
 *     explicit retry; timeout -> UNKNOWN with NO failover; 4xx -> failover;
 *     simulation recorded with simulated=true; concurrent calls send once.
 *  4. outboxService.NonRetryableError -> event DEAD at once (by class, not by
 *     message); ordinary errors keep the backoff retry policy.
 *  5. PROJECT_SPLIT_SMS uses sendSMSIdempotent(referenceId, ...); UNKNOWN ->
 *     DEAD with last_error 'SMS_DELIVERY_UNKNOWN...'; requeueDead does not resend.
 *
 * axios is stubbed: no real network. Run with a connection logger preload to
 * prove that only the local test database is contacted.
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix>.
 * Usage:
 *   DB_NAME=phase71_financial_audit_<suffix> DB_USER=... DB_PASSWORD=... \
 *     node tests/sms-delivery-idempotency.phase71.test.js
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
const realAxios = require('axios');
const { AxiosError } = realAxios;
const axiosPath = require.resolve('axios');
const httpCalls = [];
const behaviour = { beem: null, at: null, twilio: null };
function providerOf(url) {
  if (/beem\.africa/.test(url)) return 'beem';
  if (/africastalking\.com/.test(url)) return 'at';
  if (/twilio\.com/.test(url)) return 'twilio';
  return 'other:' + url;
}
const axiosStub = {
  post: async (url) => {
    const p = providerOf(url);
    httpCalls.push(p);
    const fn = behaviour[p];
    if (!fn) throw new Error(`TEST: no stub behaviour for ${p}`);
    return fn();
  },
  get: async () => { throw new Error('TEST: axios.get not expected'); },
};
require.cache[axiosPath].exports = axiosStub;

const config = require('../src/config');
const pool = require('../src/config/db');
const outbox = require('../src/services/outboxService');
const sms = require('../src/services/smsService');
const { registerAll } = require('../src/outbox/handlers');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '148_sms_deliveries.sql');
const tag = crypto.randomBytes(4).toString('hex');
const PHONE = '255712345678'; // Tanzania -> Beem primary
const BODY = `Habari P71D ${tag}, umepokea faida ya TZS 1,000.`;

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
async function safe(fn) { try { return { value: await fn() }; } catch (e) { return { error: e.message || String(e), err: e }; } }

// ---- provider response / error factories ---------------------------------
const ok200Beem = () => ({ status: 200, data: { successful: true, request_id: 777, code: 100, message: 'Message Submitted Successfully' } });
const ok201At = (code = 101) => ({ status: 201, data: { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode: code, status: 'X', messageId: 'ATXid_9' }] } } });
const ok201Twilio = () => ({ status: 201, data: { sid: 'SM0123', status: 'queued' } });
const netErr = (code, msg) => () => { throw new AxiosError(msg || code, code, {}, {}, undefined); };
const httpErr = (status) => () => {
  throw new AxiosError(`Request failed with status code ${status}`,
    status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', {}, {}, { status, data: { error: 'x' } });
};

let savedConfig;
function productionProviders() {
  savedConfig = { nodeEnv: config.nodeEnv, sms: JSON.parse(JSON.stringify(config.sms)) };
  config.nodeEnv = 'production';
  config.sms.beem = { ...config.sms.beem, apiKey: 'k', secretKey: 's', senderId: 'AFRIKOBA' };
  config.sms.at = { ...config.sms.at, apiKey: 'k', username: 'u', senderId: 'AFRIKOBA' };
  config.sms.twilio = { ...config.sms.twilio, accountSid: 'AC1', authToken: 't', from: '+15550000000' };
}
function restoreConfig() {
  if (!savedConfig) return;
  config.nodeEnv = savedConfig.nodeEnv;
  Object.assign(config.sms, savedConfig.sms);
}
function resetHttp(b) { httpCalls.length = 0; Object.assign(behaviour, { beem: null, at: null, twilio: null }, b); }
const count = (p) => httpCalls.filter((x) => x === p).length;
async function row(key) {
  return (await pool.query('SELECT * FROM sms_deliveries WHERE idempotency_key = $1', [key])).rows[0];
}
const key = (n) => `P71D-${tag}-${n}`;

// ---------------------------------------------------------------------------

async function testMigration() {
  section('1. Migration 148: idempotent, no BEGIN/COMMIT, no full phone / SMS text');
  const exists = fs.existsSync(MIGRATION);
  expect(exists, 'db/migrations/148_sms_deliveries.sql exists');
  if (!exists) return false;
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  expect(!/^\s*(BEGIN|COMMIT|START\s+TRANSACTION|ROLLBACK)\b/im.test(code), 'no BEGIN/COMMIT/ROLLBACK statements');
  expect(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+sms_deliveries/i.test(code), 'CREATE TABLE IF NOT EXISTS sms_deliveries');
  const a1 = await safe(() => pool.query(sql));
  const a2 = await safe(() => pool.query(sql));
  expect(!a1.error, 'apply #1 succeeds', a1.error);
  expect(!a2.error, 'apply #2 succeeds (idempotent)', a2.error);

  const cols = (await pool.query(
    `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'sms_deliveries'`
  )).rows;
  const names = cols.map((c) => c.column_name).sort();
  const expected = ['attempts', 'body_hash', 'created_at', 'id', 'idempotency_key', 'last_error', 'phone_hash',
    'phone_last4', 'provider', 'provider_message_id', 'simulated', 'status', 'updated_at'];
  expect(JSON.stringify(names) === JSON.stringify(expected), 'columns exactly as specified', names.join(','));
  expect(!names.some((n) => /^(phone|phone_number|body|message|text)$/.test(n)), 'no full phone / SMS text column');
  const keyNullable = cols.find((c) => c.column_name === 'idempotency_key');
  expect(keyNullable && keyNullable.is_nullable === 'NO', 'idempotency_key NOT NULL');
  const uniq = (await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'sms_deliveries' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(idempotency_key)%'`
  )).rows;
  expect(uniq.length >= 1, 'UNIQUE (idempotency_key)', JSON.stringify(uniq));
  const chk = (await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'sms_deliveries'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'`
  )).rows.map((r) => r.def).join(' ');
  expect(['PENDING', 'SENT', 'FAILED', 'UNKNOWN'].every((s) => chk.includes(`'${s}'`)), 'CHECK status IN (PENDING, SENT, FAILED, UNKNOWN)', chk);
  const badStatus = await safe(() => pool.query(
    `INSERT INTO sms_deliveries (idempotency_key, phone_hash, body_hash, status) VALUES ($1, 'x', 'y', 'BOGUS')`, [key('bogus')]));
  expect(badStatus.error && /check constraint/i.test(badStatus.error), 'CHECK rejects an unknown status', badStatus.error);
  return true;
}

function testClassification() {
  section('2. Classification table');
  const ce = sms.classifyAxiosError;
  const cr = sms.classifyProviderResponse;
  expect(typeof ce === 'function' && typeof cr === 'function', 'classifyAxiosError / classifyProviderResponse exported');
  if (typeof ce !== 'function' || typeof cr !== 'function') return;
  const err = (code, status) => new AxiosError('x', code, {}, {}, status ? { status, data: {} } : undefined);
  const table = [
    ['ECONNREFUSED', err('ECONNREFUSED'), 'DEFINITE'],
    ['ENOTFOUND', err('ENOTFOUND'), 'DEFINITE'],
    ['EAI_AGAIN (DNS)', err('EAI_AGAIN'), 'DEFINITE'],
    ['HTTP 400', err('ERR_BAD_REQUEST', 400), 'DEFINITE'],
    ['HTTP 401', err('ERR_BAD_REQUEST', 401), 'DEFINITE'],
    ['HTTP 429', err('ERR_BAD_REQUEST', 429), 'DEFINITE'],
    ['HTTP 408 (Request Timeout)', err('ERR_BAD_REQUEST', 408), 'UNKNOWN'],
    ['ECONNABORTED (axios timeout)', err('ECONNABORTED'), 'UNKNOWN'],
    ['ETIMEDOUT', err('ETIMEDOUT'), 'UNKNOWN'],
    ['ECONNRESET', err('ECONNRESET'), 'UNKNOWN'],
    ['socket hang up (ECONNRESET, no response)', new AxiosError('socket hang up', 'ECONNRESET', {}, {}, undefined), 'UNKNOWN'],
    ['EPIPE', err('EPIPE'), 'UNKNOWN'],
    ['EHOSTUNREACH', err('EHOSTUNREACH'), 'UNKNOWN'],
    ['HTTP 500', err('ERR_BAD_RESPONSE', 500), 'UNKNOWN'],
    ['HTTP 502', err('ERR_BAD_RESPONSE', 502), 'UNKNOWN'],
    ['HTTP 503', err('ERR_BAD_RESPONSE', 503), 'UNKNOWN'],
    ['HTTP 504', err('ERR_BAD_RESPONSE', 504), 'UNKNOWN'],
    ['unrecognised code', err('ESOMETHINGNEW'), 'UNKNOWN'],
    ['non-axios Error', new Error('boom'), 'UNKNOWN'],
  ];
  for (const [label, e, want] of table) {
    const got = ce(e);
    expect(got && got.outcome === want, `error ${label} -> ${want}`, JSON.stringify(got));
  }
  const resp = [
    ['beem 200 successful', 'beem', ok200Beem(), 'SENT'],
    ['beem 200 successful=false', 'beem', { status: 200, data: { successful: false, code: 111 } }, 'DEFINITE'],
    ['beem 202 (unexpected 2xx)', 'beem', { status: 202, data: {} }, 'UNKNOWN'],
    ['AT 201 statusCode 100 Processed', 'at', ok201At(100), 'SENT'],
    ['AT 201 statusCode 101 Sent', 'at', ok201At(101), 'SENT'],
    ['AT 201 statusCode 102 Queued', 'at', ok201At(102), 'SENT'],
    ...[401, 402, 403, 404, 405, 406, 407, 409, 502].map((c) => [`AT 201 statusCode ${c} (rejection)`, 'at', ok201At(c), 'DEFINITE']),
    ['AT 201 statusCode 500 InternalServerError', 'at', ok201At(500), 'UNKNOWN'],
    ['AT 201 statusCode 501 GatewayError', 'at', ok201At(501), 'UNKNOWN'],
    ['AT 201 unrecognised statusCode 999', 'at', ok201At(999), 'UNKNOWN'],
    ['AT 201 without Recipients', 'at', { status: 201, data: { SMSMessageData: { Message: 'x', Recipients: [] } } }, 'UNKNOWN'],
    ['twilio 201 with sid', 'twilio', ok201Twilio(), 'SENT'],
    ['twilio 200 without sid', 'twilio', { status: 200, data: {} }, 'UNKNOWN'],
  ];
  for (const [label, p, r, want] of resp) {
    const got = cr(p, r);
    expect(got && got.outcome === want, `response ${label} -> ${want}`, JSON.stringify(got));
  }
}

async function testSendIdempotent() {
  section('3. sendSMSIdempotent');
  const send = sms.sendSMSIdempotent;
  expect(typeof send === 'function', 'sendSMSIdempotent exported');
  if (typeof send !== 'function') return;
  productionProviders();
  try {
    // 3a. Beem timeout -> UNKNOWN, no AT / Twilio call.
    resetHttp({ beem: netErr('ECONNABORTED', 'timeout of 15000ms exceeded'), at: () => ok201At(), twilio: ok201Twilio });
    const r1 = await safe(() => send(key('timeout'), PHONE, BODY));
    expect(r1.value && r1.value.status === 'UNKNOWN', 'Beem timeout -> status UNKNOWN', r1.error || JSON.stringify(r1.value));
    expect(count('beem') === 1 && count('at') === 0 && count('twilio') === 0, 'no failover to AT / Twilio', httpCalls.join(','));
    const t = await row(key('timeout'));
    expect(t && t.status === 'UNKNOWN' && t.provider === 'beem', 'row UNKNOWN, provider beem', JSON.stringify(t));

    // 3b. UNKNOWN key is not resent.
    resetHttp({ beem: ok200Beem, at: () => ok201At(), twilio: ok201Twilio });
    const r1b = await safe(() => send(key('timeout'), PHONE, BODY));
    expect(r1b.value && r1b.value.status === 'UNKNOWN' && httpCalls.length === 0, 'key with UNKNOWN -> nothing sent', JSON.stringify(r1b.value) + ' calls=' + httpCalls.join(','));

    // 3c. Beem 400 -> AT -> SENT.
    resetHttp({ beem: httpErr(400), at: () => ok201At(101), twilio: ok201Twilio });
    const r2 = await safe(() => send(key('b400'), PHONE, BODY));
    expect(r2.value && r2.value.status === 'SENT' && r2.value.provider === 'at', 'Beem 400 -> failover -> SENT via AT', r2.error || JSON.stringify(r2.value));
    expect(count('beem') === 1 && count('at') === 1 && count('twilio') === 0, 'calls: beem 1, at 1, twilio 0', httpCalls.join(','));
    const s = await row(key('b400'));
    expect(s && s.status === 'SENT' && s.provider === 'at' && s.provider_message_id === 'ATXid_9' && s.simulated === false,
      'row SENT, provider at, provider_message_id recorded, simulated=false', JSON.stringify(s));

    // 3d. Same key after SENT -> nothing sent.
    resetHttp({ beem: ok200Beem, at: () => ok201At(), twilio: ok201Twilio });
    const r3 = await safe(() => send(key('b400'), PHONE, BODY));
    expect(r3.value && r3.value.status === 'SENT' && r3.value.duplicate === true && httpCalls.length === 0,
      'same key after SENT -> duplicate, no HTTP call', JSON.stringify(r3.value) + ' calls=' + httpCalls.join(','));

    // 3e. No full phone / SMS text stored.
    const raw = JSON.stringify(s);
    expect(!raw.includes(PHONE) && !raw.includes('712345678') && !raw.includes(BODY) && !raw.includes(tag + ', umepokea'),
      'row contains no full phone number or SMS text', raw);
    expect(s.phone_last4 === '5678' && /^[0-9a-f]{64}$/.test(s.phone_hash) && /^[0-9a-f]{64}$/.test(s.body_hash),
      'phone_last4 + sha256 hashes only', `${s.phone_last4} ${s.phone_hash} ${s.body_hash}`);

    // 3f. Stale PENDING (process died) -> UNKNOWN, not sent.
    await pool.query(
      `INSERT INTO sms_deliveries (idempotency_key, phone_hash, phone_last4, body_hash, status, attempts, created_at, updated_at)
       VALUES ($1, $2, '5678', $3, 'PENDING', 1, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')`,
      [key('stale'), sms._hash(sms._normalizePhone(PHONE)), sms._hash(BODY)]
    );
    resetHttp({ beem: ok200Beem, at: () => ok201At(), twilio: ok201Twilio });
    const r4 = await safe(() => send(key('stale'), PHONE, BODY));
    expect(r4.value && r4.value.status === 'UNKNOWN' && httpCalls.length === 0, 'stale PENDING -> UNKNOWN, nothing sent',
      (r4.error || JSON.stringify(r4.value)) + ' calls=' + httpCalls.join(','));
    const st = await row(key('stale'));
    expect(st && st.status === 'UNKNOWN', 'stale PENDING row marked UNKNOWN', st && st.status);

    // 3g. Every provider definitely fails -> FAILED; explicit retry allowed afterwards.
    resetHttp({ beem: netErr('ECONNREFUSED'), at: () => ok201At(403), twilio: httpErr(400) });
    const r5 = await safe(() => send(key('allfail'), PHONE, BODY));
    expect(r5.value && r5.value.status === 'FAILED', 'all definite failures -> FAILED', r5.error || JSON.stringify(r5.value));
    expect(count('beem') === 1 && count('at') === 1 && count('twilio') === 1, 'definite failures fail over through the chain', httpCalls.join(','));
    resetHttp({ beem: ok200Beem, at: () => ok201At(), twilio: ok201Twilio });
    const r6 = await safe(() => send(key('allfail'), PHONE, BODY));
    const f2 = await row(key('allfail'));
    expect(r6.value && r6.value.status === 'SENT' && count('beem') === 1 && f2.attempts === 2,
      'FAILED key -> explicit new attempt -> SENT (attempts 2)', (r6.error || JSON.stringify(r6.value)) + ` attempts=${f2 && f2.attempts}`);

    // 3h. AT recipient statusCode 500 -> UNKNOWN, no Twilio.
    resetHttp({ beem: httpErr(400), at: () => ok201At(500), twilio: ok201Twilio });
    const r7 = await safe(() => send(key('at500'), PHONE, BODY));
    expect(r7.value && r7.value.status === 'UNKNOWN' && count('twilio') === 0, 'AT statusCode 500 -> UNKNOWN, no Twilio', JSON.stringify(r7.value) + ' ' + httpCalls.join(','));

    // 3i. Beem HTTP 503 -> UNKNOWN, no failover.
    resetHttp({ beem: httpErr(503), at: () => ok201At(), twilio: ok201Twilio });
    const r8 = await safe(() => send(key('b503'), PHONE, BODY));
    expect(r8.value && r8.value.status === 'UNKNOWN' && httpCalls.length === 1, 'Beem 503 -> UNKNOWN, no failover', JSON.stringify(r8.value) + ' ' + httpCalls.join(','));

    // 3i-bis. Beem HTTP 408 -> UNKNOWN, no failover.
    resetHttp({ beem: httpErr(408), at: () => ok201At(), twilio: ok201Twilio });
    const r8b = await safe(() => send(key('b408'), PHONE, BODY));
    expect(r8b.value && r8b.value.status === 'UNKNOWN' && httpCalls.length === 1, 'Beem 408 -> UNKNOWN, no failover', JSON.stringify(r8b.value) + ' ' + httpCalls.join(','));

    // 3m. PENDING is committed BEFORE the provider call: while the stubbed axios
    // call is still in flight, a separate DB connection already sees the row.
    let releaseOne;
    const gateOne = new Promise((r) => { releaseOne = r; });
    resetHttp({ beem: async () => { await gateOne; return ok200Beem(); }, at: () => ok201At(), twilio: ok201Twilio });
    const inflight = safe(() => send(key('commit-first'), PHONE, BODY));
    for (let i = 0; i < 100 && httpCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const observer = await pool.connect();
    let seen;
    try {
      seen = (await observer.query(
        'SELECT status, attempts, pg_backend_pid() AS pid FROM sms_deliveries WHERE idempotency_key = $1', [key('commit-first')]
      )).rows[0];
    } finally {
      observer.release();
    }
    expect(httpCalls.length === 1 && count('beem') === 1, 'provider call is in flight (stub awaiting release)', httpCalls.join(','));
    expect(seen && seen.status === 'PENDING' && seen.attempts === 1,
      'separate connection sees committed PENDING row during the provider call', JSON.stringify(seen));
    releaseOne();
    const doneOne = await inflight;
    expect(doneOne.value && doneOne.value.status === 'SENT', 'in-flight call completes as SENT', doneOne.error || JSON.stringify(doneOne.value));

    // 3j. Key reused with a different body -> error, nothing sent.
    resetHttp({ beem: ok200Beem, at: () => ok201At(), twilio: ok201Twilio });
    const r9 = await safe(() => send(key('b400'), PHONE, BODY + ' (changed)'));
    expect(r9.error && /idempotency key reused/i.test(r9.error) && httpCalls.length === 0, 'key reused with different body -> error, nothing sent', r9.error);

    // 3k. Concurrent calls for one key -> one provider call.
    let release;
    const gate = new Promise((r) => { release = r; });
    resetHttp({ beem: async () => { await gate; return ok200Beem(); }, at: () => ok201At(), twilio: ok201Twilio });
    const p1 = safe(() => send(key('race'), PHONE, BODY));
    const p2 = safe(() => send(key('race'), PHONE, BODY));
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [c1, c2] = await Promise.all([p1, p2]);
    const statuses = [c1.value && c1.value.status, c2.value && c2.value.status].sort();
    expect(count('beem') === 1 && httpCalls.length === 1, 'two concurrent calls -> exactly one provider call', httpCalls.join(','));
    expect(!c1.error && !c2.error, 'neither concurrent caller errors', JSON.stringify([c1.error, c2.error]));
    expect(JSON.stringify(statuses) === JSON.stringify(['PENDING', 'SENT']), 'one SENT, the other sees in-flight PENDING', JSON.stringify([c1, c2]));
    const rr = await row(key('race'));
    expect(rr && rr.status === 'SENT' && rr.attempts === 1, 'race row SENT, attempts 1', JSON.stringify(rr));
  } finally {
    restoreConfig();
  }

  // 3l. Non-production simulation -> SENT, simulated=true, no HTTP.
  resetHttp({});
  const r10 = await safe(() => send(key('sim'), PHONE, BODY));
  const sim = await row(key('sim'));
  expect(r10.value && r10.value.status === 'SENT' && r10.value.simulated === true && httpCalls.length === 0,
    'non-production -> simulated SENT, no HTTP', r10.error || JSON.stringify(r10.value));
  expect(sim && sim.status === 'SENT' && sim.simulated === true, 'row SENT with simulated=true', JSON.stringify(sim));
}

async function testNonRetryable() {
  section('4. Outbox: NonRetryableError -> DEAD at once; ordinary error -> backoff');
  const NRE = outbox.NonRetryableError;
  expect(typeof NRE === 'function', 'outboxService exports NonRetryableError');
  if (typeof NRE !== 'function') return;
  await pool.query(`UPDATE outbox_events SET status = 'DELIVERED' WHERE status IN ('PENDING','PROCESSING')`);
  outbox.registerHandler('P71D_NRE', async () => { throw new NRE('SMS_DELIVERY_UNKNOWN', 'test non-retryable'); });
  outbox.registerHandler('P71D_PLAIN', async () => { throw new Error('SMS_DELIVERY_UNKNOWN: plain error with the same text'); });
  const a = await outbox.enqueueOutbox({ eventType: 'P71D_NRE', reference: key('nre'), payload: {} });
  const b = await outbox.enqueueOutbox({ eventType: 'P71D_PLAIN', reference: key('plain'), payload: {} });
  const s = await outbox.dispatchOutbox({ batchSize: 50 });
  const ra = (await pool.query('SELECT * FROM outbox_events WHERE id = $1', [a.id])).rows[0];
  const rb = (await pool.query('SELECT * FROM outbox_events WHERE id = $1', [b.id])).rows[0];
  expect(ra.status === 'DEAD' && ra.attempts === 1, 'NonRetryableError -> DEAD after 1 attempt (max_attempts 5)', `${ra.status}/${ra.attempts}`);
  expect(/^SMS_DELIVERY_UNKNOWN/.test(ra.last_error || ''), "last_error starts with 'SMS_DELIVERY_UNKNOWN'", ra.last_error);
  expect(rb.status === 'PENDING' && rb.attempts === 1 && new Date(rb.next_attempt_at) > new Date(),
    'ordinary Error with identical text -> PENDING + backoff (class, not message)', `${rb.status}/${rb.attempts}`);
  expect(s.dead >= 1 && s.failed >= 1, 'summary counts dead and failed', JSON.stringify(s));
}

async function testSplitHandler() {
  section('5. PROJECT_SPLIT_SMS via sendSMSIdempotent; UNKNOWN -> DEAD; requeueDead does not resend');
  registerAll(outbox);
  await pool.query(`UPDATE outbox_events SET status = 'DELIVERED' WHERE status IN ('PENDING','PROCESSING')`);
  productionProviders();
  try {
    // UNKNOWN path
    resetHttp({ beem: netErr('ETIMEDOUT'), at: () => ok201At(), twilio: ok201Twilio });
    const ref = `PROJECT_SPLIT_SMS:${tag}:UNKNOWN`;
    const q = await outbox.enqueueOutbox({ eventType: 'PROJECT_SPLIT_SMS', reference: ref, payload: { phone: PHONE, body: BODY } });
    await outbox.dispatchOutbox({ batchSize: 50 });
    const ev = (await pool.query('SELECT * FROM outbox_events WHERE id = $1', [q.id])).rows[0];
    const d = await row(ref);
    expect(count('beem') === 1 && httpCalls.length === 1, 'one provider call (no failover)', httpCalls.join(','));
    expect(ev.status === 'DEAD' && ev.attempts === 1 && /^SMS_DELIVERY_UNKNOWN/.test(ev.last_error || ''),
      'event DEAD at once, last_error SMS_DELIVERY_UNKNOWN', `${ev.status}/${ev.attempts}/${ev.last_error}`);
    expect(d && d.status === 'UNKNOWN', 'sms_deliveries keyed by outbox referenceId is UNKNOWN', JSON.stringify(d));

    // requeueDead -> dispatcher -> no resend, DEAD again
    resetHttp({ beem: ok200Beem, at: () => ok201At(), twilio: ok201Twilio });
    await pool.query(`UPDATE outbox_events SET status = 'DELIVERED' WHERE status = 'DEAD' AND id <> $1`, [q.id]);
    const rq = await outbox.requeueDead(100);
    await outbox.dispatchOutbox({ batchSize: 50 });
    const ev2 = (await pool.query('SELECT * FROM outbox_events WHERE id = $1', [q.id])).rows[0];
    expect(rq.requeued >= 1, 'requeueDead requeued the event', JSON.stringify(rq));
    expect(httpCalls.length === 0, 'after requeueDead: no SMS sent', httpCalls.join(','));
    expect(ev2.status === 'DEAD' && /^SMS_DELIVERY_UNKNOWN/.test(ev2.last_error || ''), 'event DEAD again (UNKNOWN found, stopped)', `${ev2.status}/${ev2.last_error}`);

    // SENT path
    resetHttp({ beem: ok200Beem, at: () => ok201At(), twilio: ok201Twilio });
    const ref2 = `PROJECT_SPLIT_SMS:${tag}:SENT`;
    const q2 = await outbox.enqueueOutbox({ eventType: 'PROJECT_SPLIT_SMS', reference: ref2, payload: { phone: PHONE, body: BODY } });
    await outbox.dispatchOutbox({ batchSize: 50 });
    const ev3 = (await pool.query('SELECT status FROM outbox_events WHERE id = $1', [q2.id])).rows[0];
    const d2 = await row(ref2);
    expect(ev3.status === 'DELIVERED' && d2 && d2.status === 'SENT' && count('beem') === 1, 'success -> DELIVERED, sms row SENT', `${ev3.status}/${d2 && d2.status}`);

    // FAILED path -> ordinary retry
    resetHttp({ beem: httpErr(400), at: () => ok201At(403), twilio: httpErr(400) });
    const ref3 = `PROJECT_SPLIT_SMS:${tag}:FAILED`;
    const q3 = await outbox.enqueueOutbox({ eventType: 'PROJECT_SPLIT_SMS', reference: ref3, payload: { phone: PHONE, body: BODY } });
    await outbox.dispatchOutbox({ batchSize: 50 });
    const ev4 = (await pool.query('SELECT status, attempts FROM outbox_events WHERE id = $1', [q3.id])).rows[0];
    expect(ev4.status === 'PENDING' && ev4.attempts === 1, 'definite failure -> ordinary retry (PENDING + backoff)', JSON.stringify(ev4));
  } finally {
    restoreConfig();
  }
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

    const quiet = { error: console.error, warn: console.warn, info: console.info, log: console.log };
    const migrated = await testMigration();
    testClassification();
    const run = migrated
      ? [testSendIdempotent, testNonRetryable, testSplitHandler]
      : [testNonRetryable];
    if (!migrated) bad('sections 3 and 5 skipped: migration 148 missing');
    for (const t of run) {
      console.error = () => {};
      const res = await safe(t);
      console.error = quiet.error;
      if (res.error) bad(`${t.name} aborted`, res.error);
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
