const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const http = require('http');

const BASE = 'http://localhost:3099';
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 55432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'phase68_amount_guard_mtc04',
});

const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_for_integration_testing_at_least_32_chars';

let passed = 0;
let failed = 0;
const results = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    results.push('PASS  ' + name);
  } else {
    failed++;
    results.push('FAIL  ' + name + (detail ? ' — ' + detail : ''));
  }
}

async function request(method, path, body, token) {
  return new Promise((resolve) => {
    const url = new URL(BASE + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, phone: user.phone_number, av: user.auth_version || 0, jti: 'test-jti' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

(async () => {
  // Setup: create test users
  await pool.query("INSERT INTO users (id, full_name, phone_number, password_hash, role, is_active, auth_version, wallet_balance) VALUES (100, 'Test Initiator', '+255700000100', 'hash', 'MJUMBE', true, 0, 5000) ON CONFLICT (id) DO UPDATE SET wallet_balance = 5000, is_active = true");
  await pool.query("INSERT INTO users (id, full_name, phone_number, password_hash, role, is_active, auth_version, wallet_balance) VALUES (101, 'Test Contributor', '+255700000101', 'hash', 'MJUMBE', true, 0, 5000) ON CONFLICT (id) DO UPDATE SET wallet_balance = 5000, is_active = true");
  await pool.query("INSERT INTO users (id, full_name, phone_number, password_hash, role, is_active, auth_version, wallet_balance) VALUES (102, 'Test Outsider', '+255700000102', 'hash', 'MJUMBE', true, 0, 5000) ON CONFLICT (id) DO UPDATE SET wallet_balance = 5000, is_active = true");
  await pool.query("INSERT INTO users (id, full_name, phone_number, password_hash, role, is_active, auth_version, wallet_balance) VALUES (103, 'Test Admin', '+255700000103', 'hash', 'ADMIN', true, 0, 5000) ON CONFLICT (id) DO UPDATE SET wallet_balance = 5000, is_active = true");

  // Create a social fund case
  await pool.query("INSERT INTO social_fund_cases (id, initiator_id, context_type, case_type, beneficiary_name, title, target_amount, deadline, status, privacy_mode, total_collected) VALUES (100, 100, 'VICOBA', 'WEDDING', 'Beneficiary', 'Test Case', 1000.00, NOW() + INTERVAL '30 days', 'OPEN', 'MEMBERS_ONLY', 0) ON CONFLICT (id) DO UPDATE SET total_collected = 0, status = 'OPEN'");

  const token100 = signToken({ id: 100, role: 'MJUMBE', phone_number: '+255700000100', auth_version: 0 });
  const token101 = signToken({ id: 101, role: 'MJUMBE', phone_number: '+255700000101', auth_version: 0 });
  const token102 = signToken({ id: 102, role: 'MJUMBE', phone_number: '+255700000102', auth_version: 0 });
  const token103 = signToken({ id: 103, role: 'ADMIN', phone_number: '+255700000103', auth_version: 0 });

  // === A. Social Fund contributions ===

  // Unauthenticated request
  const r0 = await request('POST', '/api/v1/social/cases/100/contribute', { amount: 50 });
  check('A01: Unauthenticated contribution rejected (401)', r0.status === 401);

  // Valid contribution (registry now available — migration 154 applied)
  const r1 = await request('POST', '/api/v1/social/cases/100/contribute', { amount: 50, idempotency_key: 'int-test-001' }, token100);
  check('A02: Valid contribution succeeds', r1.status === 200 && r1.body.success);

  // Idempotency replay
  const r2 = await request('POST', '/api/v1/social/cases/100/contribute', { amount: 50, idempotency_key: 'int-test-001' }, token100);
  check('A03: Idempotency replay returns same result', r2.status === 200 && r2.body.referenceId === r1.body.referenceId);

  // Conflicting amount
  const r3 = await request('POST', '/api/v1/social/cases/100/contribute', { amount: 100, idempotency_key: 'int-test-001' }, token100);
  check('A04: Conflicting amount returns 409', r3.status === 409);

  // Insufficient funds
  const r4 = await request('POST', '/api/v1/social/cases/100/contribute', { amount: 99999, idempotency_key: 'int-test-002' }, token100);
  check('A05: Insufficient funds rejected', r4.status === 400);

  // === B. Privacy ===

  // Outsider cannot see MEMBERS_ONLY case
  const r5 = await request('GET', '/api/v1/social/cases/100', null, token102);
  check('B01: Outsider cannot see MEMBERS_ONLY case (404/403)', r5.status === 404 || r5.status === 403);

  // Initiator can see
  const r6 = await request('GET', '/api/v1/social/cases/100', null, token100);
  check('B02: Initiator can see MEMBERS_ONLY case', r6.status === 200);

  // Contributor can see (after contributing)
  await request('POST', '/api/v1/social/cases/100/contribute', { amount: 25, idempotency_key: 'int-test-003' }, token101);
  const r7 = await request('GET', '/api/v1/social/cases/100', null, token101);
  check('B03: Contributor can see MEMBERS_ONLY case', r7.status === 200);

  // === C. Case governance ===

  // Unauthorized user cannot change status
  const r8 = await request('POST', '/api/v1/social/cases/100/status', { new_status: 'CLOSED' }, token102);
  check('C01: Unauthorized user cannot change status (403)', r8.status === 403);

  // Initiator can change status
  const r9 = await request('POST', '/api/v1/social/cases/100/status', { new_status: 'CLOSED' }, token100);
  check('C02: Initiator can change status', r9.status === 200);

  // Invalid transition
  const r10 = await request('POST', '/api/v1/social/cases/100/status', { new_status: 'OPEN' }, token100);
  check('C03: Invalid transition rejected (400)', r10.status === 400);

  // === D. Payout API ===

  // Reset case to collect
  await pool.query("UPDATE social_fund_cases SET status = 'COLLECTING', total_collected = 100 WHERE id = 100");

  // Admin can request payout
  const r11 = await request('POST', '/api/v1/social/cases/100/payout', { recipient_phone: '+255700000001', amount: 50, idempotency_key: 'int-payout-001' }, token103);
  check('D01: Admin can request payout', r11.status === 200);

  // Payout idempotency replay
  const r12 = await request('POST', '/api/v1/social/cases/100/payout', { recipient_phone: '+255700000001', amount: 50, idempotency_key: 'int-payout-001' }, token103);
  check('D02: Payout idempotency replay', r12.status === 200);

  // Payout conflict (different amount)
  const r13 = await request('POST', '/api/v1/social/cases/100/payout', { recipient_phone: '+255700000001', amount: 75, idempotency_key: 'int-payout-001' }, token103);
  check('D03: Payout amount conflict (409)', r13.status === 409);

  // Non-admin cannot request payout
  const r14 = await request('POST', '/api/v1/social/cases/100/payout', { recipient_phone: '+255700000001', amount: 10, idempotency_key: 'int-payout-002' }, token100);
  check('D04: Non-admin cannot request payout (403)', r14.status === 403);

  // === E. Transaction traceability ===
  // Migration 154 now applied — journal posting should succeed

  const txRes = await pool.query("SELECT id, reference_id, status, product_type FROM transactions WHERE reference_id LIKE 'SOC%' ORDER BY id DESC LIMIT 1");
  check('E01: Transaction record exists', txRes.rows.length > 0);
  if (txRes.rows.length > 0) {
    check('E02: Transaction status is SUCCESS', txRes.rows[0].status === 'SUCCESS');
    check('E03: Transaction product_type is SOCIAL_FUND', txRes.rows[0].product_type === 'SOCIAL_FUND');
  }

  const jeRes = await pool.query("SELECT je.transaction_id, la.account_code, je.direction, je.amount FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id WHERE je.reference_id LIKE 'SOC%' ORDER BY je.id DESC LIMIT 2");
  check('E04: Journal entries exist', jeRes.rows.length >= 2);
  if (jeRes.rows.length >= 2) {
    check('E05: Journal transaction_id matches transaction', jeRes.rows[0].transaction_id === txRes.rows[0].id);
    const dr = jeRes.rows.filter(r => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
    const cr = jeRes.rows.filter(r => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
    check('E06: Journal is balanced (DR=CR)', Math.abs(dr - cr) < 0.001);
  }

  // Print results
  console.log('\n=== INTEGRATION TEST RESULTS ===');
  for (const r of results) console.log(r);
  console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });