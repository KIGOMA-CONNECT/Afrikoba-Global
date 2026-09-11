/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - LENDING RISK LIMITS
 * Increment 21b regression: per-SACCOS lending risk limits
 * stored in config.lending (no schema migration) - absolute
 * exposure cap per member, deposits-multiple cap (memberBacking
 * savings + shares), and single-borrower portfolio concentration
 * cap enforced at application AND at OWNER/BOARD approval;
 * governing-only GET /loans/risk summary (portfolio + top
 * borrowers + utilization) and PATCH /loans/risk-limits with
 * value coercion (clamps + null = disabled). Suite 65.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const crypto = require('crypto');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++; failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label); else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method, headers,
    body: !isGet && body !== undefined ? JSON.stringify(body) : undefined,
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
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
function nowSuffix() { return String(Date.now()).slice(-6); }
async function fundWallet(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = 'TST-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const tx = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'DEPOSIT', $4) RETURNING id`,
      [ref, userId, amount, JSON.stringify({ note: 'test-funding' })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
    await client.query(
      'INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description) VALUES ($1, $2, $3, $4, $5)',
      [tx.rows[0].id, ref, userId, amount, 'Test funding']
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function setupOrg(ownerName, base, config) {
  const ownerReg = await register(phone(base + 1), ownerName);
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Risk ' + ownerName + ' ' + suffix, config });
  if (create.status !== 201) throw new Error('create org failed: ' + create.status + ' ' + JSON.stringify(create.data));
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);
  return { orgId, ownerTok, ownerReg };
}

async function joinMember(orgId, ownerTok, phoneNumber, name, funds) {
  const reg = await register(phoneNumber, name);
  const tok = reg.data.token;
  const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber });
  if (inv.status !== 201) throw new Error('invite failed: ' + inv.status + ' ' + JSON.stringify(inv.data));
  await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, tok);
  if (funds) await fundWallet(reg.data.user.id, funds);
  return { tok, userId: reg.data.user.id };
}

async function main() {
  suffix = nowSuffix();

  // ---------- 1. Org A: absolute exposure cap + validation ----------
  await section('Org A: risk limits API, coercion, absolute exposure cap');
  const A = await setupOrg('LimitsA', 5001, {
    lending: { interestRate: 12, minAmount: 10000, maxAmount: 300000, maxTermMonths: 12, maxActiveLoans: 4, autoDisburse: true, maxExposureAmount: 150000 },
  });
  const m1 = await joinMember(A.orgId, A.ownerTok, phone(5101), 'Risk Member One', 500000);

  const unauth = await api('GET', `/api/saccos/${A.orgId}/loans/risk`, null);
  await expect(unauth.status === 401, 'GET risk unauth -> 401', String(unauth.status));

  const memberView = await api('GET', `/api/saccos/${A.orgId}/loans/risk`, m1.tok);
  await expect(memberView.status === 403 && memberView.data.code === 'SACCOS_RBAC', 'GET risk member -> 403 SACCOS_RBAC');

  const memberPatch = await api('PATCH', `/api/saccos/${A.orgId}/loans/risk-limits`, m1.tok, { maxExposureAmount: 999 });
  await expect(memberPatch.status === 403 && memberPatch.data.code === 'SACCOS_RBAC', 'PATCH risk-limits member -> 403 SACCOS_RBAC');

  const sum0 = await api('GET', `/api/saccos/${A.orgId}/loans/risk`, A.ownerTok);
  await expect(sum0.status === 200 && sum0.data.result.limits.maxExposureAmount === 150000
    && sum0.data.result.limits.maxExposureMultiple === null && sum0.data.result.limits.maxConcentrationPercent === null
    && sum0.data.result.limits.maxActiveLoans === 4 && sum0.data.result.portfolio.gross_loans === 0,
    'GET risk owner -> applied limits (exposure 150k, multiple/conc null, active 4), gross 0',
    JSON.stringify(sum0.data.result.row ? 'row' : 'n/a'));

  const noKeys = await api('PATCH', `/api/saccos/${A.orgId}/loans/risk-limits`, A.ownerTok, {});
  await expect(noKeys.status === 400 && noKeys.data.code === 'SACCOS_RISK_LIMITS_INVALID', 'PATCH {} -> 400 SACCOS_RISK_LIMITS_INVALID');

  const clampActive = await api('PATCH', `/api/saccos/${A.orgId}/loans/risk-limits`, A.ownerTok, { maxActiveLoans: 0 });
  const sumClamp = await api('GET', `/api/saccos/${A.orgId}/loans/risk`, A.ownerTok);
  await expect(clampActive.status === 200 && sumClamp.data.result.limits.maxActiveLoans === 1, 'PATCH active-loans 0 -> coerced to 1');

  await api('PATCH', `/api/saccos/${A.orgId}/loans/risk-limits`, A.ownerTok, { maxActiveLoans: 7 });

  const clampConc = await api('PATCH', `/api/saccos/${A.orgId}/loans/risk-limits`, A.ownerTok, { maxConcentrationPercent: 150 });
  const sumConc = await api('GET', `/api/saccos/${A.orgId}/loans/risk`, A.ownerTok);
  await expect(clampConc.status === 200 && sumConc.data.result.limits.maxConcentrationPercent === 100, 'PATCH concentration 150 -> clamped to 100');
  await api('PATCH', `/api/saccos/${A.orgId}/loans/risk-limits`, A.ownerTok, { maxConcentrationPercent: null });

  const negAmt = await api('PATCH', `/api/saccos/${A.orgId}/loans/risk-limits`, A.ownerTok, { maxExposureAmount: -50 });
  const sumNeg = await api('GET', `/api/saccos/${A.orgId}/loans/risk`, A.ownerTok);
  await expect(negAmt.status === 200 && sumNeg.data.result.limits.maxExposureAmount === null, 'PATCH exposure -50 -> null (disabled)');
  await api('PATCH', `/api/saccos/${A.orgId}/loans/risk-limits`, A.ownerTok, { maxExposureAmount: 150000 });

  const audits = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'SACCOS_RISK_LIMITS_UPDATED'`);
  await expect(audits.rows[0].n >= 1, 'audit trail has SACCOS_RISK_LIMITS_UPDATED rows', String(audits.rows[0].n));

  // ---------- 2. Exposure enforcement at application ----------
  await section('Exposure enforcement (applyLoan, absolute cap 150k)');
  const l1 = await api('POST', `/api/saccos/${A.orgId}/loans/apply`, m1.tok, { amount: 100000, termMonths: 12, purpose: 'Boda' });
  await expect(l1.status === 201 && String(l1.data.result.reference_id).startsWith('SCL-'), 'apply 100000 -> 201 SCL-*');
  const ap1 = await api('POST', `/api/saccos/${A.orgId}/loans/applications/${l1.data.result.id}/approve`, A.ownerTok);
  await expect(ap1.status === 200, 'approve 100000 (autoDisburse -> ACTIVE)');

  const l2 = await api('POST', `/api/saccos/${A.orgId}/loans/apply`, m1.tok, { amount: 30000, termMonths: 12 });
  await expect(l2.status === 201, 'apply 30000 (112k outstanding + 30k = 142k <= 150k cap) -> 201');
  const ap2 = await api('POST', `/api/saccos/${A.orgId}/loans/applications/${l2.data.result.id}/approve`, A.ownerTok);
  await expect(ap2.status === 200, 'approve 30000');

  const over = await api('POST', `/api/saccos/${A.orgId}/loans/apply`, m1.tok, { amount: 20000, termMonths: 12 });
  await expect(over.status === 400 && over.data.code === 'SACCOS_LOAN_EXPOSURE_EXCEEDED',
    'apply 20000 (145.6k + 20k > 150k cap) -> 400 SACCOS_LOAN_EXPOSURE_EXCEEDED', `${over.status}/${over.data.code || ''}`);

  const sum1 = await api('GET', `/api/saccos/${A.orgId}/loans/risk`, A.ownerTok);
  const b1 = (sum1.data.result.borrowers || []).find((b) => b.user_id === m1.userId);
  await expect(sum1.data.result.portfolio.gross_loans === 130000, 'GET risk gross_loans = 130000');
  await expect(b1 && b1.exposure === 145600 && b1.active_loans === 2 && b1.utilization_pct === 97.07,
    'borrower m1 exposure 145600 / 2 loans / utilization 97.07%', b1 ? JSON.stringify(b1) : 'missing');

  // ---------- 3. Org B: deposits-multiple cap ----------
  await section('Org B: deposits-multiple exposure cap (savings + shares)');
  const B = await setupOrg('LimitsB', 5201, {
    lending: { interestRate: 12, minAmount: 10000, maxAmount: 400000, maxTermMonths: 12, maxActiveLoans: 3, autoDisburse: true, maxExposureAmount: null, maxExposureMultiple: 2 },
  });
  const m2 = await joinMember(B.orgId, B.ownerTok, phone(5602), 'Risk Member Two', 300000);
  await api('POST', `/api/saccos/${B.orgId}/savings/deposit`, m2.tok, { amount: 40000 });
  const sh = await api('POST', `/api/saccos/${B.orgId}/shares/purchase`, m2.tok, { shares: 2 });
  await expect(sh.status === 201 && sh.data.success === true, 'm2 deposits 40000 + buys 2 shares (20000)');

  const bSum = await api('GET', `/api/saccos/${B.orgId}/loans/risk`, B.ownerTok);
  await expect(bSum.data.result.limits.maxExposureAmount === null && bSum.data.result.limits.maxExposureMultiple === 2,
    'GET risk orgB -> multiple 2, absolute null');

  const bB1 = await api('POST', `/api/saccos/${B.orgId}/loans/apply`, m2.tok, { amount: 80000, termMonths: 12 });
  await expect(bB1.status === 201, 'apply 80000 (0 + 80k <= 120k multiple cap) -> 201');
  const bAp1 = await api('POST', `/api/saccos/${B.orgId}/loans/applications/${bB1.data.result.id}/approve`, B.ownerTok);
  await expect(bAp1.status === 200, 'approve 80000 (autoDisburse -> outstanding 89600)');

  const bBOver = await api('POST', `/api/saccos/${B.orgId}/loans/apply`, m2.tok, { amount: 50000, termMonths: 12 });
  await expect(bBOver.status === 400 && bBOver.data.code === 'SACCOS_LOAN_EXPOSURE_EXCEEDED',
    'apply 50000 (89.6k + 50k > 120k multiple cap) -> 400 SACCOS_LOAN_EXPOSURE_EXCEEDED', `${bBOver.status}/${bBOver.data.code || ''}`);

  const bB2 = await api('POST', `/api/saccos/${B.orgId}/loans/apply`, m2.tok, { amount: 25000, termMonths: 12 });
  await expect(bB2.status === 201, 'apply 25000 (89.6k + 28k = 117.6k <= 120k cap) -> 201');
  const bAp2 = await api('POST', `/api/saccos/${B.orgId}/loans/applications/${bB2.data.result.id}/approve`, B.ownerTok);
  await expect(bAp2.status === 200, 'approve 25000 (outstanding 28000)');

  const bSum2 = await api('GET', `/api/saccos/${B.orgId}/loans/risk`, B.ownerTok);
  const b2row = (bSum2.data.result.borrowers || []).find((b) => b.user_id === m2.userId);
  await expect(b2row && b2row.exposure === 117600 && b2row.active_loans === 2, 'borrower m2 exposure 117600 / 2 loans',
    b2row ? JSON.stringify(b2row) : 'missing');

  // ---------- 4. Org C: single-borrower concentration cap ----------
  await section('Org C: concentration cap at approval (30%)');
  const C = await setupOrg('LimitsC', 5301, {
    lending: { interestRate: 12, minAmount: 10000, maxAmount: 300000, maxTermMonths: 12, maxActiveLoans: 4, autoDisburse: true, maxConcentrationPercent: 30 },
  });
  const m3 = await joinMember(C.orgId, C.ownerTok, phone(5303), 'Concentration Seed A', null);
  const m4 = await joinMember(C.orgId, C.ownerTok, phone(5304), 'Concentration Seed B', null);
  const m5 = await joinMember(C.orgId, C.ownerTok, phone(5305), 'Concentration Big', null);
  const m8 = await joinMember(C.orgId, C.ownerTok, phone(5308), 'Concentration Fresh', null);

  const cSum = await api('GET', `/api/saccos/${C.orgId}/loans/risk`, C.ownerTok);
  await expect(cSum.data.result.limits.maxConcentrationPercent === 30, 'GET risk orgC -> concentration 30');

  const c3 = await api('POST', `/api/saccos/${C.orgId}/loans/apply`, m3.tok, { amount: 100000, termMonths: 12 });
  const a3 = await api('POST', `/api/saccos/${C.orgId}/loans/applications/${c3.data.result.id}/approve`, C.ownerTok);
  await expect(c3.status === 201 && a3.status === 200, 'seed m3 100000 approved (empty portfolio bootstrap)');

  const c4 = await api('POST', `/api/saccos/${C.orgId}/loans/apply`, m4.tok, { amount: 40000, termMonths: 12 });
  const a4 = await api('POST', `/api/saccos/${C.orgId}/loans/applications/${c4.data.result.id}/approve`, C.ownerTok);
  await expect(a4.status === 200, 'seed m4 40000 approved (40000/140000 = 28.6% <= 30%)', `${a4.status}/${a4.data.code || ''}`);

  const c5a = await api('POST', `/api/saccos/${C.orgId}/loans/apply`, m5.tok, { amount: 40000, termMonths: 12 });
  const a5a = await api('POST', `/api/saccos/${C.orgId}/loans/applications/${c5a.data.result.id}/approve`, C.ownerTok);
  await expect(a5a.status === 200, 'm5 40000 approved (40000/180000 = 22.2% <= 30%)');

  const c5b = await api('POST', `/api/saccos/${C.orgId}/loans/apply`, m5.tok, { amount: 40000, termMonths: 12 });
  const a5b = await api('POST', `/api/saccos/${C.orgId}/loans/applications/${c5b.data.result.id}/approve`, C.ownerTok);
  await expect(a5b.status === 400 && a5b.data.code === 'SACCOS_LOAN_CONCENTRATION_EXCEEDED',
    'm5 extra 40000 ((44.8k+40k)/220k = 38.5% > 30%) -> 400 SACCOS_LOAN_CONCENTRATION_EXCEEDED', `${a5b.status}/${a5b.data.code || ''}`);

  const c5c = await api('POST', `/api/saccos/${C.orgId}/loans/apply`, m5.tok, { amount: 30000, termMonths: 12 });
  const a5c = await api('POST', `/api/saccos/${C.orgId}/loans/applications/${c5c.data.result.id}/approve`, C.ownerTok);
  await expect(a5c.status === 400 && a5c.data.code === 'SACCOS_LOAN_CONCENTRATION_EXCEEDED',
    'm5 extra 30000 ((44.8k+30k)/210k = 35.6% > 30%) -> 400 SACCOS_LOAN_CONCENTRATION_EXCEEDED');

  const c8 = await api('POST', `/api/saccos/${C.orgId}/loans/apply`, m8.tok, { amount: 30000, termMonths: 12 });
  const a8 = await api('POST', `/api/saccos/${C.orgId}/loans/applications/${c8.data.result.id}/approve`, C.ownerTok);
  await expect(a8.status === 200, 'fresh m8 30000 approved (30000/210000 = 14.3% <= 30%)');

  const cSum2 = await api('GET', `/api/saccos/${C.orgId}/loans/risk`, C.ownerTok);
  const c3row = (cSum2.data.result.borrowers || []).find((b) => b.user_id === m3.userId);
  await expect(cSum2.data.result.portfolio.gross_loans === 210000, 'GET risk orgC gross_loans = 210000',
    String(cSum2.data.result.portfolio.gross_loans));
  await expect(c3row && c3row.exposure === 112000, 'borrower m3 exposure 112000 (incl. flat interest)', c3row ? JSON.stringify(c3row) : 'missing');

  // ---------- 5. Org D: disabled-by-default limits ----------
  await section('Org D: risk limits disabled by default');
  const D = await setupOrg('LimitsD', 5401, {});
  const dSum = await api('GET', `/api/saccos/${D.orgId}/loans/risk`, D.ownerTok);
  await expect(dSum.status === 200 && dSum.data.result.limits.maxExposureAmount === null
    && dSum.data.result.limits.maxExposureMultiple === null && dSum.data.result.limits.maxConcentrationPercent === null
    && dSum.data.result.limits.maxActiveLoans === 1 && dSum.data.result.portfolio.gross_loans === 0,
    'defaults: all risk caps null, active 1, portfolio empty');

  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

let suffix;
const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;
main().catch((e) => { console.error(e); process.exit(1); });