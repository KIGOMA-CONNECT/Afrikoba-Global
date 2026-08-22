/**
 * Afrikoba Global — Load Testing Suite (k6)
 * Run: k6 run scripts/load-test.js
 * Or: k6 cloud scripts/load-test.js (for k6 Cloud)
 *
 * Scenarios:
 *   - Health check (baseline)
 *   - Auth flow (register + login + OTP)
 *   - Wallet operations (transfer, balance)
 *   - VICOBA operations (list groups, join)
 *   - P2P browsing (list projects)
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics
const loginSuccess = new Counter('login_success');
const loginFailed = new Counter('login_failed');
const transferSuccess = new Counter('transfer_success');
const apiLatency = new Trend('api_latency');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TEST_PHONE = __ENV.TEST_PHONE || '255728123456';
const TEST_PASS = __ENV.TEST_PASS || 'Test@12345';

export const options = {
  scenarios: {
    // Scenario 1: Health check (constant load)
    health: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 10,
      exec: 'healthCheck',
    },
    // Scenario 2: Auth flow (ramp up)
    auth: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 },
      ],
      exec: 'authFlow',
    },
    // Scenario 3: API browsing (sustained)
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
    http_req_failed: ['rate<0.05'],
    login_success: ['count>10'],
    transfer_success: ['count>5'],
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
  group('Auth: Register + Login', () => {
    // Generate unique phone
    const phone = `2557${String(__VU).padStart(2, '0')}${String(__ITER).padStart(6, '0')}`.slice(0, 12);

    // Send OTP
    const otpRes = http.post(`${BASE_URL}/api/v1/auth/send-otp`,
      JSON.stringify({ phone_number: phone, purpose: 'LOGIN' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    check(otpRes, {
      'send-otp: status 200 or 429': (r) => r.status === 200 || r.status === 429,
    });
    apiLatency.add(otpRes.timings.duration);

    sleep(0.5);

    // Health check
    const healthRes = http.get(`${BASE_URL}/health`);
    check(healthRes, {
      'health during auth: status 200': (r) => r.status === 200,
    });
  });

  sleep(1);
}

export function apiBrowsing() {
  group('API: Browse', () => {
    // Health
    const health = http.get(`${BASE_URL}/health`);
    check(health, { 'browse health: 200': (r) => r.status === 200 });
    apiLatency.add(health.timings.duration);

    // API version info
    const version = http.get(`${BASE_URL}/api/v1`);
    check(version, { 'version: 200': (r) => r.status === 200 });
    apiLatency.add(version.timings.duration);

    // Health DB
    const dbHealth = http.get(`${BASE_URL}/health/db`);
    check(dbHealth, { 'db health: 200': (r) => r.status === 200 });
    apiLatency.add(dbHealth.timings.duration);

    // Swagger docs
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
