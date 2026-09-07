/* ============================================================
 * AFRIKOBA GLOBAL - DEVICE SECURITY & ANTI-FRAUD BINDING
 * Migration 092: users.device_policy (PERMISSIVE | TRUSTED_ONLY)
 * + trusted_devices.is_trusted; x-device-fingerprint aware trust
 * resolution; per-device rate limiter (sliding window).
 * This suite proves:
 *  - PERMISSIVE users move money without a device binding
 *  - TRUSTED_ONLY users are blocked on unregistered/unknown devices
 *  - registering the device (POST /api/devices) unlocks money moves
 *  - revoking or deleting a device re-blocks immediately
 *  - device policy validation + RBAC (unauthenticated -> 401)
 *  - the per-device rate limiter refuses beyond MAX (direct unit)
 * ============================================================ */
const BASE = process.env.DEVICE_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');
const { createDeviceRateLimiter } = require('../src/middleware/deviceRateLimit');

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

const DEVICE_A = 'a'.repeat(64);
const DEVICE_B = 'b'.repeat(64);

async function api(method, path, token, body, headers = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  Object.assign(h, headers);
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers: h,
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
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.user) throw new Error(`register ${phoneNumber} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}
async function seedWallet(userId, amount, reference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({ client, userId, amount, reference, fromAccount: 'SUSPENSE', description: 'Device test seed' });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function run() {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90) + 10}`;

  await section('Setup: users + wallets');
  const sender = await register(`255901${suffix}`, 'Device Sender');
  const recipient = await register(`255902${suffix}`, 'Device Recipient');
  await seedWallet(sender.user.id, 200000, `DEV-SEED-${suffix}`);
  const token = sender.token;

  await section('PERMISSIVE baseline: transfer works without device binding');
  const permissive = await api('POST', '/api/wallet/transfer', token, {
    toPhoneNumber: recipient.user.phone_number, amount: 10000, note: 'permissive baseline',
  });
  await expect(permissive.status === 200 && permissive.data.success !== false,
    `PERMISSIVE transfer allowed (got ${permissive.status})`);

  await section('TRUSTED_ONLY: unknown devices blocked on transfer');
  const setPolicy = await api('PUT', '/api/devices/policy', token, { policy: 'TRUSTED_ONLY' });
  await expect(setPolicy.status === 200 && setPolicy.data.devicePolicy === 'TRUSTED_ONLY',
    `policy set TRUSTED_ONLY (got ${setPolicy.status})`);

  const noHeader = await api('POST', '/api/wallet/transfer', token, {
    toPhoneNumber: recipient.user.phone_number, amount: 10000, note: 'no device',
  });
  await expect(noHeader.status === 403 && noHeader.data.code === 'DEVICE_NOT_TRUSTED',
    `no-device blocked 403 (got ${noHeader.status} ${noHeader.data.code})`);

  const unknownHeader = await api('POST', '/api/wallet/transfer', token, {
    toPhoneNumber: recipient.user.phone_number, amount: 10000, note: 'unknown device',
  }, { 'x-device-fingerprint': DEVICE_A });
  await expect(unknownHeader.status === 403 && unknownHeader.data.code === 'DEVICE_NOT_TRUSTED',
    `registered-but-by-body blocked 403 (got ${unknownHeader.status} ${unknownHeader.data.code})`);

  await section('Register device unlocks money movement');
  const reg = await api('POST', '/api/devices', token, { deviceName: 'Test Mobile' }, { 'x-device-fingerprint': DEVICE_A });
  await expect(reg.status === 201 && reg.data.device.device_fingerprint === DEVICE_A,
    `device registered (got ${reg.status} ${reg.data.device && reg.data.device.device_fingerprint})`);

  const allowed = await api('POST', '/api/wallet/transfer', token, {
    toPhoneNumber: recipient.user.phone_number, amount: 10000, note: 'trusted device',
  }, { 'x-device-fingerprint': DEVICE_A });
  await expect(allowed.status === 200 && allowed.data.success !== false,
    `trusted-device transfer allowed (got ${allowed.status})`);

  const list = await api('GET', '/api/devices', token);
  const registered = (list.data.devices || []).find((d) => d.device_fingerprint === DEVICE_A);
  await expect(!!registered && registered.is_trusted === true, `GET /devices lists trusted device`);

  await section('Revoke device -> immediately blocked');
  await expect(!!registered, `resolved device id for revocation`);
  const revoke = await api('PUT', `/api/devices/${registered.id}/trust`, token, { trusted: false });
  await expect(revoke.status === 200 && revoke.data.device.is_trusted === false, `device revoked (got ${revoke.status})`);

  const revokedBlock = await api('POST', '/api/wallet/transfer', token, {
    toPhoneNumber: recipient.user.phone_number, amount: 10000, note: 'revoked device',
  }, { 'x-device-fingerprint': DEVICE_A });
  await expect(revokedBlock.status === 403 && revokedBlock.data.code === 'DEVICE_NOT_TRUSTED',
    `revoked device blocked 403 (got ${revokedBlock.status} ${revokedBlock.data.code})`);

  await section('Re-trust + forget the device');
  const retrust = await api('PUT', `/api/devices/${registered.id}/trust`, token, { trusted: true });
  await expect(retrust.status === 200, `device re-trusted`);
  const regained = await api('POST', '/api/wallet/transfer', token, {
    toPhoneNumber: recipient.user.phone_number, amount: 10000, note: 're-trusted device',
  }, { 'x-device-fingerprint': DEVICE_A });
  await expect(regained.status === 200, `re-trusted transfer allowed (got ${regained.status})`);

  const del = await api('DELETE', `/api/devices/${registered.id}`, token);
  await expect(del.status === 200 && del.data.removed === true, `device deleted (got ${del.status})`);
  const afterDelete = await api('POST', '/api/wallet/transfer', token, {
    toPhoneNumber: recipient.user.phone_number, amount: 10000, note: 'deleted device',
  }, { 'x-device-fingerprint': DEVICE_A });
  await expect(afterDelete.status === 403 && afterDelete.data.code === 'DEVICE_NOT_TRUSTED',
    `deleted device blocked 403 (got ${afterDelete.status} ${afterDelete.data.code})`);

  await section('Policy validation + RBAC');
  const bad = await api('PUT', '/api/devices/policy', token, { policy: 'CYBER' });
  await expect(bad.status === 400 && bad.data.code === 'DEVICE_POLICY_INVALID',
    `invalid policy refused (got ${bad.status} ${bad.data.code})`);
  const anon = await api('GET', '/api/devices', null);
  await expect(anon.status === 401, `unauthenticated /devices -> 401 (got ${anon.status})`);
  const anonTransfer = await api('POST', '/api/wallet/transfer', null, {
    toPhoneNumber: recipient.user.phone_number, amount: 10000, note: 'anon',
  });
  await expect(anonTransfer.status === 401, `unauthenticated transfer -> 401 (got ${anonTransfer.status})`);

  await section('Per-device rate limiter (unit)');
  const limit = createDeviceRateLimiter({ max: 3, windowMs: 60000 });
  let nextCalls = 0;
  let hitStatus = null;
  let hitCode = null;
  const mkRes = () => ({
    status: (s) => { hitStatus = s; return { json: (b) => { hitCode = b.code; } }; },
  });
  const mkReq = () => ({
    ip: '127.0.0.1',
    headers: { 'user-agent': 'rate-test', 'accept-language': 'en', 'x-device-fingerprint': DEVICE_B },
  });
  for (let i = 0; i < 3; i++) {
    await limit(mkReq(), mkRes(), () => { nextCalls++; });
  }
  await expect(nextCalls === 3 && hitStatus === null, `3 requests pass (got ${nextCalls} next / ${hitStatus} status)`);
  await limit(mkReq(), mkRes(), () => { nextCalls++; });
  await expect(hitStatus === 429 && hitCode === 'DEVICE_RATE_LIMIT_EXCEEDED',
    `4th request refused 429 (got ${hitStatus} ${hitCode})`);

  // Restore policy so the test user is unblocked for future runs.
  await api('PUT', '/api/devices/policy', token, { policy: 'PERMISSIVE' });
}

run()
  .then(() => {
    console.log(`\nDEVICE SECURITY: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });