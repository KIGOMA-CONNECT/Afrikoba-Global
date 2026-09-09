/* ============================================================
 * AFRIKOBA GLOBAL - MICRO-INSURANCE REGRESSION
 * Seed product catalogue (public list + category filter), policy
 * purchase (premium debit → canonical engine with balanced
 * ledger journal / INSURANCE_PREMIUM txn), age/product guards,
 * ownership-scoped policy list, renew (premium_paid growth /
 * next_premium_date advance / INSURANCE_PREMIUM_RENEWAL txn),
 * insufficient-funds guard on purchase + renew. Covers
 * /api/eco/insurance/* (v1 + legacy aliases). Suite 43.
 * ============================================================ */
const BASE = process.env.INSURANCE_TEST_BASE || 'http://127.0.0.1:3000';
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
    return ref;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function balance(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}
async function policyNextDue(userId, policyId) {
  const r = await pool.query('SELECT next_premium_date, premium_paid FROM insurance_policies WHERE id = $1 AND user_id = $2', [policyId, userId]);
  const row = r.rows[0];
  return { next: row.next_premium_date ? String(row.next_premium_date) : null, premium: Number(row.premium_paid) };
}
function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const holder = await register(`255770${suffix}`, 'Ins Holder');
  const other = await register(`255771${suffix}`, 'Ins Other');
  const broke = await register(`255772${suffix}`, 'Ins Broke');
  await expect(holder.data.token && other.data.token && broke.data.token, 'Users registered');
  const holderTok = holder.data.token;
  const otherTok = other.data.token;
  const brokeTok = broke.data.token;

  await section('Schema + seed evidence');
  const psc = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'insurance_products'`
  );
  const pcols = psc.rows.map((r) => r.column_name);
  await expect(['name', 'category', 'premium_monthly', 'coverage_amount', 'min_age', 'max_age', 'waiting_period_days'].every((c) => pcols.includes(c)),
    'insurance_products schema (name/category/premium_monthly/coverage_amount/age bands)');
  const plc = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'insurance_policies'`
  );
  const lcols = plc.rows.map((r) => r.column_name);
  await expect(['user_id', 'product_id', 'status', 'premium_paid', 'next_premium_date', 'coverage_start', 'coverage_end'].every((c) => lcols.includes(c)),
    'insurance_policies schema (status/premium_paid/next_premium_date/coverage window)');

  const prodList = await api('GET', '/api/eco/insurance/products');
  await expect(prodList.status === 200 && Array.isArray(prodList.data.products), 'Products list public', `status=${prodList.status}`);
  await expect(prodList.data.products.length >= 4, 'Seed catalogue ≥ 4 products', `got=${prodList.data.products.length}`);
  const afya = prodList.data.products.find((p) => p.name === 'Afya Bora');
  await expect(!!afya && afya.category === 'HEALTH' && Number(afya.premium_monthly) === 5000 && Number(afya.coverage_amount) === 2000000,
    'Afya Bora seeded (HEALTH, 5000 TZS/mo, 2M coverage)', afya ? JSON.stringify({ c: afya.category, p: afya.premium_monthly }) : 'missing');
  const healthOnly = await api('GET', '/api/eco/insurance/products?category=HEALTH');
  await expect(healthOnly.status === 200 && healthOnly.data.products.length >= 1 && healthOnly.data.products.every((p) => p.category === 'HEALTH'),
    'Category filter HEALTH → HEALTH only', `n=${healthOnly.data.products.length}`);
  const noneCat = await api('GET', '/api/eco/insurance/products?category=FANTASY');
  await expect(noneCat.status === 200 && noneCat.data.products.length === 0, 'Unknown category filter → empty');

  await section('Purchase — guards');
  const anonBuy = await api('POST', '/api/eco/insurance/purchase');
  await expect(anonBuy.status === 401, 'Purchase anonymous → 401', `status=${anonBuy.status}`);
  const badProd = await api('POST', '/api/eco/insurance/purchase', holderTok, { product_id: 999999, age: 30 });
  await expect(badProd.status === 404 && badProd.data.code === 'INSURANCE_PRODUCT_NOT_FOUND',
    'Purchase unknown product → 404 INSURANCE_PRODUCT_NOT_FOUND', `status=${badProd.status} code=${badProd.data.code}`);
  const tooYoung = await api('POST', '/api/eco/insurance/purchase', holderTok, { product_id: afya.id, age: 17 });
  await expect(tooYoung.status === 400 && tooYoung.data.code === 'INSURANCE_AGE_INVALID',
    'Purchase below min_age → 400 INSURANCE_AGE_INVALID', `status=${tooYoung.status} code=${tooYoung.data.code}`);
  const tooOld = await api('POST', '/api/eco/insurance/purchase', holderTok, { product_id: afya.id, age: 70 });
  await expect(tooOld.status === 400 && tooOld.data.code === 'INSURANCE_AGE_INVALID',
    'Purchase above max_age → 400 INSURANCE_AGE_INVALID', `status=${tooOld.status} code=${tooOld.data.code}`);
  const brokeBuy = await api('POST', '/api/eco/insurance/purchase', brokeTok, { product_id: afya.id, age: 30 });
  await expect(brokeBuy.status === 400 && brokeBuy.data.code === 'WALLET_INSUFFICIENT_FUNDS',
    'Purchase without funds → 400 WALLET_INSUFFICIENT_FUNDS', `status=${brokeBuy.status} code=${brokeBuy.data.code}`);

  await section('Purchase — canonical premium debit');
  await fundWallet(holder.data.user.id, 100000);
  const buy = await api('POST', '/api/eco/insurance/purchase', holderTok, { product_id: afya.id, age: 35 });
  await expect(buy.status === 200 && !!buy.data.policy, 'Purchase returns policy', `status=${buy.status}`);
  const policyId = buy.data.policy.id;
  await expect(buy.data.policy.status === 'ACTIVE', 'Policy status ACTIVE', buy.data.policy.status);
  await expect(Number(buy.data.policy.premium_paid) === 5000, 'premium_paid = 5000', String(buy.data.policy.premium_paid));
  const covStart = String(buy.data.policy.coverage_start);
  const isToday = await pool.query(`SELECT (SELECT coverage_start FROM insurance_policies WHERE id = $1) = CURRENT_DATE AS ok`, [policyId]);
  await expect(isToday.rows[0].ok === true, 'coverage_start = today (DB CURRENT_DATE)', covStart);
  const nextDue = String(buy.data.policy.next_premium_date);
  await expect(nextDue > covStart, 'next_premium_date advanced ≥ 1 month', nextDue);
  const balAfterBuy = await balance(holder.data.user.id);
  await expect(balAfterBuy === 95000, 'Wallet debited 5000 (100000 → 95000)', String(balAfterBuy));

  const premTx = await pool.query(
    `SELECT reference_id, wallet_amount, meta FROM transactions WHERE user_id = $1 AND type = 'WITHDRAWAL' AND meta->>'type' = 'INSURANCE_PREMIUM' ORDER BY id DESC LIMIT 1`,
    [holder.data.user.id]
  );
  await expect(premTx.rows.length === 1, 'INSURANCE_PREMIUM transaction recorded', premTx.rows.length > 0 ? '' : 'none');
  const premRef = premTx.rows[0].reference_id;
  await expect(String(premRef).startsWith('INS-'), 'Premium reference INS-*', premRef);
  await expect(Number(premTx.rows[0].wallet_amount) === 5000, 'Premium txn wallet_amount = 5000', String(premTx.rows[0].wallet_amount));
  const je = await pool.query(
    `SELECT j.direction, j.amount, la.account_code AS acct
     FROM journal_entries j JOIN ledger_accounts la ON la.id = j.account_id
     WHERE j.reference_id = $1`, [premRef]
  );
  const dr = je.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
  const cr = je.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
  const hasMno = je.rows.some((r) => r.acct === 'MNO_CLEARING');
  await expect(je.rows.length === 2 && dr === 5000 && cr === 5000 && hasMno,
    'Premium ledger journal balanced (DR CUSTOMER_WALLET = CR MNO_CLEARING = 5000)', JSON.stringify(je.rows.map((r) => ({ a: r.acct, d: r.direction, v: Number(r.amount) }))));

  const polList = await api('GET', '/api/eco/insurance/policies', holderTok);
  await expect(polList.status === 200 && polList.data.policies.length === 1, 'Policies list: 1 owned policy', `n=${polList.data.policies.length}`);
  const polRow = polList.data.policies[0];
  await expect(polRow.product_name === 'Afya Bora' && polRow.category === 'HEALTH' && Number(polRow.coverage_amount) === 2000000,
    'Policy joined with product name/category/coverage');
  const polOther = await api('GET', '/api/eco/insurance/policies', otherTok);
  await expect(polOther.data.policies.length === 0, 'Other user sees no policies (ownership scope)');

  await section('Renew — premium_paid growth + advance');
  const otherRenew = await api('POST', `/api/eco/insurance/renew/${policyId}`, otherTok);
  await expect(otherRenew.status === 404 && otherRenew.data.code === 'INSURANCE_POLICY_NOT_FOUND',
    'Renew another user policy → 404 INSURANCE_POLICY_NOT_FOUND', `status=${otherRenew.status} code=${otherRenew.data.code}`);
  const ghostRenew = await api('POST', '/api/eco/insurance/renew/999999', holderTok);
  await expect(ghostRenew.status === 404 && ghostRenew.data.code === 'INSURANCE_POLICY_NOT_FOUND',
    'Renew unknown policy → 404 INSURANCE_POLICY_NOT_FOUND', `status=${ghostRenew.status} code=${ghostRenew.data.code}`);
  const beforeRenew = await policyNextDue(holder.data.user.id, policyId);
  const renew = await api('POST', `/api/eco/insurance/renew/${policyId}`, holderTok);
  await expect(renew.status === 200 && renew.data.success === true, 'Renew own policy → success', `status=${renew.status}`);
  const afterRenew = await policyNextDue(holder.data.user.id, policyId);
  await expect(afterRenew.premium === 10000, 'premium_paid 5000 → 10000', String(afterRenew.premium));
  await expect(afterRenew.next !== beforeRenew.next && afterRenew.next > beforeRenew.next, 'next_premium_date advanced +1 month', `${beforeRenew.next} → ${afterRenew.next}`);
  const balAfterRenew = await balance(holder.data.user.id);
  await expect(balAfterRenew === 90000, 'Wallet debited another 5000 (95000 → 90000)', String(balAfterRenew));
  const renTx = await pool.query(
    `SELECT wallet_amount FROM transactions WHERE user_id = $1 AND type = 'WITHDRAWAL' AND meta->>'type' = 'INSURANCE_PREMIUM_RENEWAL' ORDER BY id DESC LIMIT 1`,
    [holder.data.user.id]
  );
  await expect(renTx.rows.length === 1 && Number(renTx.rows[0].wallet_amount) === 5000,
    'INSURANCE_PREMIUM_RENEWAL txn recorded (wallet_amount 5000)');

  await section('Renew — insufficient funds');
  await pool.query('UPDATE users SET wallet_balance = 0 WHERE id = $1', [holder.data.user.id]);
  const dryRenew = await api('POST', `/api/eco/insurance/renew/${policyId}`, holderTok);
  await expect(dryRenew.status === 400 && dryRenew.data.code === 'WALLET_INSUFFICIENT_FUNDS',
    'Renew without funds → 400 WALLET_INSUFFICIENT_FUNDS', `status=${dryRenew.status} code=${dryRenew.data.code}`);
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + 100000 WHERE id = $1', [holder.data.user.id]);
  const stillActive = await pool.query('SELECT status, premium_paid FROM insurance_policies WHERE id = $1', [policyId]);
  await expect(stillActive.rows[0].status === 'ACTIVE' && Number(stillActive.rows[0].premium_paid) === 10000,
    'Failed renewal leaves policy ACTIVE + premium_paid unchanged');

  await section('Multi-product — age optional');
  const crop = prodList.data.products.find((p) => p.category === 'CROP');
  const buyCrop = await api('POST', '/api/eco/insurance/purchase', holderTok, { product_id: crop.id });
  await expect(buyCrop.status === 200 && !!buyCrop.data.policy, 'Purchase without age → success (age optional)', `status=${buyCrop.status}`);
  const polList2 = await api('GET', '/api/eco/insurance/policies', holderTok);
  await expect(polList2.data.policies.length === 2, 'Policies list now 2 (multi-product)', `n=${polList2.data.policies.length}`);

  console.log(failed === 0
    ? `\nPASSED ${passed}/${passed + failed} checks`
    : `\nFAILED ${failed}/${passed + failed} checks — ${failures.join('; ')}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SUITE_ERROR', e);
  process.exit(1);
});