/* ============================================================
 * AFRIKOBA GLOBAL - VIRTUAL CARDS REGRESSION
 * J1-J6 lifecycle: issue (PAN hashing / masking / Luhn / scheme
 * prefixes / default+custom limits), ownership-segregated list,
 * detail + statement (no PAN/CVV leak), limits update, freeze /
 * unfreeze / block state machine, authorization (AUTH_HOLD on
 * wallet via lockWallet with balanced CARD_HOLD journal, decline
 * reasons logged), merchant/amount/CVV/per-txn/daily/balance
 * guards, admin-only settlement (captureLock → MNO_CLEARING) and
 * refund (unlockWallet → wallet), idempotency on settled/refunded
 * auth, statement + summary. Covers /api/cards + /api/v1/cards.
 * Suite 44.
 * ============================================================ */
const BASE = process.env.CARDS_TEST_BASE || 'http://127.0.0.1:3000';
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
    const backup = await register(`255789${nowSuffix()}`, 'Card Admin Backup');
    return makeAdmin(backup, depth + 1);
  }
  return null;
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
async function balances(userId) {
  const r = await pool.query('SELECT wallet_balance, locked_balance FROM users WHERE id = $1', [userId]);
  return { wallet: Number(r.rows[0].wallet_balance), locked: Number(r.rows[0].locked_balance) };
}
function luhnOk(pan) {
  let sum = 0;
  let alt = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let d = Number(pan[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const holder = await register(`255780${suffix}`, 'Card Holder');
  const other = await register(`255781${suffix}`, 'Card Stranger');
  const broke = await register(`255782${suffix}`, 'Card Broke');
  const adm = await register(`255783${suffix}`, 'Card Admin');
  await expect(holder.data.token && other.data.token && broke.data.token && adm.data.token, 'Users registered');
  const holderTok = holder.data.token;
  const otherTok = other.data.token;
  const brokeTok = broke.data.token;
  const adminTok = await makeAdmin(adm);
  await expect(!!adminTok, 'Admin promoted (makeAdmin with refresh retry)');

  await section('Schema evidence + issuance');
  const vc = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'virtual_cards'`);
  const vcols = vc.rows.map((r) => r.column_name);
  await expect(['scheme', 'card_number_hash', 'masked_number', 'expiry_month', 'expiry_year', 'cvv_hash', 'status', 'daily_limit', 'per_txn_limit'].every((c) => vcols.includes(c)),
    'virtual_cards schema (hashed PAN/CVV + limits + status)');
  const ct = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'card_transactions'`);
  const tcols = ct.rows.map((r) => r.column_name);
  await expect(['merchant_name', 'amount', 'status', 'auth_reference', 'declined_reason', 'settled_at'].every((c) => tcols.includes(c)),
    'card_transactions schema (merchant/amount/status/auth_reference/declined_reason)');

  const anonIssue = await api('POST', '/api/cards');
  await expect(anonIssue.status === 401, 'Issue anonymous → 401', `status=${anonIssue.status}`);
  const issue = await api('POST', '/api/cards', holderTok, { scheme: 'VISA' });
  await expect(issue.status === 200 && !!issue.data.card, 'Issue VISA card', `status=${issue.status}`);
  const card = issue.data.card;
  const pan = issue.data.pan;
  const cvv = issue.data.cvv;
  await expect(/^\d{16}$/.test(pan) && luhnOk(pan), 'PAN 16 digits + Luhn checksum valid', pan);
  await expect(pan[0] === '4', 'VISA pan starts with 4');
  await expect(card.scheme === 'VISA' && card.status === 'ACTIVE', 'Card ACTIVE + scheme VISA');
  await expect(String(card.masked_number).endsWith(pan.slice(-4)) && String(card.masked_number).startsWith('****'), 'Masked number hides all but last 4', card.masked_number);
  await expect(Number(card.daily_limit) === 2000000 && Number(card.per_txn_limit) === 500000, 'Default limits: 2,000,000 daily / 500,000 per-txn');
  await expect(cvv && /^\d{3}$/.test(cvv), 'CVV 3 digits returned once at issuance');

  const dbRow = await pool.query('SELECT card_number_hash FROM virtual_cards WHERE id = $1', [card.id]);
  const expectedHash = crypto.createHash('sha256').update(pan).digest('hex');
  await expect(dbRow.rows[0].card_number_hash === expectedHash, 'DB stores sha256(PAN), not plaintext', dbRow.rows[0].card_number_hash);

  const mcIssue = await api('POST', '/api/cards', holderTok, { scheme: 'MASTERCARD' });
  await expect(mcIssue.data.pan[0] === '5', 'MASTERCARD pan starts with 5');
  const vvIssue = await api('POST', '/api/cards', holderTok, { scheme: 'VERVE' });
  await expect(vvIssue.data.pan[0] === '6', 'VERVE pan starts with 6');
  const fxIssue = await api('POST', '/api/cards', holderTok, { scheme: 'AMEX' });
  await expect(fxIssue.data.card.scheme === 'VISA', 'Unknown scheme defaults to VISA', fxIssue.data.card.scheme);
  const custLimit = await api('POST', '/api/cards', holderTok, { scheme: 'VISA', daily_limit: 700000, per_txn_limit: 120000 });
  await expect(Number(custLimit.data.card.daily_limit) === 700000 && Number(custLimit.data.card.per_txn_limit) === 120000,
    'Custom limits honored');

  await section('Ownership + PAN/CVV privacy');
  const list = await api('GET', '/api/cards', holderTok);
  await expect(list.status === 200 && list.data.cards.length >= 5, 'List shows issued cards', `n=${list.data.cards.length}`);
  await expect(list.data.cards.every((x) => !x.pan && !x.cvv && !x.card_number_hash), 'List leaks no PAN/CVV/hash');
  const detail = await api('GET', `/api/cards/${card.id}`, holderTok);
  await expect(detail.status === 200 && !detail.data.card.pan && !detail.data.card.cvv, 'Detail leaks no PAN/CVV');
  const otherGet = await api('GET', `/api/cards/${card.id}`, otherTok);
  await expect(otherGet.status === 403 && otherGet.data.code === 'CARD_NOT_OWNER', 'Other user detail → 403 CARD_NOT_OWNER');
  const ghostGet = await api('GET', '/api/cards/999999', holderTok);
  await expect(ghostGet.status === 404 && ghostGet.data.code === 'CARD_NOT_FOUND', 'Unknown card → 404 CARD_NOT_FOUND');

  await section('Limits + freeze/block state machine');
  const limUpd = await api('POST', `/api/cards/${card.id}/limits`, holderTok, { daily_limit: 300000, per_txn_limit: 60000 });
  await expect(limUpd.status === 200 && Number(limUpd.data.card.daily_limit) === 300000 && Number(limUpd.data.card.per_txn_limit) === 60000,
    'Limits updated + reflected');
  const overTxn = await api('POST', `/api/cards/${card.id}/authorize`, holderTok, { merchant_name: 'Amana Shop', amount: 90000, cvv });
  await expect(overTxn.status === 400 && overTxn.data.code === 'CARD_OVER_PER_TXN_LIMIT',
    'Over per-txn limit → 400 CARD_OVER_PER_TXN_LIMIT', `status=${overTxn.status} code=${overTxn.data.code}`);
  const freeze = await api('POST', `/api/cards/${card.id}/freeze`, holderTok, { freeze: true });
  await expect(freeze.status === 200 && freeze.data.result.status === 'FROZEN', 'Freeze → FROZEN');
  const frozenAuth = await api('POST', `/api/cards/${card.id}/authorize`, holderTok, { merchant_name: 'Amana Shop', amount: 5000, cvv });
  await expect(frozenAuth.status === 403 && frozenAuth.data.code === 'CARD_INACTIVE', 'Authorize on frozen → 403 CARD_INACTIVE');
  const unfreeze = await api('POST', `/api/cards/${card.id}/freeze`, holderTok, { freeze: false });
  await expect(unfreeze.data.result.status === 'ACTIVE', 'Unfreeze → ACTIVE');

  await section('Authorization — AUTH_HOLD on wallet (J3)');
  await fundWallet(holder.data.user.id, 100000);
  const before = await balances(holder.data.user.id);
  await expect(before.wallet === 100000 && before.locked === 0, 'Holder funded 100,000, nothing locked');
  const anonAuth = await api('POST', `/api/cards/${card.id}/authorize`);
  await expect(anonAuth.status === 401, 'Authorize anonymous → 401');
  const badAmt = await api('POST', `/api/cards/${card.id}/authorize`, holderTok, { merchant_name: 'K Store', amount: 0, cvv });
  await expect(badAmt.status === 400 && badAmt.data.code === 'CARD_AMOUNT_INVALID', 'Amount ≤ 0 → 400 CARD_AMOUNT_INVALID');
  const noMerch = await api('POST', `/api/cards/${card.id}/authorize`, holderTok, { amount: 5000, cvv });
  await expect(noMerch.status === 400 && noMerch.data.code === 'CARD_MERCHANT_REQUIRED', 'Missing merchant → 400 CARD_MERCHANT_REQUIRED');
  const otherAuth = await api('POST', `/api/cards/${card.id}/authorize`, otherTok, { merchant_name: 'K Store', amount: 5000, cvv });
  await expect(otherAuth.status === 403 && otherAuth.data.code === 'CARD_NOT_OWNER', 'Authorize another user card → 403 CARD_NOT_OWNER');
  const badCvv = await api('POST', `/api/cards/${card.id}/authorize`, holderTok, { merchant_name: 'K Store', amount: 5000, cvv: '000' });
  await expect(badCvv.status === 400 && badCvv.data.code === 'CARD_INVALID_CVV', 'Wrong CVV → 400 CARD_INVALID_CVV');

  const authToSettle = await api('POST', `/api/cards/${card.id}/authorize`, holderTok, { merchant_name: 'NMB Superstore', amount: 10000, cvv });
  const authRes = authToSettle.data.result;
  await expect(authToSettle.status === 200 && authRes && authRes.status === 'AUTH_HOLD', 'Authorize 10,000 → AUTH_HOLD', `status=${authToSettle.status} inner=${authRes && authRes.status}`);
  const authRef = authRes.auth_reference;
  await expect(String(authRef).startsWith('AUTH-'), 'auth_reference AUTH-*', String(authRef));
  const held = await balances(holder.data.user.id);
  await expect(held.wallet === 90000 && held.locked === 10000, 'Wallet −10,000 / locked +10,000 (total constant)', JSON.stringify(held));
  const cardTxn = await pool.query(
    `SELECT merchant_name, amount, status FROM card_transactions WHERE auth_reference = $1`, [authRef]
  );
  await expect(cardTxn.rows.length === 1 && cardTxn.rows[0].status === 'AUTH_HOLD' && cardTxn.rows[0].merchant_name === 'NMB Superstore' && Number(cardTxn.rows[0].amount) === 10000,
    'card_transactions AUTH_HOLD row (merchant + amount)');
  const lockJe = await pool.query(
    `SELECT j.direction, j.amount, la.account_code AS acct FROM journal_entries j
     JOIN ledger_accounts la ON la.id = j.account_id WHERE j.reference_id = $1`, [`${authRef}:LOCK`]
  );
  const lockDr = lockJe.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
  const lockCr = lockJe.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
  await expect(lockJe.rows.length === 2 && lockDr === 10000 && lockCr === 10000 && lockJe.rows.some((r) => r.acct === 'CARD_HOLD'),
    'Lock journal balanced (DR CUSTOMER_WALLET = CR CARD_HOLD = 10,000)', JSON.stringify(lockJe.rows.map((r) => ({ a: r.acct, d: r.direction, v: Number(r.amount) }))));

  await section('Decline paths recorded');
  const dayCardIssue = await api('POST', '/api/cards', holderTok, { daily_limit: 10000, per_txn_limit: 20000 });
  const dayCard = dayCardIssue.data.card;
  const dayCvv = dayCardIssue.data.cvv;
  const d1 = await api('POST', `/api/cards/${dayCard.id}/authorize`, holderTok, { merchant_name: 'Jiji Market', amount: 6000, cvv: dayCvv });
  await expect(d1.status === 200 && d1.data.result && d1.data.result.status === 'AUTH_HOLD', 'Daily-limit card: first 6,000 authorized');
  const d2 = await api('POST', `/api/cards/${dayCard.id}/authorize`, holderTok, { merchant_name: 'Jiji Market', amount: 6000, cvv: dayCvv });
  await expect(d2.status === 400 && d2.data.code === 'CARD_OVER_DAILY_LIMIT',
    'Cumulative spend over daily limit → 400 CARD_OVER_DAILY_LIMIT', `status=${d2.status} code=${d2.data.code}`);
  const dDecl = await pool.query(
    `SELECT declined_reason FROM card_transactions WHERE card_id = $1 AND status = 'DECLINED' ORDER BY id DESC LIMIT 1`, [dayCard.id]
  );
  await expect(dDecl.rows[0]?.declined_reason === 'OVER_DAILY_LIMIT', 'Decline logged with OVER_DAILY_LIMIT reason', String(dDecl.rows[0]?.declined_reason));

  const brokeCardIssue = await api('POST', '/api/cards', brokeTok, {});
  const brokeCard = brokeCardIssue.data.card;
  const brokeMid = await api('POST', `/api/cards/${brokeCard.id}/authorize`, brokeTok, { merchant_name: 'Genuine Traders', amount: 5000, cvv: brokeCardIssue.data.cvv });
  await expect(brokeMid.status === 400 && brokeMid.data.code === 'WALLET_INSUFFICIENT_FUNDS',
    'Authorize without funds → 400 WALLET_INSUFFICIENT_FUNDS', `status=${brokeMid.status} code=${brokeMid.data.code}`);
  const brokeDecl = await pool.query(
    `SELECT declined_reason FROM card_transactions WHERE card_id = $1 AND status = 'DECLINED' AND declined_reason = 'INSUFFICIENT_FUNDS' ORDER BY id DESC LIMIT 1`, [brokeCard.id]
  );
  await expect(brokeDecl.rows.length === 1, 'Decline logged with INSUFFICIENT_FUNDS reason');

  await section('Settlement (J4, admin-only)');
  const nonAdminSettle = await api('POST', '/api/cards/admin/settle', holderTok, { auth_reference: authRef });
  await expect(nonAdminSettle.status === 403, 'Settle by non-admin → 403', `status=${nonAdminSettle.status}`);
  const anonSettle = await api('POST', '/api/cards/admin/settle');
  await expect(anonSettle.status === 401, 'Settle anonymous → 401', `status=${anonSettle.status}`);
  const ghostSettle = await api('POST', '/api/cards/admin/settle', adminTok, { auth_reference: 'AUTH-NOPE' });
  await expect(ghostSettle.status === 404 && ghostSettle.data.code === 'CARD_AUTH_NOT_FOUND',
    'Settle unknown auth → 404 CARD_AUTH_NOT_FOUND', `status=${ghostSettle.status} code=${ghostSettle.data.code}`);
  const preSettle = await balances(holder.data.user.id);
  const settle = await api('POST', '/api/cards/admin/settle', adminTok, { auth_reference: authRef });
  await expect(settle.status === 200 && settle.data.result && settle.data.result.status === 'SETTLED', 'Admin settle → SETTLED', `status=${settle.status} inner=${settle.data.result && settle.data.result.status}`);
  const afterSettle = await balances(holder.data.user.id);
  await expect(afterSettle.wallet === preSettle.wallet && afterSettle.locked === preSettle.locked - 10000,
    'Capture: locked −10,000 (wallet unchanged)', JSON.stringify({ before: preSettle, after: afterSettle }));
  const settledRow = await pool.query(`SELECT status FROM card_transactions WHERE auth_reference = $1`, [authRef]);
  await expect(settledRow.rows[0].status === 'SETTLED', 'card_transactions → SETTLED');
  const capJe = await pool.query(
    `SELECT j.direction, j.amount, la.account_code AS acct FROM journal_entries j
     JOIN ledger_accounts la ON la.id = j.account_id WHERE j.reference_id = $1`, [`${authRef}:CAPTURE`]
  );
  const capDr = capJe.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
  const capCr = capJe.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
  await expect(capJe.rows.length === 2 && capDr === 10000 && capCr === 10000 && capJe.rows.some((r) => r.acct === 'MNO_CLEARING'),
    'Capture journal balanced (DR CARD_HOLD = CR MNO_CLEARING = 10,000)');
  const settleTwice = await api('POST', '/api/cards/admin/settle', adminTok, { auth_reference: authRef });
  await expect(settleTwice.status === 404 && settleTwice.data.code === 'CARD_AUTH_NOT_FOUND',
    'Settle again → 404 (no double capture)', `status=${settleTwice.status} code=${settleTwice.data.code}`);

  await section('Refund (J5, admin-only)');
  const refundTarget = await api('POST', `/api/cards/${card.id}/authorize`, holderTok, { merchant_name: 'Zainab Boutique', amount: 6000, cvv });
  await expect(refundTarget.status === 200 && refundTarget.data.result && refundTarget.data.result.status === 'AUTH_HOLD', 'Authorize 6,000 for refund flow');
  const refundRef = refundTarget.data.result.auth_reference;
  const beforeRefund = await balances(holder.data.user.id);
  const nonAdminRefund = await api('POST', '/api/cards/admin/refund', holderTok, { auth_reference: refundRef });
  await expect(nonAdminRefund.status === 403, 'Refund by non-admin → 403');
  const refund = await api('POST', '/api/cards/admin/refund', adminTok, { auth_reference: refundRef });
  await expect(refund.status === 200 && refund.data.result && refund.data.result.status === 'REFUNDED', 'Admin refund → REFUNDED', `status=${refund.status} inner=${refund.data.result && refund.data.result.status}`);
  const afterRefund = await balances(holder.data.user.id);
  await expect(afterRefund.wallet === beforeRefund.wallet + 6000 && afterRefund.locked === beforeRefund.locked - 6000,
    'Refund: locked → available (wallet +6,000)', JSON.stringify({ before: beforeRefund, after: afterRefund }));
  const refundRow = await pool.query(`SELECT status FROM card_transactions WHERE auth_reference = $1`, [refundRef]);
  await expect(refundRow.rows[0].status === 'REFUNDED', 'card_transactions → REFUNDED');
  const relJe = await pool.query(
    `SELECT j.direction, j.amount, la.account_code AS acct FROM journal_entries j
     JOIN ledger_accounts la ON la.id = j.account_id WHERE j.reference_id = $1`, [`${refundRef}:REFUND`]
  );
  const relDr = relJe.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
  const relCr = relJe.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
  await expect(relJe.rows.length === 2 && relDr === 6000 && relCr === 6000 && relJe.rows.some((r) => r.acct === 'CUSTOMER_WALLET'),
    'Release journal balanced (DR CARD_HOLD = CR CUSTOMER_WALLET = 6,000)');
  const refundTwice = await api('POST', '/api/cards/admin/refund', adminTok, { auth_reference: refundRef });
  await expect(refundTwice.status === 404 && refundTwice.data.code === 'CARD_AUTH_NOT_FOUND',
    'Refund again → 404 (no double release)');
  const settleRefunded = await api('POST', '/api/cards/admin/settle', adminTok, { auth_reference: refundRef });
  await expect(settleRefunded.status === 404, "Settle a refunded auth → 404");

  await section('Statement + summary (J6)');
  const stmt = await api('GET', `/api/cards/${card.id}/transactions`, holderTok);
  await expect(stmt.status === 200 && Array.isArray(stmt.data.result.transactions), 'Statement returns transactions');
  const stmtRows = stmt.data.result.transactions;
  await expect(stmtRows.some((t) => t.status === 'SETTLED' && t.merchant_name === 'NMB Superstore'),
    'Statement has settled AUTH_HOLD history');
  await expect(stmtRows.some((t) => t.status === 'REFUNDED' && t.merchant_name === 'Zainab Boutique'),
    'Statement has refunded transaction');
  await expect(stmtRows.some((t) => t.status === 'DECLINED' && t.declined_reason === 'INVALID_CVV'),
    'Statement has DECLINED row with reason');
  const otherStmt = await api('GET', `/api/cards/${card.id}/transactions`, otherTok);
  await expect(otherStmt.status === 403 && otherStmt.data.code === 'CARD_NOT_OWNER', 'Other user statement → 403 CARD_NOT_OWNER');

  const leaveFrozen = await api('POST', `/api/cards/${custLimit.data.card.id}/freeze`, holderTok, { freeze: true });
  await expect(leaveFrozen.status === 200, 'Freeze one card before summary (kept frozen)');
  const sum = await api('GET', '/api/cards/summary', holderTok);
  await expect(sum.status === 200 && !!sum.data.summary, 'Summary endpoint works');
  const s = sum.data.summary;
  await expect(Number(s.totalCards) >= 5, 'Summary totalCards counts issued cards', `total=${s.totalCards}`);
  await expect(Number(s.activeAuthHolds) >= 1, 'Summary activeAuthHolds ≥ 1 (AUTH_HOLD counts)', `holds=${s.activeAuthHolds}`);
  await expect(Number(s.lockedBalanceTotal) >= 6000, 'Summary lockedBalanceTotal reflects live hold', `locked=${s.lockedBalanceTotal}`);
  await expect(Number(s.spendThisMonth) > 0, 'Summary spendThisMonth reflects settled+held', `spend=${s.spendThisMonth}`);
  await expect(Number(s.frozenCards) >= 1, 'Summary frozen count ≥ 1 (card left frozen)', `frozen=${s.frozenCards}`);

  console.log(failed === 0
    ? `\nPASSED ${passed}/${passed + failed} checks`
    : `\nFAILED ${passed}/${passed + failed} checks — ${failures.join('; ')}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SUITE_ERROR', e);
  process.exit(1);
});