'use strict';
/**
 * Phase 68 — webhook guard unit tests (no DB, no network).
 * Verifies the constant-time secret comparison, fail-closed production mode and
 * the IP allowlist / CIDR handling used for AzamPay callbacks.
 */
const assert = require('node:assert/strict');
const path = require('path');
const config = require(path.join(__dirname, '..', 'src/config'));
const { verifyWebhookSecurity } = require(path.join(__dirname, '..', 'src/middleware/webhookGuard'));

const saved = {
  nodeEnv: config.nodeEnv,
  secret: config.webhook.secret,
  allowedIps: config.webhook.allowedIps,
};

function run({ headers = {}, ip = '198.51.100.9', nodeEnv = 'production', secret, allowedIps } = {}) {
  config.nodeEnv = nodeEnv;
  if (secret !== undefined) config.webhook.secret = secret;
  if (allowedIps !== undefined) config.webhook.allowedIps = allowedIps;
  let status = null;
  let nextCalled = false;
  const res = {
    status(s) { status = s; return this; },
    json() { return this; },
  };
  const req = { headers, ip, socket: { remoteAddress: ip } };
  verifyWebhookSecurity(req, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

const cases = [];
const check = (name, fn) => cases.push({ name, fn });
const expect = (label, result, want) => {
  if (want.nextCalled !== undefined) {
    assert.strictEqual(result.nextCalled, want.nextCalled, `${label}: nextCalled`);
  }
  if (want.status !== undefined) {
    assert.strictEqual(result.status, want.status, `${label}: status`);
  }
};

check('missing secret header is rejected', () => {
  expect('missing', run({ secret: 'correct-horse-battery-staple' }), { status: 401 });
});
check('wrong secret is rejected', () => {
  expect('wrong', run({ secret: 'correct-horse-battery-staple', headers: { 'x-webhook-secret': 'wrong' } }), { status: 401 });
});
check('near-miss secret is rejected', () => {
  expect('near-miss', run({
    secret: 'correct-horse-battery-staple',
    headers: { 'x-webhook-secret': 'correct-horse-battery-stapl3' },
  }), { status: 401 });
});
check('correct secret via x-webhook-secret is accepted', () => {
  expect('x-webhook-secret', run({
    secret: 'correct-horse-battery-staple',
    headers: { 'x-webhook-secret': 'correct-horse-battery-staple' },
  }), { nextCalled: true });
});
check('correct secret via x-azampay-secret is accepted', () => {
  expect('x-azampay-secret', run({
    secret: 'correct-horse-battery-staple',
    headers: { 'x-azampay-secret': 'correct-horse-battery-staple' },
  }), { nextCalled: true });
});
check('production without a configured secret fails closed', () => {
  expect('no secret', run({ secret: '', nodeEnv: 'production' }), { status: 503 });
});
check('development without a configured secret is explicitly bypassed', () => {
  expect('dev bypass', run({ secret: '', nodeEnv: 'development' }), { nextCalled: true });
});
check('IP inside an allowed CIDR is accepted', () => {
  expect('cidr pass', run({
    secret: 's', allowedIps: ['203.0.113.0/24'], ip: '203.0.113.9',
    headers: { 'x-webhook-secret': 's' },
  }), { nextCalled: true });
});
check('IP outside the allowed CIDR is rejected', () => {
  expect('cidr reject', run({
    secret: 's', allowedIps: ['203.0.113.0/24'], ip: '198.51.100.9',
    headers: { 'x-webhook-secret': 's' },
  }), { status: 403 });
});
check('exact IP allowlist entry is accepted', () => {
  expect('exact pass', run({
    secret: 's', allowedIps: ['198.51.100.9'], ip: '198.51.100.9',
    headers: { 'x-webhook-secret': 's' },
  }), { nextCalled: true });
});
check('IPv4-mapped IPv6 address is normalized before matching', () => {
  expect('mapped', run({
    secret: 's', allowedIps: ['203.0.113.0/24'], ip: '::ffff:203.0.113.9',
    headers: { 'x-webhook-secret': 's' },
  }), { nextCalled: true });
});
check('invalid CIDR bits fail closed', () => {
  expect('bad cidr', run({
    secret: 's', allowedIps: ['203.0.113.0/99'], ip: '203.0.113.9',
    headers: { 'x-webhook-secret': 's' },
  }), { status: 403 });
});
check('allowlist is not applied outside production', () => {
  expect('dev allowlist', run({
    secret: 's', nodeEnv: 'development', allowedIps: ['203.0.113.0/24'], ip: '198.51.100.9',
    headers: { 'x-webhook-secret': 's' },
  }), { nextCalled: true });
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      console.log(`PASS ${c.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${c.name}\n     ${(e.stack || e.message).split('\n').slice(0, 4).join('\n     ')}`);
    }
  }
  config.nodeEnv = saved.nodeEnv;
  config.webhook.secret = saved.secret;
  config.webhook.allowedIps = saved.allowedIps;
  console.log(`RESULT: ${cases.length - failed} passed, ${failed} failed of ${cases.length}`);
  process.exit(failed ? 1 : 0);
})();
