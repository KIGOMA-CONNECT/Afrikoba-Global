/* ============================================================
 * AFRIKOBA GLOBAL - AML COMPLIANCE - WALLET FREEZE / UNFREEZE
 * CASE MANAGEMENT (increment 21, suite 64)
 *
 * migration 120 adds `wallet_freezes` (FRZ-*): a DB-backed freeze
 * state enforced on the two primary cash-out paths (P2P transfer +
 * MNO withdrawal) alongside the request-time FRAUD_BLOCKED gate.
 *
 * GET  /api/fraud-ops/freezes              list (status/userId filter)
 * GET  /api/fraud-ops/freezes/:id          single freeze detail
 * POST /api/fraud-ops/freezes              { userId, reason, caseId? }
 * POST /api/fraud-ops/freezes/:id/lift     { comment? }
 *
 * RBAC: ADMIN or COMPLIANCE (COMPLIANCE_ROLES); the fraud-ops
 * surface was previously ADMIN-only.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || process.env.AML_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0, failed = 0;
const failures = [];
const ok = (label) => { passed++; console.log('  \u2713 ' + label); };
const fail = (label, extra) => { failed++; failures.push(label); console.log('  \u2717 ' + label + (extra ? ' :: ' + extra : '')); };
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra || ''); }
async function section(label) { console.log(`\n--- ${label} ---`); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.token) throw new Error('register failed: ' + JSON.stringify(r.data));
  return r.data;
}
const nowSuffix = () => String(Date.now()).slice(-6);
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
}
async function auditCount(action) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = $1', [action]);
  return r.rows[0].n;
}

async function main() {
  // ---------- 1. Schema evidence (120_aml_compliance) ----------
  await section('Schema evidence (120_aml_compliance)');
  const tbl = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'wallet_freezes'`
  );
  const cols = tbl.rows.map((r) => r.column_name);
  await expect(cols.includes('id') && cols.includes('user_id') && cols.includes('reference')
    && cols.includes('reason') && cols.includes('status') && cols.includes('initiated_by')
    && cols.includes('lifted_by') && cols.includes('case_id'),
    'wallet_freezes carries freeze/lift columns');
  const uq = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'wallet_freezes' AND indexname = 'uq_wallet_freezes_active_user'`
  );
  await expect(uq.rows.length === 1, 'partial unique index on ACTIVE freeze per user exists');

  // ---------- 2. Setup: ops users + members ----------
  await section('Setup: ops users + members');
  const sfx = nowSuffix();
  const adminInfo = await register(`255930${sfx}`, 'AML Admin');
  const complianceInfo = await register(`255931${sfx}`, 'AML Officer');
  const m1Info = await register(`255932${sfx}`, 'Frozen Member');
  const m2Info = await register(`255933${sfx}`, 'Open Member');
  await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [adminInfo.user.id]);
  await pool.query(`UPDATE users SET role = 'COMPLIANCE' WHERE id = $1`, [complianceInfo.user.id]);
  await pool.query(`UPDATE users SET kyc_level = 1 WHERE id IN ($1, $2)`, [m1Info.user.id, m2Info.user.id]);
  await fundWallet(m1Info.user.id, 100000);
  await fundWallet(m2Info.user.id, 100000);
  const adminTok = adminInfo.token, compTok = complianceInfo.token, m1Tok = m1Info.token, m2Tok = m2Info.token;

  // ---------- 3. RBAC ----------
  await section('RBAC');
  const unauth = await api('GET', '/api/fraud-ops/freezes');
  await expect(unauth.status === 401, 'unauthenticated GET freezes -> 401');
  const memList = await api('GET', '/api/fraud-ops/freezes', m1Tok);
  await expect(memList.status === 403, 'member GET freezes -> 403');
  const memFreeze = await api('POST', '/api/fraud-ops/freezes', m1Tok, { userId: m2Info.user.id, reason: 'x' });
  await expect(memFreeze.status === 403, 'member POST freeze -> 403');
  const memLift = await api('POST', '/api/fraud-ops/freezes/1/lift', m1Tok, {});
  await expect(memLift.status === 403, 'member lift -> 403');
  const adminList = await api('GET', '/api/fraud-ops/freezes?status=ACTIVE', adminTok);
  await expect(adminList.status === 200 && Array.isArray(adminList.data.freezes), 'ADMIN GET freezes -> 200');
  const compList = await api('GET', '/api/fraud-ops/freezes', compTok);
  await expect(compList.status === 200 && Array.isArray(compList.data.freezes), 'COMPLIANCE GET freezes -> 200 (role admitted)');

  // ---------- 4. Freeze lifecycle ----------
  await section('Freeze lifecycle');
  const fz = await api('POST', '/api/fraud-ops/freezes', compTok, { userId: m1Info.user.id, reason: 'Structured deposits consistent with syndicate', caseId: null });
  await expect(fz.status === 201 && /^FRZ-/.test(fz.data.freeze.reference) && fz.data.freeze.status === 'ACTIVE',
    'COMPLIANCE freezes member1 -> 201 FRZ-* (ACTIVE)');
  const fzId = fz.data.freeze.id;
  const dup = await api('POST', '/api/fraud-ops/freezes', adminTok, { userId: m1Info.user.id, reason: 'again' });
  await expect(dup.status === 400 && dup.data.code === 'AML_FREEZE_ALREADY_ACTIVE', 're-freeze active account -> 400 AML_FREEZE_ALREADY_ACTIVE');
  const getFz = await api('GET', `/api/fraud-ops/freezes/${fzId}`, compTok);
  await expect(getFz.status === 200 && getFz.data.freeze.user_phone === m1Info.user.phone_number
    && getFz.data.freeze.reason && getFz.data.freeze.status === 'ACTIVE',
    'GET single freeze -> 200 w/ member phone + reason');
  const listFz = await api('GET', '/api/fraud-ops/freezes?status=ACTIVE', compTok);
  await expect(listFz.data.freezes.length === 1 && listFz.data.freezes[0].user_id === m1Info.user.id,
    'ACTIVE filter lists exactly the frozen member');

  // ---------- 5. Enforcement on cash-out ----------
  await section('Enforcement: transfers/withdrawals blocked for frozen payer');
  const xferFrozen = await api('POST', '/api/wallet/transfer', m1Tok, { toPhoneNumber: m2Info.user.phone_number, amount: 5000, note: 'try' });
  await expect(xferFrozen.status === 403 && xferFrozen.data.code === 'AML_ACCOUNT_FROZEN',
    'frozen member transfer -> 403 AML_ACCOUNT_FROZEN');
  const wdFrozen = await api('POST', '/api/wallet/withdraw', m1Tok, { amount: 5000, provider: 'Tigo' });
  await expect(wdFrozen.status === 403 && wdFrozen.data.code === 'AML_ACCOUNT_FROZEN',
    'frozen member withdrawal -> 403 AML_ACCOUNT_FROZEN');
  const payeeOk = await api('POST', '/api/wallet/transfer', m2Tok, { toPhoneNumber: m1Info.user.phone_number, amount: 2000, note: 'to frozen ok' });
  await expect(payeeOk.status === 200 && payeeOk.data.success, 'non-frozen member can still pay the frozen member');
  const controlXfer = await api('POST', '/api/wallet/transfer', m2Tok, { toPhoneNumber: adminInfo.user.phone_number, amount: 1000, note: 'control' });
  await expect(controlXfer.status === 200 && controlXfer.data.success, 'non-frozen member transfer still works');

  // ---------- 6. Case linkage + lift ----------
  await section('Case linkage + lift');
  const cs = await api('POST', '/api/fraud-ops/cases', compTok, { userId: m1Info.user.id, caseType: 'STRUCTURED_DEPOSITS', riskLevel: 'HIGH', summary: 'Repeat cash-ins near threshold' });
  await expect(cs.status === 201 && cs.data.case.user_id === m1Info.user.id, 'COMPLIANCE opens case on member1');
  const fz2 = await api('POST', '/api/fraud-ops/freezes', adminTok, { userId: m2Info.user.id, reason: 'Sanctions name variation', caseId: cs.data.case.id });
  await expect(fz2.status === 201 && fz2.data.freeze.case_id === cs.data.case.id, 'freeze linked to AML case (case_id set)');
  await api('POST', `/api/fraud-ops/freezes/${fz2.data.freeze.id}/lift`, compTok, { comment: 'Name variation cleared by FIU' });
  const lift1 = await api('POST', `/api/fraud-ops/freezes/${fzId}/lift`, adminTok, { comment: 'Docs provided; released' });
  await expect(lift1.status === 200 && lift1.data.freeze.status === 'LIFTED' && lift1.data.freeze.lifted_comment === 'Docs provided; released' && lift1.data.freeze.lifted_by === adminInfo.user.id,
    'ADMIN lifts freeze -> LIFTED with comment/by');
  const afterXfer = await api('POST', '/api/wallet/transfer', m1Tok, { toPhoneNumber: m2Info.user.phone_number, amount: 3000, note: 'now allowed' });
  await expect(afterXfer.status === 200 && afterXfer.data.success, 'member transfers again after lift');
  const relift = await api('POST', `/api/fraud-ops/freezes/${fzId}/lift`, compTok, {});
  await expect(relift.status === 400 && relift.data.code === 'AML_FREEZE_NOT_ACTIVE', 're-lift -> 400 AML_FREEZE_NOT_ACTIVE');

  // ---------- 7. Audit trail ----------
  await section('Audit trail');
  await expect((await auditCount('AML_WALLET_FROZEN')) >= 2, 'AML_WALLET_FROZEN audited');
  await expect((await auditCount('AML_WALLET_LIFTED')) >= 2, 'AML_WALLET_LIFTED audited');

  console.log(`\nAML CASES: ${passed} passed, ${failed} failed`);
  await pool.end();
  if (failed) { console.log('Failures:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('Suite crashed:', e); process.exit(1); });