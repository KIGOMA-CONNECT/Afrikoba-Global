/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - INVESTMENTS
 * Increment 7 regression (final SACCOS increment): entity-scoped
 * member term investments. OWNER/BOARD define products (INVP-*),
 * members subscribe (INV-*) auto-approved or OWNER/BOARD-approved
 * (config.investments.autoApprove). Subscription = `debitWallet`
 * DR CUSTOMER_WALLET / CR per-entity LIABILITY
 * `SACCOS<id>_INVESTMENTS_LIABILITY` + SACCOS_INVESTMENT_
 * SUBSCRIPTION txn. Redemption at maturity = flat interest
 * (principal * rate% * term/12) via 3-leg journal DR LIABILITY +
 * DR `SACCOS<id>_INVESTMENT_INTEREST_EXPENSE` / CR CUSTOMER_WALLET,
 * idempotent on RED-*; reject path returns nothing (no funds moved
 * while PENDING). Cross-entity 404, member RBAC 403, ADMIN
 * oversight, audit trail. Config investments {autoApprove,min,
 * maxAmount,defaultAnnualRatePercent,defaultTermMonths}.
 * Suite 51.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

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
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = $2 WHERE id = $1', [userId, amount]);
}
function nowSuffix() { return String(Date.now()).slice(-6); }

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  async function addMember(ownerTok, orgId, pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return reg;
  }

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (107_saccos_investments)');
  const prodCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_investment_products'`);
  await expect(['reference_id', 'name', 'min_amount', 'max_amount', 'annual_rate_percent', 'term_months', 'status'].every((c) => prodCols.rows.some((r) => r.column_name === c)),
    'saccos_investment_products columns present');
  const invCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_investments'`);
  await expect(['reference_id', 'amount', 'annual_rate_percent', 'expected_interest', 'status', 'maturity_date'].every((c) => invCols.rows.some((r) => r.column_name === c)),
    'saccos_investments columns present');

  // ---------- 2. Products + guards ----------
  await section('Products + guards');
  const ownerReg = await register(phone(7001), 'Mwekezaji Kiongozi');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Uwekezaji Shahada ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  const m1 = await addMember(ownerTok, orgId, 7002, 'Mwekezaji 1');
  const m2 = await addMember(ownerTok, orgId, 7003, 'Mwekezaji 2');

  const memberProd = await api('POST', `/api/saccos/${orgId}/investments/products`, m1.data.token, { name: 'Sipaswi' });
  await expect(memberProd.status === 403 && memberProd.data.code === 'SACCOS_RBAC', 'member cannot create product -> 403');

  const prod = await api('POST', `/api/saccos/${orgId}/investments/products`, ownerTok, { name: 'Hisa Za Ukuaji', minAmount: 5000, maxAmount: 500000 });
  await expect(prod.status === 201 && String(prod.data.result.reference_id).startsWith('INVP-') && prod.data.result.status === 'ACTIVE'
    && Number(prod.data.result.annual_rate_percent) === 10 && prod.data.result.term_months === 12,
    'product created -> INVP-* ACTIVE with default 10% / 12m', JSON.stringify({ rate: prod.data.result.annual_rate_percent, term: prod.data.result.term_months }));
  const productId = prod.data.result.id;

  const memberArchive = await api('POST', `/api/saccos/${orgId}/investments/products/${productId}/archive`, m1.data.token);
  await expect(memberArchive.status === 403 && memberArchive.data.code === 'SACCOS_RBAC', 'member cannot archive product -> 403');

  const prodList = await api('GET', `/api/saccos/${orgId}/investments/products`, m1.data.token);
  await expect(prodList.status === 200 && prodList.data.result.length === 1, 'member lists products');

  // ---------- 3. Subscription (auto-approve) ----------
  await section('Subscription (auto-approve)');
  const zeroAmt = await api('POST', `/api/saccos/${orgId}/investments/apply`, m1.data.token, { productId, amount: 0 });
  await expect(zeroAmt.status === 400 && zeroAmt.data.code === 'SACCOS_INV_AMOUNT', 'zero amount -> SACCOS_INV_AMOUNT');

  const belowMin = await api('POST', `/api/saccos/${orgId}/investments/apply`, m1.data.token, { productId, amount: 1000 });
  await expect(belowMin.status === 400 && belowMin.data.code === 'SACCOS_INV_BELOW_MIN', 'below min -> SACCOS_INV_BELOW_MIN');

  const aboveMax = await api('POST', `/api/saccos/${orgId}/investments/apply`, m1.data.token, { productId, amount: 600000 });
  await expect(aboveMax.status === 400 && aboveMax.data.code === 'SACCOS_INV_ABOVE_MAX', 'above max -> SACCOS_INV_ABOVE_MAX');

  const poorApply = await api('POST', `/api/saccos/${orgId}/investments/apply`, m1.data.token, { productId, amount: 100000 });
  await expect(poorApply.status === 400, 'unfunded subscription rejected (insufficient)', JSON.stringify({ code: poorApply.data.code, status: poorApply.status }));

  await fundWallet(m1.data.user.id, 500000);
  const apply = await api('POST', `/api/saccos/${orgId}/investments/apply`, m1.data.token, { productId, amount: 100000 });
  await expect(apply.status === 201 && String(apply.data.result.reference_id).startsWith('INV-') && apply.data.result.status === 'ACTIVE'
    && apply.data.result.expected_interest === 10000,
    'member subscribes 100000 -> INV-* ACTIVE, expected interest 10000', JSON.stringify(apply.data.result));
  const inv1Id = apply.data.result.id;

  const beforeWallet = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.data.user.id]);
  await expect(Number(beforeWallet.rows[0].wallet_balance) === 400000, 'wallet debited 100000 -> 400000');

  const mine = await api('GET', `/api/saccos/${orgId}/investments/mine`, m1.data.token);
  await expect(mine.status === 200 && mine.data.result.length === 1 && mine.data.result[0].status === 'ACTIVE', 'mine lists 1 ACTIVE');

  const matEarly = await api('POST', `/api/saccos/${orgId}/investments/${inv1Id}/redeem`, m1.data.token);
  await expect(matEarly.status === 400 && matEarly.data.code === 'SACCOS_INV_NOT_MATURED', 'redeem before maturity -> SACCOS_INV_NOT_MATURED');

  // ---------- 4. Redemption ----------
  await section('Redemption');
  await pool.query(`UPDATE saccos_investments SET maturity_date = CURRENT_DATE - 1 WHERE id = $1`, [inv1Id]);
  const redeem = await api('POST', `/api/saccos/${orgId}/investments/${inv1Id}/redeem`, m1.data.token);
  await expect(redeem.status === 200 && redeem.data.result.status === 'CLOSED' && redeem.data.result.principal === 100000
    && redeem.data.result.interest === 10000 && redeem.data.result.total === 110000 && String(redeem.data.result.reference).startsWith('RED-'),
    'redeem matured -> CLOSED, total 110000 (principal + flat interest)');

  const afterWallet = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.data.user.id]);
  await expect(Number(afterWallet.rows[0].wallet_balance) === 510000, 'wallet credited 110000 -> 510000');

  const redeemAgain = await api('POST', `/api/saccos/${orgId}/investments/${inv1Id}/redeem`, m1.data.token);
  await expect(redeemAgain.status === 400 && redeemAgain.data.code === 'SACCOS_INV_STATE', 'redeem CLOSED -> SACCOS_INV_STATE');

  await fundWallet(m2.data.user.id, 300000);
  const inv2 = (await api('POST', `/api/saccos/${orgId}/investments/apply`, m2.data.token, { productId, amount: 20000 })).data.result;
  const notYours = await api('POST', `/api/saccos/${orgId}/investments/${inv2.id}/redeem`, m1.data.token);
  await expect(notYours.status === 403 && notYours.data.code === 'SACCOS_RBAC', 'member cannot redeem another member investment -> 403');

  // ---------- 5. Trial balance integration ----------
  await section('Ledger integration');
  const trial = (await api('GET', `/api/saccos/${orgId}/accounting/trial-balance`, m1.data.token)).data.result;
  const liability = trial.balances.find((b) => b.account_code === `SACCOS${orgId}_INVESTMENTS_LIABILITY`);
  const interestExp = trial.balances.find((b) => b.account_code === `SACCOS${orgId}_INVESTMENT_INTEREST_EXPENSE`);
  await expect(liability && liability.balance === 20000 && interestExp && interestExp.balance === 10000,
    'entity ledger: INVESTMENTS_LIABILITY 20000, INTEREST_EXPENSE 10000 (wallet legs cross to platform CUSTOMER_WALLET)', JSON.stringify({ l: liability && liability.balance, i: interestExp && interestExp.balance }));

  const fromTxn = await pool.query(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE type = 'SACCOS_INVESTMENT_SUBSCRIPTION' AND meta->>'saccosId' = $1`,
    [String(orgId)]
  );
  await expect(fromTxn.rows[0].n >= 2, 'SACCOS_INVESTMENT_SUBSCRIPTION transactions recorded');

  // ---------- 6. Approval-gated org ----------
  await section('Approval-gated org (autoApprove=false)');
  const o2 = await register(phone(7004), 'Uwekezaji Pili');
  const o2Tok = o2.data.token;
  const s2 = await api('POST', '/api/v1/saccos', o2Tok, {
    name: 'Uwekezaji Makini ' + suffix,
    config: { investments: { autoApprove: false, minAmount: 1000, defaultAnnualRatePercent: 20, defaultTermMonths: 6 } },
  });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);
  const fReg = await addMember(o2Tok, s2Id, 7005, 'F Mwekezaji');
  await fundWallet(fReg.data.user.id, 200000);

  const p2 = (await api('POST', `/api/saccos/${s2Id}/investments/products`, o2Tok, { name: 'Mfuko Maalum' })).data.result;
  const pendApply = await api('POST', `/api/saccos/${s2Id}/investments/apply`, fReg.data.token, { productId: p2.id, amount: 50000 });
  await expect(pendApply.status === 201 && pendApply.data.result.status === 'PENDING', 'apply (autoApprove=false) -> PENDING');
  const pendingInv = pendApply.data.result.id;

  const memberApprove = await api('POST', `/api/saccos/${s2Id}/investments/${pendingInv}/approve`, fReg.data.token);
  await expect(memberApprove.status === 403 && memberApprove.data.code === 'SACCOS_RBAC', 'member cannot approve -> 403');

  const p3 = (await api('POST', `/api/saccos/${s2Id}/investments/apply`, fReg.data.token, { productId: p2.id, amount: 5000 })).data.result;
  const reject = await api('POST', `/api/saccos/${s2Id}/investments/${p3.id}/reject`, o2Tok);
  await expect(reject.status === 200 && reject.data.result.status === 'REJECTED', 'owner rejects PENDING -> REJECTED (no funds moved)');

  const approve = await api('POST', `/api/saccos/${s2Id}/investments/${pendingInv}/approve`, o2Tok);
  await expect(approve.status === 200 && approve.data.result.status === 'ACTIVE', 'owner approves PENDING -> ACTIVE + funds debited');

  const fWallet = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [fReg.data.user.id]);
  await expect(Number(fWallet.rows[0].wallet_balance) === 150000, 'approved subscription debits 50000');

  // ---------- 7. Isolation + oversight ----------
  await section('Isolation + oversight');
  const crossMine = await api('GET', `/api/saccos/${s2Id}/investments/mine`, m1.data.token);
  await expect(crossMine.status === 404, 'S1 member cannot read S2 investments -> 404');

  const adminTok = await makeAdmin(await register(phone(7006), 'Ododo Mwekezaji'));
  const s1Sum = await api('GET', `/api/saccos/${orgId}/investments/summary`, adminTok);
  const s2Sum = await api('GET', `/api/saccos/${s2Id}/investments/summary`, adminTok);
  await expect(adminTok && s1Sum.status === 200 && s1Sum.data.result.active === 1 && s1Sum.data.result.closed === 1 && s1Sum.data.result.products === 1,
    'platform ADMIN reads S1 investment summary');
  await expect(s2Sum.data.result.active === 1 && s2Sum.data.result.pending === 0 && s2Sum.data.result.closed === 0 && s2Sum.data.result.products === 1,
    'platform ADMIN reads S2 investment summary');

  const ownerSum = (await api('GET', `/api/saccos/${orgId}/investments/summary`, ownerTok)).data.result;
  await expect(ownerSum.invested === 20000 && ownerSum.active === 1 && ownerSum.closed === 1, 'owner summary totals');

  const ownerS2 = await api('GET', `/api/saccos/${s2Id}/investments/summary`, ownerTok);
  await expect(ownerS2.status === 404, 'S1 owner cannot read S2 summary -> 404');

  const audit = await pool.query(`SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'SACCOS_INV%'`);
  await expect(audit.rows.length >= 4, 'audit trail has investment actions');

  console.log(`\nSACCOS INVESTMENTS: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });