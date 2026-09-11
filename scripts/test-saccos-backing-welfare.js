/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - SAVINGS-BACKED
 * LOAN LIMITS + MEMBER WELFARE/SOCIAL FUND (increment 16, suite 60)
 *
 * migration 116 adds a collateral snapshot to loan applications
 * and a pooled welfare kitty (`SACCOS<id>_WELFARE_FUND`):
 *
 * LENDING BACKING: when `lending.savingsBackingEnabled` is on,
 * backing_balance = member savings account balance + share holding
 * book value, backing_limit = balance x `savingsBackingMultiple`.
 * apply() rejects requested_amount > limit (SACCOS_LOAN_BACKING_
 * INSUFFICIENT) and snapshots the values; approve() re-checks the
 * LIVE backing so savings withdrawn after applying voids approval,
 * and refreshes the snapshot on approval.
 *
 * WELFARE: a scheme (OWNER/BOARD) sets a contribution and fixed
 * payout; joining contributes once per scheme (UNIQUE, WLC-*)
 * DR CUSTOMER_WALLET / CR WELFARE_FUND. Claims (SUBMITTED ->
 * APPROVED/REJECTED -> PAID, WLF-*) are paid DR fund / CR
 * CUSTOMER_WALLET with a fund-balance pre-check; fund_balance =
 * SUM(CR - DR) and can never go negative.
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
async function walletOf(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}
async function savingsBalance(saccosId, memberId) {
  const r = await pool.query('SELECT balance FROM saccos_savings_accounts WHERE saccos_id = $1 AND member_id = $2', [saccosId, memberId]);
  return r.rows.length ? Number(r.rows[0].balance) : 0;
}
async function fundBalance(orgId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE -amount END), 0)::numeric AS b
     FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id WHERE la.account_code = $1`,
    [`SACCOS${orgId}_WELFARE_FUND`]
  );
  return Number(r.rows[0].b);
}

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (116_saccos_backing_welfare)');
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name IN ('saccos_welfare_schemes', 'saccos_welfare_contributions', 'saccos_welfare_claims')`
  );
  await expect(new Set(tables.rows.map((r) => r.table_name)).size === 3, '3 welfare tables exist');
  const uq = await pool.query(
    `SELECT contype FROM pg_constraint WHERE conname = 'saccos_welfare_contributions_scheme_id_member_id_key'`
  );
  await expect(uq.rows.length === 1, 'contributions UNIQUE(scheme_id, member_id) exists');
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_loan_applications'
       AND column_name IN ('backing_enabled', 'backing_multiple', 'backing_balance', 'backing_limit')`
  );
  await expect(cols.rows.length === 4, 'loan applications carry 4 backing columns');

  // ---------- 2. Setup ----------
  await section('Setup: SACCOS + members');
  const ownerReg = await register(phone(8801), 'Ustawi Mwenyekiti');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Ustawi Dhamana ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);
  async function member(pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    const mid = inv.data.result.id;
    await api('POST', `/api/saccos/${orgId}/members/${mid}/accept`, reg.data.token);
    return { tok: reg.data.token, userId: reg.data.user.id, memberId: mid };
  }
  const m1 = await member(8802, 'Dhamana 1');
  const m2 = await member(8803, 'Dhamana 2');
  const m3 = await member(8804, 'Dhamana 3');
  await fundWallet(m1.userId, 500000);
  await fundWallet(m2.userId, 500000);
  await fundWallet(m3.userId, 10000);

  // ---------- 3. Backing OFF by default ----------
  await section('Lending backing: off by default, then gated on');
  const d1 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m1.tok, { amount: 50000 });
  await expect(d1.data.success === true, 'm1 deposits 50000');
  const noBack = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 60000, termMonths: 6, purpose: 'Usafirishaji' });
  await expect(noBack.status === 201 && noBack.data.success === true, 'apply passes with backing off (default)', JSON.stringify(noBack.data));
  const noBackRow = await pool.query(`SELECT backing_enabled FROM saccos_loan_applications WHERE id = $1`, [noBack.data.result.id]);
  await expect(noBackRow.rows[0].backing_enabled === false, 'snapshot backing_enabled = false when off');

  await pool.query(
    `UPDATE saccos SET config = COALESCE(config, '{}') || '{"lending":{"savingsBackingEnabled":true,"savingsBackingMultiple":3}}'::jsonb WHERE id = $1`,
    [orgId]
  );
  const bk = await api('GET', `/api/saccos/${orgId}/loans/backing`, m1.tok);
  await expect(bk.status === 200 && bk.data.result.enabled === true && bk.data.result.multiple === 3
    && bk.data.result.savings_balance === 50000 && bk.data.result.share_value === 0
    && bk.data.result.backing_balance === 50000 && bk.data.result.backing_limit === 150000,
    'm1 backing: 50000 savings -> limit 150000 (x3)', JSON.stringify(bk.data.result));

  const over = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 200000, termMonths: 6 });
  await expect(over.status === 400 && over.data.code === 'SACCOS_LOAN_BACKING_INSUFFICIENT', 'apply 200000 > 150000 -> 400 BACKING_INSUFFICIENT');

  const keep = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 100000, termMonths: 6, purpose: 'Mashine' });
  await expect(keep.status === 201 && keep.data.result.status === 'PENDING', 'apply 100000 within backing -> 201 PENDING', JSON.stringify(keep.data));
  const snap = await pool.query(
    `SELECT backing_enabled, backing_multiple, backing_balance, backing_limit FROM saccos_loan_applications WHERE id = $1`,
    [keep.data.result.id]
  );
  await expect(snap.rows[0].backing_enabled === true && Number(snap.rows[0].backing_multiple) === 3
    && Number(snap.rows[0].backing_balance) === 50000 && Number(snap.rows[0].backing_limit) === 150000,
    'snapshot stored: enabled, x3, 50000, 150000', JSON.stringify(snap.rows[0]));

  // ---------- 4. Live re-check defeats approval ----------
  await section('Approve re-checks LIVE backing');
  const wd = await api('POST', `/api/saccos/${orgId}/savings/withdraw`, m1.tok, { amount: 40000 });
  await expect(wd.data.success === true && wd.data.result.status === 'APPROVED' && wd.data.result.newBalance === 10000,
    'm1 withdraws 40000 (savings 10000)', JSON.stringify(wd.data));
  const deny = await api('POST', `/api/saccos/${orgId}/loans/applications/${keep.data.result.id}/approve`, ownerTok);
  await expect(deny.status === 400 && deny.data.code === 'SACCOS_LOAN_BACKING_INSUFFICIENT', 'approve after withdrawal -> 400 BACKING_INSUFFICIENT');
  const still = await pool.query(`SELECT status FROM saccos_loan_applications WHERE id = $1`, [keep.data.result.id]);
  await expect(still.rows[0].status === 'PENDING', 'application stays PENDING after voided approval');

  const red = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m1.tok, { amount: 40000 });
  await expect(red.data.success === true, 'm1 re-deposits 40000 (savings 50000)');
  const appr = await api('POST', `/api/saccos/${orgId}/loans/applications/${keep.data.result.id}/approve`, ownerTok);
  await expect(appr.status === 200 && appr.data.success === true, 'approve succeeds once backing restored', JSON.stringify(appr.data));
  const approved = await pool.query(
    `SELECT a.status, a.backing_limit, l.status AS loan_status FROM saccos_loan_applications a
     JOIN saccos_loans l ON l.application_id = a.id WHERE a.id = $1`,
    [keep.data.result.id]
  );
  await expect(approved.rows[0].status === 'DISBURSED' && approved.rows[0].loan_status === 'ACTIVE'
    && Number(approved.rows[0].backing_limit) === 150000, 'application DISBURSED + loan ACTIVE + snapshot refreshed to 150000');

  // ---------- 5. Savings + shares backing ----------
  await section('Backing = savings + shares (m2)');
  const d2 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m2.tok, { amount: 10000 });
  await expect(d2.data.success === true, 'm2 deposits 10000 savings');
  const sh = await api('POST', `/api/saccos/${orgId}/shares/purchase`, m2.tok, { shares: 2 });
  await expect(sh.status === 201 && sh.data.success === true, 'm2 buys 2 shares (20000)');
  const held = await api('GET', `/api/saccos/${orgId}/shares/mine`, m2.tok);
  await expect(Number(held.data.result.holdings.total_value) === 20000, 'm2 share holdings total_value 20000', JSON.stringify(held.data.result.holdings));
  const b2 = await api('GET', `/api/saccos/${orgId}/loans/backing`, m2.tok);
  await expect(b2.data.result.savings_balance === 10000 && b2.data.result.share_value === 20000
    && b2.data.result.backing_balance === 30000 && b2.data.result.backing_limit === 90000,
    'm2 backing: 10000 + 20000 shares -> limit 90000', JSON.stringify(b2.data.result));
  const over2 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m2.tok, { amount: 95000, termMonths: 6 });
  await expect(over2.status === 400 && over2.data.code === 'SACCOS_LOAN_BACKING_INSUFFICIENT', 'm2 apply 95000 > 90000 -> 400');
  const keep2 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m2.tok, { amount: 60000, termMonths: 6 });
  await expect(keep2.status === 201, 'm2 apply 60000 within 90000 backing -> 201');
  const snap2 = await pool.query(`SELECT backing_balance, backing_limit FROM saccos_loan_applications WHERE id = $1`, [keep2.data.result.id]);
  await expect(Number(snap2.rows[0].backing_balance) === 30000 && Number(snap2.rows[0].backing_limit) === 90000,
    'm2 snapshot: 30000 / 90000', JSON.stringify(snap2.rows[0]));

  // ---------- 6. Welfare scheme governance ----------
  await section('Welfare: schemes + RBAC');
  const sch = await api('POST', `/api/saccos/${orgId}/welfare/schemes`, ownerTok, { name: 'Utunzaji', contribution: 20000, payout: 50000 });
  await expect(sch.status === 201 && sch.data.result.name === 'Utunzaji' && Number(sch.data.result.contribution) === 20000
    && Number(sch.data.result.payout) === 50000, 'owner creates scheme (contribution 20000, payout 50000)', JSON.stringify(sch.data));
  const schemeId = sch.data.result.id;
  const dupSch = await api('POST', `/api/saccos/${orgId}/welfare/schemes`, ownerTok, { name: 'Utunzaji', contribution: 20000, payout: 50000 });
  await expect(dupSch.status === 400 && dupSch.data.code === 'SACCOS_WELFARE_SCHEME_EXISTS', 'duplicate scheme name -> 400 EXISTS');
  const membSch = await api('POST', `/api/saccos/${orgId}/welfare/schemes`, m1.tok, { name: 'x', contribution: 100, payout: 100 });
  await expect(membSch.status === 403 && membSch.data.code === 'SACCOS_RBAC', 'member creates scheme -> 403 RBAC');
  const visitorSch = await api('GET', `/api/saccos/${orgId}/welfare/schemes`, await (async () => (await register(phone(8810), 'Mgeni')).data.token)());
  await expect(visitorSch.status === 404 && visitorSch.data.code === 'SACCOS_NOT_FOUND', 'non-member scheme list -> 404 NOT_FOUND');

  // ---------- 7. Contributions fund the kitty ----------
  await section('Welfare: contributions ledger DR wallet / CR fund');
  const before = await walletOf(m1.userId);
  const c1 = await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m1.tok, { schemeId, amount: 20000 });
  const after = await walletOf(m1.userId);
  await expect(c1.status === 201 && c1.data.result.contributed === true
    && c1.data.result.reference.startsWith('WLC-'), 'm1 contributes 20000 -> 201 WLC-*', JSON.stringify(c1.data));
  await expect(before - after === 20000, 'm1 wallet debited exactly 20000', `before=${before} after=${after}`);
  await expect(await fundBalance(orgId) === 20000, 'welfare fund balance = 20000');
  const jr = await pool.query(
    `SELECT la.account_code, j.direction, j.amount FROM journal_entries j
     JOIN ledger_accounts la ON la.id = j.account_id WHERE j.reference_id = $1 ORDER BY la.account_code`,
    [c1.data.result.reference]
  );
  await expect(jr.rows.length === 2 && jr.rows.some((r) => r.direction === 'DR' && r.account_code === 'CUSTOMER_WALLET' && Number(r.amount) === 20000)
    && jr.rows.some((r) => r.direction === 'CR' && r.account_code === `SACCOS${orgId}_WELFARE_FUND` && Number(r.amount) === 20000),
    'journal: DR CUSTOMER_WALLET / CR WELFARE_FUND 20000', JSON.stringify(jr.rows));
  const dupC = await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m1.tok, { schemeId, amount: 20000 });
  await expect(dupC.status === 400 && dupC.data.code === 'SACCOS_WELFARE_ALREADY_JOINED', 'm1 joins again -> 400 ALREADY_JOINED');
  const schemes = await api('GET', `/api/saccos/${orgId}/welfare/schemes`, m1.tok);
  await expect(schemes.data.result[0].joined === true && schemes.data.result[0].members_joined === 1, 'm1 sees scheme as joined');

  const low1 = await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m3.tok, { schemeId, amount: 5000 });
  await expect(low1.status === 400 && low1.data.code === 'SACCOS_WELFARE_CONTRIBUTION_LOW', 'm3 5000 < contributor min -> 400 LOW');
  const low2 = await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m3.tok, { schemeId, amount: 15000 });
  await expect(low2.status === 400 && low2.data.code === 'SACCOS_WELFARE_CONTRIBUTION_LOW', 'm3 15000 < 20000 contributor min -> 400 LOW');
  const broke = await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m3.tok, { schemeId, amount: 20000 });
  await expect(broke.status === 400 && broke.data.code === 'WALLET_INSUFFICIENT_FUNDS', 'm3 20000 with 10000 wallet -> 400 INSUFFICIENT_FUNDS');
  await fundWallet(m3.userId, 200000);
  const c2 = await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m3.tok, { schemeId, amount: 20000 });
  await expect(c2.status === 201, 'm3 contributes once funded -> 201');

  // ---------- 8. Claims lifecycle ----------
  await section('Welfare: claims submit/review/pay');
  const overAmt = await api('POST', `/api/saccos/${orgId}/welfare/claims`, m1.tok, { schemeId, event: 'Mazishi', amount: 60000 });
  await expect(overAmt.status === 400 && overAmt.data.code === 'SACCOS_WELFARE_CLAIM_AMOUNT', 'claim 60000 > payout 50000 -> 400 CLAIM_AMOUNT');
  const cl = await api('POST', `/api/saccos/${orgId}/welfare/claims`, m1.tok, { schemeId, event: 'Mazishi', details: 'Matanga ya familia', amount: 50000 });
  await expect(cl.status === 201 && cl.data.result.status === 'SUBMITTED' && cl.data.result.reference_id.startsWith('WLF-'),
    'm1 claims 50000 -> 201 SUBMITTED WLF-*', JSON.stringify(cl.data));
  const claimId = cl.data.result.id;
  const dupA = await api('POST', `/api/saccos/${orgId}/welfare/claims`, m1.tok, { schemeId, event: 'Elimu', amount: 10000 });
  await expect(dupA.status === 400 && dupA.data.code === 'SACCOS_WELFARE_CLAIM_ACTIVE', 'second active claim -> 400 CLAIM_ACTIVE');
  const membPay = await api('POST', `/api/saccos/${orgId}/welfare/claims/${claimId}/pay`, m1.tok);
  await expect(membPay.status === 403 && membPay.data.code === 'SACCOS_RBAC', 'member pays claim -> 403 RBAC');
  const review = await api('POST', `/api/saccos/${orgId}/welfare/claims/${claimId}/review`, ownerTok, { decision: 'APPROVE' });
  await expect(review.status === 200 && review.data.result.status === 'APPROVED', 'owner approves claim');
  const review2 = await api('POST', `/api/saccos/${orgId}/welfare/claims/${claimId}/review`, ownerTok, { decision: 'APPROVE' });
  await expect(review2.status === 400 && review2.data.code === 'SACCOS_WELFARE_CLAIM_STATE', 're-approve -> 400 CLAIM_STATE');

  const short = await api('POST', `/api/saccos/${orgId}/welfare/claims/${claimId}/pay`, ownerTok);
  await expect(short.status === 400 && short.data.code === 'SACCOS_WELFARE_FUND_INSUFFICIENT', 'pay with fund 40000 < 50000 -> 400 FUND_INSUFFICIENT');
  const c3 = await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m2.tok, { schemeId, amount: 20000 });
  await expect(c3.status === 201, 'm2 contributes 20000 -> 201 (fund 60000)');
  await expect(await fundBalance(orgId) === 60000, 'fund now 60000 (3 x 20000)');

  const wBefore = await walletOf(m1.userId);
  const pay = await api('POST', `/api/saccos/${orgId}/welfare/claims/${claimId}/pay`, ownerTok);
  const wAfter = await walletOf(m1.userId);
  await expect(pay.status === 200 && pay.data.result.status === 'PAID' && pay.data.result.reference.startsWith('WLF-'),
    'pay claim -> PAID (WLF-* idempotent ref)', JSON.stringify(pay.data));
  await expect(wAfter - wBefore === 50000, 'beneficiary wallet credited 50000');
  await expect(await fundBalance(orgId) === 10000, 'fund balance 10000 (60000 - 50000)');
  const paidRow = await pool.query(
    `SELECT status, txn_reference, paid_at FROM saccos_welfare_claims WHERE id = $1`,
    [claimId]
  );
  await expect(paidRow.rows[0].status === 'PAID' && paidRow.rows[0].txn_reference === cl.data.result.reference_id
    && !!paidRow.rows[0].paid_at, 'claim row PAID with txn_reference + paid_at');
  const repay = await api('POST', `/api/saccos/${orgId}/welfare/claims/${claimId}/pay`, ownerTok);
  await expect(repay.status === 400 && repay.data.code === 'SACCOS_WELFARE_CLAIM_STATE', 'pay again -> 400 CLAIM_STATE');

  // ---------- 9. Summary + member views ----------
  await section('Welfare: summary + member claims');
  const summ = await api('GET', `/api/saccos/${orgId}/welfare/summary`, ownerTok);
  await expect(summ.status === 200 && summ.data.result.fund_balance === 10000
    && Number(summ.data.result.paid_amount) === 50000 && Number(summ.data.result.pending_amount) === 0
    && summ.data.result.paid_claims === 1 && summ.data.result.pending_claims === 0
    && Number(summ.data.result.total_contributions) === 60000 && summ.data.result.members_joined === 3
    && summ.data.result.schemes === 1, 'summary: fund 10000, paid 50000/1, contributed 60000/3', JSON.stringify(summ.data.result));
  const membSumm = await api('GET', `/api/saccos/${orgId}/welfare/summary`, m1.tok);
  await expect(membSumm.status === 403 && membSumm.data.code === 'SACCOS_RBAC', 'member summary -> 403 RBAC');
  const myClaims = await api('GET', `/api/saccos/${orgId}/welfare/claims`, m1.tok);
  await expect(myClaims.status === 200 && myClaims.data.result.length === 1 && myClaims.data.result[0].scheme_name === 'Utunzaji'
    && myClaims.data.result[0].status === 'PAID', 'm1 sees own claim (PAID, scheme name)');
  const allClaims = await api('GET', `/api/saccos/${orgId}/welfare/claims`, ownerTok);
  await expect(allClaims.status === 200 && allClaims.data.result.length === 1 && allClaims.data.result[0].full_name, 'owner sees all claims with names');

  // ---------- 10. Isolation + audit ----------
  await section('Isolation + platform visibility + audit');
  const s2Owner = await register(phone(8805), 'Shirika Pili');
  const s2Tok = s2Owner.data.token;
  const org2 = await api('POST', '/api/v1/saccos', s2Tok, { name: 'Shirika Pili ' + suffix });
  const s2Id = org2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, s2Tok);
  const crossSch = await api('POST', `/api/saccos/${orgId}/welfare/schemes`, s2Tok, { name: 'Ujinga', contribution: 100, payout: 100 });
  await expect(crossSch.status === 403 && crossSch.data.code === 'SACCOS_NOT_MEMBER', 'S2 owner creates scheme on S1 -> 403 NOT_MEMBER');
  const crossClaims = await api('GET', `/api/saccos/${orgId}/welfare/claims`, s2Tok);
  await expect(crossClaims.status === 404 && crossClaims.data.code === 'SACCOS_NOT_FOUND', 'S2 owner lists S1 claims -> 404 NOT_FOUND');
  const crossBacking = await api('GET', `/api/saccos/${orgId}/loans/backing`, s2Tok);
  await expect(crossBacking.status === 404 && crossBacking.data.code === 'SACCOS_NOT_FOUND', 'S2 owner reads S1 backing -> 404 NOT_FOUND');
  const audit = await pool.query(
    `SELECT DISTINCT action FROM audit_logs WHERE action IN ('SACCOS_WELFARE_CONTRIBUTION', 'SACCOS_WELFARE_CLAIM_PAID', 'SACCOS_WELFARE_SCHEME_CREATED')`
  );
  await expect(audit.rows.length === 3, 'scheme/contribution/paid audit actions recorded');

  console.log(`\nSACCOS BACKING + WELFARE: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });