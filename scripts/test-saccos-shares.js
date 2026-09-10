/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - SHARES
 * Increment 2 regression: share subscription ledgered on the
 * shared double-entry core (DR CUSTOMER_WALLET / CR
 * SACCOS<id>_SHARES_CAPITAL EQUITY account per entity),
 * config-driven shareStructure {shareValue,minShares,maxShares,
 * autoApprove}, PENDING/APPROVED/REJECTED purchase lifecycle with
 * refund reversal on reject (fresh reference), holdings motion
 * (base-cost average), summary, and cross-entity isolation.
 * Covers /api/saccos/:id/shares/* when SACCOS_ENABLED=true. Suite 46.
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
async function makeAdmin(reg, depth = 0) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (depth < 1) {
    const backup = await register('255689' + nowSuffix(), 'Shares Admin Backup');
    return makeAdmin(backup, depth + 1);
  }
  return null;
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
async function wallet(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (102_saccos_shares)');
  const purCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_share_purchases'`);
  const purOk = ['saccos_id', 'member_id', 'reference_id', 'shares', 'share_price', 'total_amount', 'status', 'requires_approval']
    .every((c) => purCols.rows.some((r) => r.column_name === c));
  await expect(purOk, 'saccos_share_purchases lifecycle columns present');

  const holdCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_share_holdings'`);
  const holdOk = ['saccos_id', 'member_id', 'share_count', 'total_value', 'avg_price']
    .every((c) => holdCols.rows.some((r) => r.column_name === c));
  await expect(holdOk, 'saccos_share_holdings columns present');

  // ---------- 2. Org + membership setup ----------
  await section('Setup: org (auto-approve) + member');
  const ownerReg = await register(phone(2001), 'Shares Haya');
  const ownerTok = ownerReg.data.token;
  const orgName = 'Asasi Hisa ' + suffix;
  const create = await api('POST', '/api/v1/saccos', ownerTok, {
    name: orgName, legalEntity: 'Cooperative Society',
    config: { shareStructure: { shareValue: 5000, minShares: 1, maxShares: 1000, autoApprove: true } },
  });
  await expect(create.status === 201, 'owner creates SACCOS with shareStructure config');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  const invited = await register(phone(2002), 'B Benki');
  const invTok = invited.data.token;
  const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(2002) });
  await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, invTok);
  await fundWallet(invited.data.user.id, 1000000);

  // ---------- 3. Purchase (auto-approve) + canonical ledger ----------
  await section('Share purchase (auto-approve) + canonical ledger');
  const before = await wallet(invited.data.user.id);
  const purchase = await api('POST', `/api/saccos/${orgId}/shares/purchase`, invTok, { shares: 10 });
  await expect(purchase.status === 201 && purchase.data.success && purchase.data.result.status === 'APPROVED'
    && String(purchase.data.result.reference_id).startsWith('SCS-'),
    'member purchases 10 shares -> SCS-* APPROVED', `${purchase.status}/${purchase.data.code || ''}`);
  const ref = purchase.data.result.reference_id;
  await expect(purchase.data.result.shares === 10 && Number(purchase.data.result.share_price) === 5000 && Number(purchase.data.result.total_amount) === 50000,
    'purchase math 10 x 5000 = 50000', JSON.stringify(purchase.data.result).slice(0, 120));

  const afterBuy = await wallet(invited.data.user.id);
  await expect(before - afterBuy === 50000, 'wallet debited 50000', `before=${before} after=${afterBuy}`);

  const journal = await pool.query(
    `SELECT j.direction, j.amount, l.account_code
     FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE j.reference_id = $1 ORDER BY j.direction`,
    [ref]);
  const drCust = journal.rows.find((r) => r.direction === 'DR' && r.account_code === 'CUSTOMER_WALLET');
  const crEquity = journal.rows.find((r) => r.direction === 'CR' && r.account_code === `SACCOS${orgId}_SHARES_CAPITAL`);
  await expect(drCust && crEquity && Number(drCust.amount) === 50000 && Number(crEquity.amount) === 50000,
    'balanced journal DR CUSTOMER_WALLET / CR SACCOS<id>_SHARES_CAPITAL (50k)',
    JSON.stringify(journal.rows.map((r) => `${r.account_code}:${r.direction}:${r.amount}`)));

  const txns = await pool.query(`SELECT type, wallet_amount, status FROM transactions WHERE reference_id = $1`, [ref]);
  await expect(txns.rows.length === 1 && txns.rows[0].type === 'SACCOS_SHARE_PURCHASE'
    && txns.rows[0].status === 'SUCCESS' && Number(txns.rows[0].wallet_amount) === 50000,
    'transactions row SACCOS_SHARE_PURCHASE/SUCCESS/50k');

  const ops = await pool.query(`SELECT operation_type FROM financial_operations WHERE reference_id = $1`, [ref]);
  await expect(ops.rows.length === 1 && ops.rows[0].operation_type === 'DEBIT', 'financial_operations claim row (DEBIT)');

  const mine = await api('GET', `/api/saccos/${orgId}/shares/mine`, invTok);
  await expect(mine.status === 200 && mine.data.result.holdings.share_count === 10 && Number(mine.data.result.holdings.total_value) === 50000,
    'my holdings 10 shares / 50000 total', JSON.stringify(mine.data.result.holdings));

  const purchases = await api('GET', `/api/saccos/${orgId}/shares/purchases`, ownerTok);
  await expect(purchases.status === 200 && purchases.data.result.length === 1 && purchases.data.result[0].full_name === 'B Benki'
    && purchases.data.result[0].status === 'APPROVED', 'owner sees purchase list with identity');

  const summary = await api('GET', `/api/saccos/${orgId}/shares/summary`, ownerTok);
  await expect(summary.status === 200 && summary.data.result.total_shares === 10 && Number(summary.data.result.total_value) === 50000
    && summary.data.result.holders === 1, 'summary total_shares 10 / value 50000 / holders 1');

  // ---------- 4. Guards ----------
  await section('Purchase guards');
  const badZero = await api('POST', `/api/saccos/${orgId}/shares/purchase`, invTok, { shares: 0 });
  await expect(badZero.status === 400 && badZero.data.code === 'SACCOS_SHARES_INVALID', 'shares 0 -> SACCOS_SHARES_INVALID');
  const badNeg = await api('POST', `/api/saccos/${orgId}/shares/purchase`, invTok, { shares: -5 });
  await expect(badNeg.status === 400 && badNeg.data.code === 'SACCOS_SHARES_INVALID', 'shares -5 -> SACCOS_SHARES_INVALID');

  const overMax = await api('POST', `/api/saccos/${orgId}/shares/purchase`, invTok, { shares: 1001 });
  await expect(overMax.status === 400 && overMax.data.code === 'SACCOS_SHARES_ABOVE_MAX', 'shares 1001 (>max 1000) -> SACCOS_SHARES_ABOVE_MAX');

  const poorReg = await register(phone(2003), 'C Mwenyewe');
  const poorTok = poorReg.data.token;
  const poorInv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(2003) });
  await api('POST', `/api/saccos/${orgId}/members/${poorInv.data.result.id}/accept`, poorTok);
  await fundWallet(poorReg.data.user.id, 5000);
  const poorBuy = await api('POST', `/api/saccos/${orgId}/shares/purchase`, poorTok, { shares: 2 });
  await expect(poorBuy.status === 400, 'insufficient funds (10k needed, 5k held) -> 400', `${poorBuy.status}`);
  await expect(await wallet(poorReg.data.user.id) === 5000, 'insufficient-fail leaves balance unchanged');

  const outsider = await register(phone(2004), 'X Mgeni');
  const outsiderTok = outsider.data.token;
  const outsiderBuy = await api('POST', `/api/saccos/${orgId}/shares/purchase`, outsiderTok, { shares: 1 });
  await expect(outsiderBuy.status === 404 && outsiderBuy.data.code === 'SACCOS_NOT_FOUND', 'non-member purchase -> 404 (isolation)');
  const outsiderMine = await api('GET', `/api/saccos/${orgId}/shares/mine`, outsiderTok);
  await expect(outsiderMine.status === 404, 'non-member shares/mine -> 404');

  const memberList = await api('GET', `/api/saccos/${orgId}/shares/purchases`, invTok);
  await expect(memberList.status === 403 && memberList.data.code === 'SACCOS_RBAC', 'plain MEMBER cannot list purchases -> 403');
  const memberApprove = await api('POST', `/api/saccos/${orgId}/shares/purchases/${purchase.data.result.id}/approve`, invTok);
  await expect(memberApprove.status === 403 && memberApprove.data.code === 'SACCOS_RBAC', 'plain MEMBER cannot approve -> 403');

  // ---------- 5. Approval-gated org + reject refund ----------
  await section('Approval-gated org + reject refund');
  const s2Owner = await register(phone(2005), 'S2 Mwenyekiti');
  const s2Tok = s2Owner.data.token;
  const s2 = await api('POST', '/api/v1/saccos', s2Tok, {
    name: 'Idhibiti Hisa ' + suffix,
    config: { shareStructure: { shareValue: 2000, minShares: 1, maxShares: 500, autoApprove: false } },
  });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, s2Tok);

  const fReg = await register(phone(2006), 'F Mwajiriwa');
  const fTok = fReg.data.token;
  const fInv = await api('POST', `/api/saccos/${s2Id}/members`, s2Tok, { phoneNumber: phone(2006) });
  await api('POST', `/api/saccos/${s2Id}/members/${fInv.data.result.id}/accept`, fTok);
  await fundWallet(fReg.data.user.id, 100000);

  const p1 = await api('POST', `/api/saccos/${s2Id}/shares/purchase`, fTok, { shares: 3 });
  await expect(p1.status === 201 && p1.data.result.status === 'PENDING' && p1.data.result.requires_approval === true,
    'approval-gated purchase -> PENDING (requires_approval=true)', `${p1.status}`);
  const fMine = await api('GET', `/api/saccos/${s2Id}/shares/mine`, fTok);
  await expect(fMine.status === 200 && fMine.data.result.holdings.share_count === 0, 'pending NOT yet in holdings');

  const p2 = await api('POST', `/api/saccos/${s2Id}/shares/purchase`, fTok, { shares: 1 });
  await expect(p2.status === 201 && p2.data.result.status === 'PENDING', 'second purchase -> PENDING');

  const fBalBeforeDecision = await wallet(fReg.data.user.id);
  const approve = await api('POST', `/api/saccos/${s2Id}/shares/purchases/${p1.data.result.id}/approve`, s2Tok);
  await expect(approve.status === 200 && approve.data.result.status === 'APPROVED', 'OWNER approves PENDING purchase');

  const fMineAfter = await api('GET', `/api/saccos/${s2Id}/shares/mine`, fTok);
  await expect(fMineAfter.data.result.holdings.share_count === 3 && Number(fMineAfter.data.result.holdings.total_value) === 6000,
    'approved 3 shares enter holdings (6000)');

  const dupApprove = await api('POST', `/api/saccos/${s2Id}/shares/purchases/${p1.data.result.id}/approve`, s2Tok);
  await expect(dupApprove.status === 400 && dupApprove.data.code === 'SACCOS_SHARE_DECIDED', 're-approve -> SACCOS_SHARE_DECIDED');

  const reject = await api('POST', `/api/saccos/${s2Id}/shares/purchases/${p2.data.result.id}/reject`, s2Tok);
  await expect(reject.status === 200 && reject.data.result.status === 'REJECTED', 'OWNER rejects PENDING purchase');
  const fBalAfterRefund = await wallet(fReg.data.user.id);
  await expect(fBalAfterRefund - fBalBeforeDecision === 2000, 'rejected purchase refunded to wallet (+2000)', `d=${fBalAfterRefund - fBalBeforeDecision}`);

  const revTx = await pool.query(`SELECT status, reversed_at, reversed_ref FROM transactions WHERE reference_id = $1`, [p2.data.result.reference_id]);
  await expect(revTx.rows.length === 1 && revTx.rows[0].status === 'SUCCESS' && revTx.rows[0].reversed_at !== null
    && revTx.rows[0].reversed_ref === p2.data.result.reference_id + '-R',
    'rejected purchase txn marked reversed (SUCCESS + reversed_at/reversed_ref)');

  const revJournal = await pool.query(
    `SELECT j.direction, j.amount, l.account_code FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE j.reference_id = $1`, [p2.data.result.reference_id + '-R']);
  const revDr = revJournal.rows.find((r) => r.direction === 'DR' && r.account_code === `SACCOS${s2Id}_SHARES_CAPITAL`);
  const revCr = revJournal.rows.find((r) => r.direction === 'CR' && r.account_code === 'CUSTOMER_WALLET');
  await expect(revDr && revCr && Number(revDr.amount) === 2000 && Number(revCr.amount) === 2000,
    'refund reversal journal DR equity / CR wallet (2k, fresh ref)');

  const dupReject = await api('POST', `/api/saccos/${s2Id}/shares/purchases/${p2.data.result.id}/reject`, s2Tok);
  await expect(dupReject.status === 400 && dupReject.data.code === 'SACCOS_SHARE_DECIDED', 're-reject -> SACCOS_SHARE_DECIDED');

  const s2Summary = await api('GET', `/api/saccos/${s2Id}/shares/summary`, s2Tok);
  await expect(s2Summary.data.result.total_shares === 3 && Number(s2Summary.data.result.total_value) === 6000
    && s2Summary.data.result.holders === 1, 'summary excludes rejected (3 shares / 6000 / 1 holder)');

  // ---------- 6. Cross-entity isolation ----------
  await section('Cross-entity isolation');
  const s1SeesS2 = await api('GET', `/api/saccos/${s2Id}/shares/purchases`, ownerTok);
  await expect(s1SeesS2.status === 404, 'S1 owner cannot read S2 purchases -> 404');
  const s1Summary2 = await api('GET', `/api/saccos/${s2Id}/shares/summary`, ownerTok);
  await expect(s1Summary2.status === 404, 'S1 owner cannot read S2 summary -> 404');

  const codes = await pool.query(`SELECT account_code FROM ledger_accounts WHERE account_code IN ($1, $2)`, [`SACCOS${orgId}_SHARES_CAPITAL`, `SACCOS${s2Id}_SHARES_CAPITAL`]);
  await expect(codes.rows.length === 2, 'per-entity EQUITY accounts distinct', JSON.stringify(codes.rows));

  // ---------- 7. Platform ADMIN oversight + audit ----------
  await section('Oversight + audit');
  const adminTok = await makeAdmin(await register(phone(2007), 'O Oversight'));
  const adminView = await api('GET', `/api/saccos/${s2Id}/shares/purchases`, adminTok);
  await expect(adminTok && adminView.status === 200 && adminView.data.result.length === 2, 'platform ADMIN can cross-read purchases');

  const audit = await pool.query(`SELECT action FROM audit_logs WHERE action IN ('SACCOS_SHARE_PURCHASE','SACCOS_SHARE_APPROVED','SACCOS_SHARE_REJECTED') LIMIT 3`);
  await expect(audit.rows.length >= 1, 'audit trail has share actions');

  console.log(`\nSACCOS SHARES: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });