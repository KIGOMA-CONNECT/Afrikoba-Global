/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - LENDING PRODUCTS
 * (increment 19, suite 62)
 *
 * migration 118 adds OWNER/BOARD-defined lending products so a
 * SACCOS issues loans against a named product instead of only the
 * flat saccos-wide `lending` config:
 *
 * `saccos_lending_products` (code UNIQUE per saccos, flat
 * interest_rate_percent 0-100, min_amount >= 0, nullable
 * max_amount, max_term_months 1-120, ACTIVE|ARCHIVED). Products
 * are created/archived by OWNER/BOARD (member 403 SACCOS_RBAC).
 *
 * A member applies with an optional `productId`:
 *  - the product's min/max/term gate the request
 *    (SACCOS_LOAN_BELOW_MIN / ABOVE_MAX / TERM_TOO_LONG);
 *  - the rate is snapshotted onto the application (rate_percent)
 *    at apply time and onto the loan (interest_rate, product_id)
 *    at approval, so downstream flows (repayments, installments,
 *    restructure, arrears) keep using the loan's own rate.
 *  - ARCHIVED products reject new applications
 *    (SACCOS_LOAN_PRODUCT_ARCHIVED); product id from another
 *    saccos -> SACCOS_LOAN_PRODUCT_NOT_FOUND.
 *
 * No-product applications keep the flat saccos-wide config rate.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0, failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) { failed++; failures.push(label); console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`); }
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra); }
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET';
  const res = await fetch(BASE + path, { method, headers, body: !isGet && body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) { data = {}; }
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
  await pool.query('UPDATE users SET wallet_balance = $2 WHERE id = $1', [userId, amount]);
}
async function setLendingConfig(orgId, overrides) {
  const base = {
    interestRate: 12, minAmount: 10000, maxAmount: null, maxTermMonths: 36,
    maxActiveLoans: 10, autoDisburse: true, graceDays: 0, lateFeePercent: 2,
    savingsBackingEnabled: false, savingsBackingMultiple: 3, guaranteesRequired: 0,
  };
  Object.assign(base, overrides || {});
  await pool.query(
    `UPDATE saccos SET config = COALESCE(config, '{}') || $2::jsonb WHERE id = $1`,
    [orgId, JSON.stringify({ lending: base })]
  );
}

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (118_saccos_lending_products)');
  const tables = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_lending_products'`
  );
  const tcols = tables.rows.map((r) => r.column_name);
  await expect(tables.rows.length >= 8 && tcols.includes('code') && tcols.includes('interest_rate_percent')
    && tcols.includes('max_amount') && tcols.includes('max_term_months') && tcols.includes('status'),
    'saccos_lending_products table with code/rate/min/max/term/status', tcols.join(','));
  const appCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_applications'
       AND column_name IN ('product_id', 'rate_percent')
     UNION ALL
     SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loans'
       AND column_name = 'product_id'`
  );
  await expect(appCols.rows.length === 3, 'product_id + rate_percent on applications, product_id on loans');
  const unique = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = 'saccos_lending_products'::regclass AND c.contype = 'u'`
  );
  await expect(unique.rows.some((r) => r.def.includes('saccos_id') && r.def.includes('code')), 'UNIQUE(saccos_id, code)');
  const statusChk = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = 'saccos_lending_products'::regclass AND c.contype = 'c'`
  );
  await expect(statusChk.rows.some((r) => r.def.includes('ARCHIVED')), 'status CHECK accepts ACTIVE|ARCHIVED');

  // ---------- 2. Setup ----------
  await section('Setup: SACCOS + members');
  const ownerReg = await register(phone(9401), 'Bidhaa Mwenyekiti');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Bidhaa Za Mikopo ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);
  const membReg = await register(phone(9402), 'Bidhaa Mwanachama');
  const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(9402) });
  const mid = inv.data.result.id;
  await api('POST', `/api/saccos/${orgId}/members/${mid}/accept`, membReg.data.token);
  const memTok = membReg.data.token;
  await fundWallet(membReg.data.user.id, 1000000);
  await setLendingConfig(orgId, {});

  // ---------- 3. Product CRUD + RBAC ----------
  await section('Product CRUD + RBAC');
  const rbac = await api('POST', `/api/saccos/${orgId}/loans/products`, memTok, { code: 'X', name: 'Sio Kwako', interestRatePercent: 10, minAmount: 0, maxTermMonths: 6 });
  await expect(rbac.status === 403 && rbac.data.code === 'SACCOS_RBAC', 'member creates product -> 403 RBAC');

  const p1 = await api('POST', `/api/saccos/${orgId}/loans/products`, ownerTok, {
    code: 'elimu', name: 'Mkopo wa Elimu', description: 'Shule na vyuo',
    interestRatePercent: 18, minAmount: 50000, maxAmount: 500000, maxTermMonths: 24,
  });
  await expect(p1.status === 201 && p1.data.result.code === 'ELIMU' && p1.data.result.status === 'ACTIVE'
    && Number(p1.data.result.interest_rate_percent) === 18 && Number(p1.data.result.max_amount) === 500000,
    'owner creates ELIMU product (code uppercased, rate 18%)', JSON.stringify(p1.data.result));
  const p1Id = p1.data.result.id;

  const dup = await api('POST', `/api/saccos/${orgId}/loans/products`, ownerTok, {
    code: 'elimu', name: 'Nakili', interestRatePercent: 10, minAmount: 0, maxTermMonths: 6,
  });
  await expect(dup.status === 400 && dup.data.code === 'SACCOS_LOAN_PRODUCT_CODE_TAKEN', 'duplicate code -> 400 CODE_TAKEN');

  const badRate = await api('POST', `/api/saccos/${orgId}/loans/products`, ownerTok, {
    code: 'B1', name: 'Bure', interestRatePercent: 150, minAmount: 0, maxTermMonths: 6,
  });
  await expect(badRate.status === 400 && badRate.data.code === 'SACCOS_LOAN_PRODUCT_INVALID', 'rate 150% -> 400 INVALID');

  const badBand = await api('POST', `/api/saccos/${orgId}/loans/products`, ownerTok, {
    code: 'B2', name: 'Kinyume', interestRatePercent: 10, minAmount: 100000, maxAmount: 50000, maxTermMonths: 6,
  });
  await expect(badBand.status === 400 && badBand.data.code === 'SACCOS_LOAN_PRODUCT_INVALID', 'min>max band -> 400 INVALID');

  const p2 = await api('POST', `/api/saccos/${orgId}/loans/products`, ownerTok, {
    code: 'JUMBAA', name: 'Mkopo wa Jumba', interestRatePercent: 20, minAmount: 0, maxAmount: null, maxTermMonths: 12,
  });
  await expect(p2.status === 201 && p2.data.result.max_amount === null, 'unlimited JUMBAA product (max NULL)');
  const p2Id = p2.data.result.id;

  // ---------- 4. Product gates at application ----------
  await section('Product gates at application + flat fallback');
  const below = await api('POST', `/api/saccos/${orgId}/loans/apply`, memTok, { amount: 30000, termMonths: 6, productId: p1Id });
  await expect(below.status === 400 && below.data.code === 'SACCOS_LOAN_BELOW_MIN', 'below product min 50000 -> BELOW_MIN');
  const above = await api('POST', `/api/saccos/${orgId}/loans/apply`, memTok, { amount: 800000, termMonths: 6, productId: p1Id });
  await expect(above.status === 400 && above.data.code === 'SACCOS_LOAN_ABOVE_MAX', 'above product max 500000 -> ABOVE_MAX');
  const longTerm = await api('POST', `/api/saccos/${orgId}/loans/apply`, memTok, { amount: 100000, termMonths: 36, productId: p1Id });
  await expect(longTerm.status === 400 && longTerm.data.code === 'SACCOS_LOAN_TERM_TOO_LONG', 'term 36 > product 24 -> TERM_TOO_LONG');

  const crossSaccos = await register(phone(9403), 'Shirika la Nje');
  const crossTok = crossSaccos.data.token;
  const s2 = await api('POST', '/api/v1/saccos', crossTok, { name: 'Nje Bidhaa ' + suffix });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, crossTok);
  const crossProd = await api('POST', `/api/saccos/${orgId}/loans/apply`, memTok, { amount: 100000, termMonths: 6, productId: p2Id + 9999 });
  await expect(crossProd.status === 404 && crossProd.data.code === 'SACCOS_LOAN_PRODUCT_NOT_FOUND', 'unknown product id -> 404 NOT_FOUND');

  const app1 = await api('POST', `/api/saccos/${orgId}/loans/apply`, memTok, { amount: 100000, termMonths: 6, purpose: 'Elimu', productId: p1Id });
  await expect(app1.status === 201 && app1.data.result.status === 'PENDING' && app1.data.result.product_id === p1Id
    && Number(app1.data.result.rate_percent) === 18,
    'app with product -> 201 PENDING, product_id set, rate snapped 18%', JSON.stringify(app1.data.result));
  const app1Id = app1.data.result.id;

  const app2 = await api('POST', `/api/saccos/${orgId}/loans/apply`, memTok, { amount: 100000, termMonths: 6 });
  await expect(app2.status === 201 && app2.data.result.product_id === null
    && Number(app2.data.result.rate_percent) === 12,
    'no-product app -> product_id null, rate = flat config 12%', JSON.stringify(app2.data.result));
  const app2Id = app2.data.result.id;

  const app3 = await api('POST', `/api/saccos/${orgId}/loans/apply`, memTok, { amount: 700000, termMonths: 6, productId: p2Id });
  await expect(app3.status === 201 && app3.data.result.product_id === p2Id && Number(app3.data.result.rate_percent) === 20,
    'unlimited JUMBAA product accepts 700000 @ 20%', JSON.stringify(app3.data.result));
  const app3Id = app3.data.result.id;

  // ---------- 5. Approval stamps product rate onto the loan ----------
  await section('Approval rate provenance + full repayment');
  const apr1 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app1Id}/approve`, ownerTok);
  await expect(apr1.status === 200 && apr1.data.success === true, 'approve product app -> OK');
  const loan1 = await pool.query(`SELECT id, interest_rate, status, product_id FROM saccos_loans WHERE application_id = $1`, [app1Id]);
  await expect(Number(loan1.rows[0].interest_rate) === 18 && loan1.rows[0].product_id === p1Id
    && loan1.rows[0].status === 'ACTIVE', 'Loan1 active with interest_rate 18 + product_id' , JSON.stringify(loan1.rows[0]));

  const apr2 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app2Id}/approve`, ownerTok);
  await expect(apr2.data.success === true, 'approve flat app -> OK');
  const loan2 = await pool.query(`SELECT id, interest_rate, product_id FROM saccos_loans WHERE application_id = $1`, [app2Id]);
  await expect(Number(loan2.rows[0].interest_rate) === 12 && loan2.rows[0].product_id === null,
    'Loan2 flat rate 12, product_id null', JSON.stringify(loan2.rows[0]));

  const apr3 = await api('POST', `/api/saccos/${orgId}/loans/applications/${app3Id}/approve`, ownerTok);
  await expect(apr3.data.success === true, 'approve JUMBAA app -> OK');
  const loan3 = await pool.query(`SELECT id, interest_rate, product_id FROM saccos_loans WHERE application_id = $1`, [app3Id]);
  await expect(Number(loan3.rows[0].interest_rate) === 20 && loan3.rows[0].product_id === p2Id,
    'Loan3 JUMBAA rate 20, product_id set', JSON.stringify(loan3.rows[0]));

  const l1Id = loan1.rows[0].id;
  const total1 = Number((await pool.query(`SELECT total_repayable FROM saccos_loans WHERE id = $1`, [l1Id])).rows[0].total_repayable);
  await expect(total1 === 109000, `Loan1 total 109000 @18%/6mo (${total1})`);
  const rep1 = await api('POST', `/api/saccos/${orgId}/loans/${l1Id}/repay`, memTok, { amount: total1 });
  await expect(rep1.status === 201 && rep1.data.result.closed === true, 'full repayment closes product loan', JSON.stringify(rep1.data.result));
  const loan1After = await pool.query(`SELECT status FROM saccos_loans WHERE id = $1`, [l1Id]);
  const app1After = await pool.query(`SELECT status FROM saccos_loan_applications WHERE id = $1`, [app1Id]);
  await expect(loan1After.rows[0].status === 'CLOSED' && app1After.rows[0].status === 'REPAID', 'Loan1 CLOSED + application REPAID');

  // ---------- 6. Archive + visibility + list provenance ----------
  await section('Archive + list provenance');
  const arc = await api('POST', `/api/saccos/${orgId}/loans/products/${p1Id}/archive`, ownerTok);
  await expect(arc.status === 200 && arc.data.result.status === 'ARCHIVED', 'owner archives ELIMU -> ARCHIVED');
  const arcRbac = await api('POST', `/api/saccos/${orgId}/loans/products/${p2Id}/archive`, memTok);
  await expect(arcRbac.status === 403 && arcRbac.data.code === 'SACCOS_RBAC', 'member archives product -> 403 RBAC');
  const appArch = await api('POST', `/api/saccos/${orgId}/loans/apply`, memTok, { amount: 100000, termMonths: 6, productId: p1Id });
  await expect(appArch.status === 400 && appArch.data.code === 'SACCOS_LOAN_PRODUCT_ARCHIVED', 'apply with ARCHIVED product -> 400 ARCHIVED');

  const listP = await api('GET', `/api/saccos/${orgId}/loans/products`, memTok);
  await expect(listP.status === 200 && listP.data.result.length === 2 && listP.data.result[0].status === 'ACTIVE'
    && listP.data.result[1].status === 'ARCHIVED', 'members list products (active first, archived last)', JSON.stringify(listP.data.result.map((x) => x.code)));
  const mine = await api('GET', `/api/saccos/${orgId}/loans/mine`, memTok);
  const mineLoans = mine.data.result.loans;
  await expect(mine.status === 200 && mineLoans.every((l) => l.product_code === null || l.product_code === 'ELIMU' || l.product_code === 'JUMBAA')
    && mineLoans.some((l) => l.product_code === 'ELIMU'), 'listMyLoans join surfaces product_code', JSON.stringify(mineLoans.map((l) => l.product_code)));

  const allApps = await api('GET', `/api/saccos/${orgId}/loans/applications`, ownerTok);
  await expect(allApps.status === 200 && allApps.data.result.some((a) => a.product_code === 'ELIMU'),
    'listApplications join surfaces product_code');

  const audit = await pool.query(
    `SELECT DISTINCT action FROM audit_logs WHERE action IN ('SACCOS_LOAN_PRODUCT_CREATED', 'SACCOS_LOAN_PRODUCT_ARCHIVED')`
  );
  await expect(audit.rows.length === 2, 'product create/archive audit actions recorded');

  const unauth = await api('GET', `/api/saccos/${orgId}/loans/products`, null);
  await expect(unauth.status === 401, 'unauthenticated products list -> 401');

  console.log(`\nSACCOS LENDING PRODUCTS: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });