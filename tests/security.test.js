/**
 * Security Middleware Integration Tests
 * Verifies that all security layers correctly block malicious requests.
 */

const request = require('supertest');
const assert = require('assert');

// Lightweight test harness (no external framework dependency)
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
let passed = 0;
let failed = 0;

// Simple Express app clone of middleware stack
const express = require('express');
const { xssProtection } = require('../src/middleware/xssProtection');
const { inputLengthGuard } = require('../src/middleware/inputLengthGuard');
const { verifyCsrfToken } = require('../src/middleware/csrf');
const { sqlInjectionGuard } = require('../src/middleware/sqlInjectionGuard');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', verifyCsrfToken);
  app.use('/api', xssProtection);
  app.use('/api', inputLengthGuard);
  app.use('/api', sqlInjectionGuard);
  app.post('/api/test', (req, res) => res.json({ success: true }));
  return app;
}

// Test 1: XSS protection blocks script injection
test('XSS Protection rejects <script> in body', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/test')
    .set('x-csrf-token', 'dummy')
    .send({ message: '<script>alert(1)</script>' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'INVALID_INPUT');
});

// Test 2: CSRF middleware rejects missing token
test('CSRF rejects state-changing request without token', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/test')
    .send({ data: 'ok' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'CSRF_TOKEN_MISSING');
});

// Test 3: Input length guard rejects oversized payload
test('Input length guard rejects oversized field', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/test')
    .set('x-csrf-token', 'dummy')
    .send({ message: 'x'.repeat(6000) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'INPUT_TOO_LONG');
});

// Test 4: SQL injection guard blocks UNION attempt
test('SQL Injection guard blocks UNION-based attack', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/test')
    .set('x-csrf-token', 'dummy')
    .send({ email: "foo' UNION SELECT * FROM users--" });
  assert.ok(res.status === 400);
});

// Test 5: Clean request passes through
test('Clean request passes all security layers', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/test')
    .set('x-csrf-token', 'dummy')
    .send({ phoneNumber: '+255712345678', message: 'Habari' });
  assert.strictEqual(res.status, 200);
});

async function runAll() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${name}: ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll();