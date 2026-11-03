'use strict';
// Phase 68 D1: triggerPayout outcome classification (refused vs ambiguous).
// axios is replaced by a test double. No network calls are made.

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve('axios', { paths: [ROOT] });
const calls = { checkout: 0, auth: 0 };
let checkoutBehaviour = null;
let authBehaviour = null;

require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: {
    post: async (url, body, opts) => {
      if (url.includes('AppAuthentication/Token')) {
        calls.auth++;
        if (authBehaviour) return authBehaviour();
        return { data: { data: { accessToken: 'stub-token', expires: '3600' } } };
      }
      calls.checkout++;
      return checkoutBehaviour();
    },
  },
};

const config = require(path.join(ROOT, 'src/config'));
config.azampay.enabled = true;
config.azampay.payoutContractVerified = true;
const svc = require(path.join(ROOT, 'src/services/azampayService'));

const httpErr = (status, data = { message: 'upstream' }) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
const netErr = (code) => Object.assign(new Error(code), { code });

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });
const reset = () => { calls.checkout = 0; calls.auth = 0; };

scenario('C1 token request fails: refused, nothing sent to checkout', async () => {
  reset();
  authBehaviour = () => { throw netErr('ECONNRESET'); };
  checkoutBehaviour = () => { throw new Error('must not be called'); };
  const r = await svc.triggerPayout('255700000001', 5000, 'WD-C1', 'Mpesa');
  authBehaviour = null;
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.ambiguous, false);
  assert.strictEqual(calls.checkout, 0);
});

scenario('C2 HTTP 4xx with body: definitive refusal', async () => {
  reset();
  checkoutBehaviour = () => { throw httpErr(400, { message: 'Invalid accountNumber' }); };
  const r = await svc.triggerPayout('255700000001', 5000, 'WD-C2', 'Mpesa');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.ambiguous, false);
  assert.strictEqual(r.message, 'Invalid accountNumber');
  assert.strictEqual(calls.checkout, 1, 'no retry inside triggerPayout');
});

scenario('C3 HTTP 5xx: ambiguous, not refused', async () => {
  reset();
  checkoutBehaviour = () => { throw httpErr(502, { message: 'bad gateway' }); };
  const r = await svc.triggerPayout('255700000001', 5000, 'WD-C3', 'Mpesa');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(calls.checkout, 1);
});

scenario('C4 network reset (no response): ambiguous', async () => {
  reset();
  checkoutBehaviour = () => { throw netErr('ECONNRESET'); };
  const r = await svc.triggerPayout('255700000001', 5000, 'WD-C4', 'Mpesa');
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(calls.checkout, 1);
});

scenario('C5 request timeout after provider may have received it: ambiguous', async () => {
  reset();
  checkoutBehaviour = () => { throw netErr('ECONNABORTED'); };
  const r = await svc.triggerPayout('255700000001', 5000, 'WD-C5', 'Mpesa');
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(calls.checkout, 1);
});

scenario('C6 HTTP 200: success, externalId passed through', async () => {
  reset();
  checkoutBehaviour = () => ({ data: { success: true, externalId: 'AZ-C6' } });
  const r = await svc.triggerPayout('255700000001', 5000, 'WD-C6', 'Mpesa');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.externalId, 'AZ-C6');
});

scenario('C7 contract unverified: no HTTP call at all', async () => {
  reset();
  checkoutBehaviour = () => { throw new Error('must not be called'); };
  config.azampay.payoutContractVerified = false;
  try {
    const r = await svc.triggerPayout('255700000001', 5000, 'WD-C7', 'Mpesa');
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.ambiguous, false);
    assert.strictEqual(r.message, 'PAYOUT_CONTRACT_UNVERIFIED');
    assert.strictEqual(calls.checkout, 0);
    assert.strictEqual(calls.auth, 0);
  } finally {
    config.azampay.payoutContractVerified = true;
  }
});

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    try {
      await s.fn();
      console.log(`PASS ${s.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}\n     ${(e.stack || e.message).split('\n').slice(0, 3).join('\n     ')}`);
    }
  }
  console.log(`RESULT: ${scenarios.length - failed} passed, ${failed} failed of ${scenarios.length}`);
  process.exit(failed ? 1 : 0);
})();
