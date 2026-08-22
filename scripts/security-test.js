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
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  vus: 5,
  duration: '1m',
  thresholds: {
    http_req_failed: ['rate<0.3'],
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
        JSON.stringify({ phone_number: payload }),
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
          full_name: payload,
          phone_number: '255789123456',
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
        [`Unauth ${endpoint}: 401 or 403`]: (r) => r.status === 401 || r.status === 403,
      });

      // With invalid token
      const badToken = http.get(`${BASE_URL}${endpoint}`, {
        headers: { Authorization: 'Bearer invalid_token_123' },
      });
      check(badToken, {
        [`Bad token ${endpoint}: 401`]: (r) => r.status === 401,
      });
    }
  });

  // Test 4: Rate limiting
  group('Rate Limiting', () => {
    const results = [];
    for (let i = 0; i < 25; i++) {
      const res = http.post(`${BASE_URL}/api/v1/auth/send-otp`,
        JSON.stringify({ phone_number: '255700000001', purpose: 'LOGIN' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
      results.push(res.status);
    }
    const has429 = results.includes(429);
    check(null, {
      'Rate limit: triggers after burst': () => has429 || results.filter(r => r === 200).length <= 20,
    });
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
        full_name: bigName,
        phone_number: 'not_a_phone',
        password: 'weak',
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    check(res, {
      'Validation: rejects bad input': (r) => r.status === 400 || r.status === 422,
    });

    // Missing required fields
    const missingFields = http.post(`${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({}),
      { headers: { 'Content-Type': 'application/json' } }
    );
    check(missingFields, {
      'Validation: rejects empty body': (r) => r.status === 400 || r.status === 422,
    });
  });

  sleep(1);
}

export function handleSummary(data) {
  return {
    'scripts/security-test-report.json': JSON.stringify({
      timestamp: new Date().toISOString(),
      totalRequests: data.metrics.http_reqs?.values?.count || 0,
      failedRate: data.metrics.http_req_failed?.values?.rate || 0,
    }, null, 2),
    stdout: `\nSecurity test complete. Failed rate: ${((data.metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%\n`,
  };
}
