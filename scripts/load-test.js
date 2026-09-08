/**
 * Afrikoba Global — Load Testing Suite (k6)
 * Run:     k6 run scripts/load-test.js
 * Run URL: k6 run -e BASE_URL=https://staging.afrikoba.com scripts/load-test.js
 * Or:      k6 cloud scripts/load-test.js (for k6 Cloud)
 *
 * API contract aligned with src/validations/schemas.js (C4, AFK-INST-08):
 *   POST /api/v1/auth/send-otp  { phoneNumber }            → { devOtp: "1234" } (non-prod)
 *   POST /api/v1/auth/login     { phoneNumber, otp }       → { token, user }
 *   POST /api/v1/auth/register  { fullName, phoneNumber, otp, [password] } → { token, user }
 *   POST /api/v1/wallet/transfer { toPhoneNumber, amount, [note] }  (Idempotency-Key header)
 *
 * Scenarios:
 *   - health   (baseline liveness)
 *   - auth     (login seeded funded user + register new user — devOtp flow)
 *   - transfer (funded user → recipient, idempotency-keyed)
 *   - browsing (docs + db health)
 *
 * Load-run notes: default OTP_RATE_MAX is 20/15min per phone; for realistic
 * auth load on staging either raise it or set RATE_LIMIT_DISABLED=true.
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Custom metrics
const loginSuccess = new Counter('login_success');
const loginFailed = new Counter('login_failed');
const transferSuccess = new Counter('transfer_success');
const apiLatency = new Trend('api_latency');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
// Funded seeded sender (db/seed.sql) for the transfer scenario.
const FUNDED_PHONE = __ENV.FUNDED_PHONE || '255713100001';   // Asha (150,000 TZS, KYC 2)
const RECIPIENT_PHONE = __ENV.RECIPIENT_PHONE || '255714100002'; // Juma (200,000 TZS)
const TRANSFER_AMOUNT = Number(__ENV.TRANSFER_AMOUNT || 1000);

// k6 keeps a module-level context per VU; cache the auth token per VU.
const tokenCache = {};
function login() {
  const phone = FUNDED_PHONE;
  const otp = http.post(`${BASE_URL}/api/v1/auth/send-otp`,
    JSON.stringify({ phoneNumber: phone }),
    { headers: { 'Content-Type': 'application/json' } });
  const devOtp = otp.json() && otp.json().devOtp;
  if (otp.status !== 200 || !devOtp) {
    loginFailed.add(1);
    apiLatency.add(otp.timings.duration);
    return null;
  }
  const login = http.post(`${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ phoneNumber: phone, otp: devOtp }),
    { headers: { 'Content-Type': 'application/json' } });
  apiLatency.add(login.timings.duration);
  if (login.status === 200 && login.json() && login.json().token) {
    loginSuccess.add(1);
    return login.json().token;
  }
  loginFailed.add(1);
  return null;
}
function cachedToken() {
  if (tokenCache[__VU]) return tokenCache[__VU];
  tokenCache[__VU] = login() || '';
  return tokenCache[__VU];
}

export const options = {
  scenarios: {
    // Scenario 1: health check (constant load)
    health: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 10,
      exec: 'healthCheck',
    },
    // Scenario 2: auth flow (login + register with devOtp)
    auth: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 10 },
        { duration: '30s', target: 0 },
      ],
      exec: 'authFlow',
    },
    // Scenario 3: funded wallet transfer (idempotency-keyed)
    transfer: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 2,
      exec: 'walletTransfer',
    },
    // Scenario 4: API browsing (sustained)
    browsing: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 15,
      exec: 'apiBrowsing',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
    http_req_failed: ['rate<0.15'],
    login_success: ['count>5'],
    transfer_success: ['count>3'],
  },
};

export function healthCheck() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    'health: status 200': (r) => r.status === 200,
    'health: response time < 200ms': (r) => r.timings.duration < 200,
  });
  apiLatency.add(res.timings.duration);
  sleep(0.1);
}

export function authFlow() {
  group('Auth: Login + Register (devOtp)', () => {
    const phone = `2557${String(__VU).padStart(2, '0')}${String(__ITER).padStart(6, '0')}`.slice(0, 12);
    const otpRes = http.post(`${BASE_URL}/api/v1/auth/send-otp`,
      JSON.stringify({ phoneNumber: phone }),
      { headers: { 'Content-Type': 'application/json' } });
    const devOtp = otpRes.json() && otpRes.json().devOtp;
    apiLatency.add(otpRes.timings.duration);
    check(otpRes, {
      'send-otp: status 200 or 429': (r) => r.status === 200 || r.status === 429,
    });

    if (otpRes.status === 200 && devOtp) {
      const reg = http.post(`${BASE_URL}/api/v1/auth/register`,
        JSON.stringify({ fullName: `Load User ${__VU}-${__ITER}`, phoneNumber: phone, otp: devOtp }),
        { headers: { 'Content-Type': 'application/json' } });
      apiLatency.add(reg.timings.duration);
      if (reg.status === 200 && reg.json() && reg.json().token) loginSuccess.add(1);
      else loginFailed.add(1);
      check(reg, {
        'register: status 200 or 400': (r) => r.status === 200 || r.status === 400,
      });
    } else if (otpRes.status !== 200) {
      loginFailed.add(1);
    }

    // Re-login the funded sender each VU (idempotent cache for transfer).
    if (otpRes.status === 200 && devOtp && cachedToken()) {
      check(true, 'funded sender token available');
    } else {
      loginFailed.add(1);
    }
  });

  sleep(1);
}

export function walletTransfer() {
  group('Wallet: Transfer (idempotency-keyed)', () => {
    const token = cachedToken();
    if (!token) {
      loginFailed.add(1);
      return;
    }
    const res = http.post(`${BASE_URL}/api/v1/wallet/transfer`,
      JSON.stringify({ toPhoneNumber: RECIPIENT_PHONE, amount: TRANSFER_AMOUNT, note: 'k6 load transfer' }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': `k6-load-${__VU}-${__ITER}`,
        },
      });
    apiLatency.add(res.timings.duration);
    if (res.status === 200) transferSuccess.add(1);
    check(res, {
      'transfer: accepted (200) or business error (400/402/409)': (r) =>
        r.status === 200 || r.status === 400 || r.status === 402 || r.status === 409,
    });
    const bal = http.get(`${BASE_URL}/api/v1/wallet/balance`,
      { headers: { Authorization: `Bearer ${token}` } });
    apiLatency.add(bal.timings.duration);
    check(bal, {
      'balance: 200': (r) => r.status === 200,
    });
  });

  sleep(1);
}

export function apiBrowsing() {
  group('API: Browse', () => {
    const health = http.get(`${BASE_URL}/health`);
    check(health, { 'browse health: 200': (r) => r.status === 200 });
    apiLatency.add(health.timings.duration);

    const version = http.get(`${BASE_URL}/api/v1`);
    check(version, { 'version: 200': (r) => r.status === 200 });
    apiLatency.add(version.timings.duration);

    const dbHealth = http.get(`${BASE_URL}/health/db`);
    check(dbHealth, { 'db health: 200': (r) => r.status === 200 });
    apiLatency.add(dbHealth.timings.duration);

    const docs = http.get(`${BASE_URL}/api/v1/docs.json`);
    check(docs, { 'swagger: 200': (r) => r.status === 200 });
    apiLatency.add(docs.timings.duration);
  });

  sleep(0.5);
}

export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    metrics: {
      http_reqs: data.metrics.http_reqs?.values?.count || 0,
      http_req_duration_p95: data.metrics.http_req_duration?.values?.['p(95)'] || 0,
      http_req_duration_p99: data.metrics.http_req_duration?.values?.['p(99)'] || 0,
      http_req_failed_rate: data.metrics.http_req_failed?.values?.rate || 0,
      login_success: data.metrics.login_success?.values?.count || 0,
      transfer_success: data.metrics.transfer_success?.values?.count || 0,
    },
  };

  return {
    'scripts/load-test-report.json': JSON.stringify(summary, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, opts) {
  const lines = [
    '',
    '========================================',
    '  AFRIKOBA GLOBAL — LOAD TEST RESULTS',
    '========================================',
    `  Total requests: ${data.metrics.http_reqs?.values?.count || 0}`,
    `  Failed requests: ${(data.metrics.http_req_failed?.values?.rate * 100 || 0).toFixed(2)}%`,
    `  P95 latency: ${(data.metrics.http_req_duration?.values?.['p(95)'] || 0).toFixed(2)}ms`,
    `  P99 latency: ${(data.metrics.http_req_duration?.values?.['p(99)'] || 0).toFixed(2)}ms`,
    `  Login successes: ${data.metrics.login_success?.values?.count || 0}`,
    `  Transfer successes: ${data.metrics.transfer_success?.values?.count || 0}`,
    '========================================',
    '',
  ];
  return lines.join('\n');
}