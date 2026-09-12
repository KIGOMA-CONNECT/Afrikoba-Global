/**
 * Afrikoba Global — Security Test Suite (k6)
 * Run: k6 run scripts/security-test.js
 *
 * Tests:
 *   - SQL injection attempts
 *   - XSS payload attempts
 *   - Rate limiting enforcement
 *   - Unauthorized access patterns
 *   - CORS enforcement
 *   - Input validation bypass
 *
 * API contract aligned with src/validations/schemas.js (C4, AFK-INST-08):
 *   payloads use camelCase field names (phoneNumber / fullName) as the
 *   zod schemas require.
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
// Rate limiting must be disabled on the target for the load test's auth flow
// (k6.yml); the rate-limit scenario only asserts when limiting is actually on.
const RATE_LIMIT_DISABLED = (__ENV.RATE_LIMIT_DISABLED || '').toLowerCase() === 'true';
// On production every send-otp is a real SMS; the 25x burst in the rate-limit
// scenario would spam a live number, so PROD_TARGET skips it. The rest of the
// suite is safe on prod: it sends malformed payloads the schema rejects (400)
// and unauth probe requests (401), no OTP is ever generated.
const PROD_TARGET = (__ENV.PROD_TARGET || '').toLowerCase() === 'true';

// Gate is the checks metric, NOT http_req_failed: this suite sends attack probes
// that MUST be rejected with 4xx, and k6 (v2) counts every status >= 400 as a
// "failed request" and no longer honours the expected_response request tag, so
// http_req_failed would trip even when the API defends correctly. The check()s
// assert each defensive behaviour; a single failing check crosses the threshold.
export const options = {
  vus: 5,
  duration: '1m',
  thresholds: {
    checks: ['rate==1'],
  },
};

const SQL_PAYLOADS = [
  "' OR 1=1 --",
  "'; DROP TABLE users; --",
  "' UNION SELECT * FROM users --",
  "1' AND '1'='1",
  "admin'--",
  "' OR ''='",
];

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  '{{7*7}}',
  '${7*7}',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
];

export default function () {
  // Test 1: SQL Injection on auth endpoints
  group('SQL Injection', () => {
    for (const payload of SQL_PAYLOADS) {
      const res = http.post(`${BASE_URL}/api/v1/auth/send-otp`,
        JSON.stringify({ phoneNumber: payload }),
        { headers: { 'Content-Type': 'application/json' } }
      );
      check(res, {
        'SQLi: not 500': (r) => r.status !== 500,
        'SQLi: no error leak': (r) => !r.body.includes('SQL') && !r.body.includes('syntax'),
      });
    }
  });

  // Test 2: XSS in registration
  group('XSS Attempts', () => {
    for (const payload of XSS_PAYLOADS) {
      const res = http.post(`${BASE_URL}/api/v1/auth/register`,
        JSON.stringify({
          fullName: payload,
          phoneNumber: '255789123456',
          otp: '9999',
          password: 'Test@12345',
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
      check(res, {
        'XSS: not 500': (r) => r.status !== 500,
        'XSS: no script reflection': (r) => !r.body.includes('<script>'),
      });
    }
  });

  // Test 3: Unauthorized access patterns
  group('Unauthorized Access', () => {
    const protectedEndpoints = [
      '/api/v1/wallet/balance',
      '/api/v1/vicoba/groups',
      '/api/v1/p2p/projects',
      '/api/v1/admin/dashboard',
    ];

    for (const endpoint of protectedEndpoints) {
      // Without token
      const noToken = http.get(`${BASE_URL}${endpoint}`);
      check(noToken, {
        [`Unauth ${endpoint}: rejected (401/403/429)`]: (r) => [401, 403, 429].includes(r.status),
      });

      // With invalid token
      const badToken = http.get(`${BASE_URL}${endpoint}`, {
        headers: { Authorization: 'Bearer invalid_token_123' },
      });
      check(badToken, {
        [`Bad token ${endpoint}: rejected (401/429)`]: (r) => [401, 429].includes(r.status),
      });
    }
  });

  // Test 4: Rate limiting
  group('Rate Limiting', () => {
    if (RATE_LIMIT_DISABLED || PROD_TARGET) {
      check(null, { 'Rate limit: skipped (RATE_LIMIT_DISABLED or PROD_TARGET)': () => true });
    } else {
      const results = [];
      for (let i = 0; i < 25; i++) {
        const res = http.post(`${BASE_URL}/api/v1/auth/send-otp`,
          JSON.stringify({ phoneNumber: '255700000001' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
        results.push(res.status);
      }
      const has429 = results.includes(429);
      check(null, {
        'Rate limit: triggers after burst': () => has429 || results.filter(r => r === 200).length <= 20,
      });
    }
  });

  // Test 5: CORS enforcement
  group('CORS', () => {
    const res = http.options(`${BASE_URL}/api/v1/health`, null, {
      headers: {
        'Origin': 'https://evil.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    check(res, {
      'CORS: no evil origin allowed': (r) => {
        const acao = r.headers['Access-Control-Allow-Origin'];
        return !acao || acao !== 'https://evil.com';
      },
    });
  });

  // Test 6: Input validation
  group('Input Validation', () => {
    // Oversized payload
    const bigName = 'A'.repeat(500);
    const res = http.post(`${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({
        fullName: bigName,
        phoneNumber: 'not_a_phone',
        otp: '9999',
        password: 'weak',
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    check(res, {
      'Validation: rejects bad input (400/422/429)': (r) => [400, 422, 429].includes(r.status),
    });

    // Missing required fields
    const missingFields = http.post(`${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({}),
      { headers: { 'Content-Type': 'application/json' } }
    );
    check(missingFields, {
      'Validation: rejects empty body (400/422/429)': (r) => [400, 422, 429].includes(r.status),
    });
  });

  sleep(1);
}

export function handleSummary(data) {
  const checksRate = data.metrics.checks?.values?.rate ?? -1;
  return {
    'scripts/security-test-report.json': JSON.stringify({
      timestamp: new Date().toISOString(),
      totalRequests: data.metrics.http_reqs?.values?.count || 0,
      checksRate,
    }, null, 2),
    stdout: `\nSecurity test complete. Checks passed: ${(checksRate * 100).toFixed(2)}% (informational http_req_failed: ${((data.metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%)\n`,
  };
}
