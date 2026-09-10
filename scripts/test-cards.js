/* ============================================================
 * AFRIKOBA GLOBAL - VIRTUAL CARDS REGRESSION
 * Full J1-J6 lifecycle: issue (Luhn PAN, masked number, cvv once,
 * scheme handling) + ownership-scoped manage (limits/freeze/
 * unfreeze/block, RBAC), J3 authorization holds (per-txn + daily
 * limit declines with reason rows, wallet lock via engine with
 * balanced CUSTOMER_WALLET / CARD_HOLD journal), J4 merchant
 * settlement (captureLock → MNO_CLEARING), J5 refunds
 * (unlockWallet → wallet), J6 statement + monthly summary.
 * Covers /api/cards + /api/v1/cards. Suite 44.
 * ============================================================ */
const BASE = process.env.CARD_TEST_BASE || 'http://127.0.0.1:3000';
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
async function login(phoneNumber) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/login', null, { phoneNumber, otp });
  return r.data;
}
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 4; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
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
  const s = String(pan);
  if (!/^\d{16}$/.test(s)) return false;
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
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
  const other = await register(`255781${suffix}`, 'Card Other');
  const adm = await register(`255782${suffix}`, 'Card Admin');
  await expect(holder.data.token && other.data.token && adm.data.token, 'Users registered');
  const holderTok = holder.data.token;
  const otherTok = other.data.token;
  const adminTok = await makeAdmin(adm);
  await expect(!!adminTok, 'Admin token (role promoted)');
  await fundWallet(holder.data.user.id, 500000);

  await section('Schema evidence');
  const vsc = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'virtual_cards'`);
  const vcols = vsc.rows.map((r) => r.column_name);
  await expect(['scheme', 'card_number_hash', 'masked_number', 'cvv_hash', 'status', 'daily_limit', 'per_txn_limit'].every((c) => vcols.includes(c)),
    'virtual_cards schema (hash-only pan/cvv, status, limits)');
  const ctc = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'card_transactions'`);
  const ccols = ctc.rows.map((r) => r.column_name);
  await expect(['card_id', 'merchant_name', 'amount', 'status', 'auth_reference', 'declined_reason', 'settled_at'].every((c) => ccols.includes(c)),
    'card_transactions schema (auth_reference, declined_reason)');

  await section('J1-J2 Issue');
  const anonIssue = await api('POST', '/api/cards');
  await expect(anonIssue.status === 401, 'Issue anonymous → 401', `status=${anonIssue.status}`);
  const defScheme = await api('POST', '/api/cards', holderTok, { scheme: 'AMEX' });
  await expect(defScheme.status === 200 && defScheme.data.card.scheme === 'VISA', 'Unknown scheme → default VISA', `scheme=${defScheme.data.card.scheme}`);
  const card1 = defScheme.data.card;
  const pan1 = defScheme.data.pan;
  const cvv1 = defScheme.data.cvv;
  await expect(card1.id && /^\d{3}$/.test(String(cvv1)), 'CVV (3-digit) returned once', String(cvv1).slice(0, 3) + '***');
  await expect(!!pan1 && luhnOk(pan1), 'PAN 16-digit Luhn-valid returned once');
  await expect(card1.masked_number === `**** **** **** ${String(pan1).slice(-4)}`, 'Masked number shows last 4 only', card1.masked_number);
  const today = new Date();
  await expect(Number(card1.expiry_year) === today.getFullYear() + 3 && card1.expiry_month !== '', 'Expiry year = now + 3', card1.expiry_year);
  const verify = await api('POST', '/api/cards', holderTok, { scheme: 'VERVE' });
  await expect(verify.status === 200 && verify.data.card.scheme === 'VERVE', 'VERVE scheme honored', verify.data.card.scheme);
  const card2 = verify.data.card;
  const authC = await api('POST', '/api/cards', holderTok, { scheme: 'MASTERCARD', daily_limit: 200000, per_txn_limit: 20000 });
  await expect(authC.status === 200 && authC.data.card.scheme === 'MASTERCARD', 'MASTERCARD + custom limits honored');
  const card3 = authC.data.card;
  const cvv3 = authC.data.cvv;

  const list = await api('GET', '/api/cards', holderTok);
  await expect(list.status === 200 && list.data.cards.length === 3, 'List 3 cards (masked only, no pan)', `n=${list.data.cards.length}`);
  await expect(list.data.cards.every((c) => !c.card_number_hash && !c.cvv_hash && !c.pan), 'No pan/hash leaks in list');
  const listOther = await api('GET', '/api/cards', otherTok);
  await expect(listOther.data.cards.length === 0, 'Other user list empty (ownership scope)');
  const zen = await api('GET', `/api/cards/${card1.id}`, holderTok);
  await expect(zen.status === 200 && zen.data.card.masked_number === card1.masked_number && !zen.data.card.pan, 'Card detail masked, no pan');
  const notMine = await api('GET', `/api/cards/${card1.id}`, otherTok);
  await expect(notMine.status === 403, 'Other user card detail → 403', `status=${notMine.status}`);
  const ghost = await api('GET', '/api/cards/999999', holderTok);
  await expect(ghost.status === 404, 'Unknown card detail → 404', `status=${ghost.status}`);

  await section('J1 manage — limits / freeze / block');
  const setLims = await api('POST', `/api/cards/${card1.id}/limits`, holderTok, { daily_limit: 300000, per_txn_limit: 50000 });
  await expect(setLims.status === 200 && Number(setLims.data.card.daily_limit) === 300000 && Number(setLims.data.card.per_txn_limit) === 50000,
    'Set limits persisted', JSON.stringify({ d: setLims.data.card.daily_limit, p: setLims.data.card.per_txn_limit }));
  const freeze = await api('POST', `/api/cards/${card1.id}/freeze`, holderTok, { freeze: true });
  await expect(freeze.status === 200 && freeze.data.result.status === 'FROZEN', 'Freeze → FROZEN', freeze.status);
  const unfreeze = await api('POST', `/api/cards/${card1.id}/freeze`, holderTok, { freeze: false });
  await expect(unfreeze.status === 200 && unfreeze.data.result.status === 'ACTIVE', 'Unfreeze → ACTIVE');
  const block2 = await api('POST', `/api/cards/${card2.id}/block`, holderTok);
  await expect(block2.status === 200 && block2.data.result.status === 'BLOCKED', 'Block → BLOCKED');
  const limBlocked = await api('POST', `/api/cards/${card2.id}/limits`, holderTok, { daily_limit: 1000 });
  await expect(limBlocked.status === 403, 'Limits on BLOCKED card → 403', `status=${limBlocked.status}`);

  await section('J3 Authorization — hold + declines');
  const anonAuth = await api('POST', `/api/cards/${card3.id}/authorize`, null, { merchant_name: 'TZ Supermarket', amount: 1000, cvv: cvv3 });
  await expect(anonAuth.status === 401, 'Authorize anonymous → 401', `status=${anonAuth.status}`);
  const noAmt = await api('POST', `/api/cards/${card3.id}/authorize`, holderTok, { merchant_name: 'TZ Supermarket', cvv: cvv3 });
  await expect(noAmt.status === 400, 'Authorize without amount → 400', `status=${noAmt.status}`);
  const badCvv = await api('POST', `/api/cards/${card3.id}/authorize`, holderTok, { merchant_name: 'TZ Supermarket', amount: 50000, cvv: '000' });
  await expect(badCvv.status === 400, 'Authorize wrong CVV → 400', `status=${badCvv.status}`);
  const rowBad = await pool.query(`SELECT declined_reason FROM card_transactions WHERE auth_reference = $1`, [badCvv.data.result ? badCvv.data.result.auth_reference : null]);
  const badSrc = await pool.query(`SELECT declined_reason FROM card_transactions WHERE card_id = $1 AND status = 'DECLINED' ORDER BY id DESC LIMIT 1`, [card3.id]);
  await expect(badSrc.rows[0]?.declined_reason === 'INVALID_CVV', 'INVALID_CVV decline row recorded', badSrc.rows[0]?.declined_reason);
  const overTxn = await api('POST', `/api/cards/${card3.id}/authorize`, holderTok, { merchant_name: 'TZ Supermarket', amount: 30000, cvv: cvv3 });
  await expect(overTxn.status === 400, 'Per-txn limit decline (30k > 20k) → 400', `status=${overTxn.status}`);
  const overSrc = await pool.query(`SELECT declined_reason FROM card_transactions WHERE card_id = $1 AND status = 'DECLINED' ORDER BY id DESC LIMIT 1`, [card3.id]);
  await expect(overSrc.rows[0]?.declined_reason === 'OVER_TRANSACTION_LIMIT', 'OVER_TRANSACTION_LIMIT decline row', overSrc.rows[0]?.declined_reason);
  const relaxLimits = await api('POST', `/api/cards/${card3.id}/limits`, holderTok, { per_txn_limit: 500000 });
  await expect(Number(relaxLimits.data.card.per_txn_limit) === 500000, 'per-txn limit raised for high-value auth');
  const auth1 = await api('POST', `/api/cards/${card3.id}/authorize`, holderTok, { merchant_name: 'TZ Supermarket', amount: 100000, cvv: cvv3 });
  const authRef1 = auth1.data.result?.auth_reference;
  await expect(auth1.status === 200 && auth1.data.result.status === 'AUTH_HOLD' && /^AUTH-[0-9A-F]{8}$/.test(String(authRef1)),
    'Authorize 100k → AUTH_HOLD + ref AUTH-XXXXXXXX', auth1.status);
  let b = await balances(holder.data.user.id);
  await expect(b.wallet === 400000 && b.locked === 100000, 'Wallet 500000→400000 (100k moved to locked)', JSON.stringify(b));
  await expect(Number(auth1.data.result.locked_balance) === 100000 && Number(auth1.data.result.wallet_balance) === 400000,
    'Response echoes hold balances');
  const overDaily = await api('POST', `/api/cards/${card3.id}/authorize`, holderTok, { merchant_name: 'TZ Supermarket', amount: 150000, cvv: cvv3 });
  await expect(overDaily.status === 400, 'Daily limit decline (100k+150k > 200k) → 400', `status=${overDaily.status}`);
  const dailySrc = await pool.query(`SELECT declined_reason FROM card_transactions WHERE card_id = $1 AND status = 'DECLINED' ORDER BY id DESC LIMIT 1`, [card3.id]);
  await expect(dailySrc.rows[0]?.declined_reason === 'OVER_DAILY_LIMIT', 'OVER_DAILY_LIMIT decline row', dailySrc.rows[0]?.declined_reason);
  const lockJournal = await pool.query(
    `SELECT j.direction, j.amount, la.account_code AS acct FROM journal_entries j
     JOIN ledger_accounts la ON la.id = j.account_id WHERE j.reference_id = $1`, [`${authRef1}:LOCK`]
  );
  const lockDr = lockJournal.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
  const lockCr = lockJournal.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
  await expect(lockJournal.rows.length === 2 && lockDr === 100000 && lockCr === 100000 &&
    lockJournal.rows.some((r) => r.acct === 'CARD_HOLD') && lockJournal.rows.some((r) => r.acct === 'CUSTOMER_WALLET'),
    'Auth hold journal balanced (DR CUSTOMER_WALLET = CR CARD_HOLD = 100k)', JSON.stringify(lockJournal.rows.map((r) => ({ a: r.acct, d: r.direction, v: Number(r.amount) }))));

  const frozenAuth = await api('POST', `/api/cards/${card3.id}/freeze`, holderTok, { freeze: true });
  const froz = await api('POST', `/api/cards/${card3.id}/authorize`, holderTok, { merchant_name: 'TZ Supermarket', amount: 5000, cvv: cvv3 });
  await expect(froz.status === 403 && frozenAuth.data.result.status === 'FROZEN', 'Authorize FROZEN card → 403', `status=${froz.status}`);
  const fichRow = await pool.query(`SELECT declined_reason FROM card_transactions WHERE card_id = $1 AND status = 'DECLINED' ORDER BY id DESC LIMIT 1`, [card3.id]);
  await expect(fichRow.rows[0]?.declined_reason === 'CARD_FROZEN', 'CARD_FROZEN decline row');
  await api('POST', `/api/cards/${card3.id}/freeze`, holderTok, { freeze: false });

  await pool.query('UPDATE users SET wallet_balance = 30000 WHERE id = $1', [holder.data.user.id]);
  const drained = await api('POST', `/api/cards/${card3.id}/authorize`, holderTok, { merchant_name: 'TZ Supermarket', amount: 60000, cvv: cvv3 });
  await expect(drained.status === 400, 'Authorize with insufficient balance → 400', `status=${drained.status}`);
  const insufRow = await pool.query(`SELECT declined_reason FROM card_transactions WHERE card_id = $1 AND status = 'DECLINED' ORDER BY id DESC LIMIT 1`, [card3.id]);
  await expect(insufRow.rows[0]?.declined_reason === 'INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS decline row', insufRow.rows[0]?.declined_reason);

  await section('J6 Statement — declined + hold history');
  const stmt = await api('GET', `/api/cards/${card3.id}/transactions`, holderTok);
  await expect(stmt.status === 200 && stmt.data.result.card.id === card3.id, 'Statement for card', stmt.status);
  const stxs = stmt.data.result.transactions;
  await expect(stxs.some((t) => t.auth_reference === authRef1 && t.status === 'AUTH_HOLD'), 'Statement shows AUTH_HOLD auth');
  await expect(stxs.some((t) => t.status === 'DECLINED' && t.declined_reason === 'INSUFFICIENT_FUNDS'), 'Statement shows declined rows');
  const stmtOther = await api('GET', `/api/cards/${card3.id}/transactions`, otherTok);
  await expect(stmtOther.status === 403, 'Statement other user card → 403', `status=${stmtOther.status}`);

  await section('J4/J5 Settlement + Refund (admin)');
  const memSettle = await api('POST', '/api/cards/admin/settle', holderTok, { auth_reference: authRef1 });
  await expect(memSettle.status === 403, 'Non-admin settle → 403', `status=${memSettle.status}`);
  const ghostSettle = await api('POST', '/api/cards/admin/settle', adminTok, { auth_reference: 'AUTH-00000000' });
  await expect(ghostSettle.status === 404, 'Settle unknown auth → 404', `status=${ghostSettle.status}`);
  await fundWallet(holder.data.user.id, 470000);
  const auth2 = await api('POST', `/api/cards/${card3.id}/authorize`, holderTok, { merchant_name: 'TZ Supermarket', amount: 60000, cvv: cvv3 });
  const authRef2 = auth2.data.result?.auth_reference;
  b = await balances(holder.data.user.id);
  await expect(auth2.status === 200 && b.locked === 160000, '2nd authorize 60k → locked 160000', JSON.stringify(b));
  const refund = await api('POST', '/api/cards/admin/refund', adminTok, { auth_reference: authRef2 });
  await expect(refund.status === 200 && refund.data.result.status === 'REFUNDED', 'Refund auth2 → REFUNDED', refund.status);
  b = await balances(holder.data.user.id);
  await expect(b.wallet === 500000 && b.locked === 100000, 'Refund 60k back to wallet (locked 160k→100k)', JSON.stringify(b));
  const refundJ = await pool.query(
    `SELECT j.direction, j.amount, la.account_code AS acct FROM journal_entries j
     JOIN ledger_accounts la ON la.id = j.account_id WHERE j.reference_id = $1`, [`${authRef2}:REFUND`]
  );
  const rdr = refundJ.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
  const rcr = refundJ.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
  await expect(refundJ.rows.length === 2 && rdr === 60000 && rcr === 60000 &&
    refundJ.rows.some((r) => r.acct === 'CARD_HOLD') && refundJ.rows.some((r) => r.acct === 'CUSTOMER_WALLET'),
    'Refund journal balanced (DR CARD_HOLD = CR CUSTOMER_WALLET = 60k)', JSON.stringify(refundJ.rows.map((r) => ({ a: r.acct, d: r.direction, v: Number(r.amount) }))));

  const settle = await api('POST', '/api/cards/admin/settle', adminTok, { auth_reference: authRef1 });
  await expect(settle.status === 200 && settle.data.result.status === 'SETTLED', 'Settle auth1 → SETTLED', settle.status);
  b = await balances(holder.data.user.id);
  await expect(b.wallet === 500000 && b.locked === 0, 'Settle 100k leaves wallet 500000, locked 0', JSON.stringify(b));
  const capJ = await pool.query(
    `SELECT j.direction, j.amount, la.account_code AS acct FROM journal_entries j
     JOIN ledger_accounts la ON la.id = j.account_id WHERE j.reference_id = $1`, [`${authRef1}:CAPTURE`]
  );
  const cdr = capJ.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
  const ccr = capJ.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
  await expect(capJ.rows.length === 2 && cdr === 100000 && ccr === 100000 &&
    capJ.rows.some((r) => r.acct === 'CARD_HOLD') && capJ.rows.some((r) => r.acct === 'MNO_CLEARING'),
    'Settlement journal balanced (DR CARD_HOLD = CR MNO_CLEARING = 100k)', JSON.stringify(capJ.rows.map((r) => ({ a: r.acct, d: r.direction, v: Number(r.amount) }))));
  const twice = await api('POST', '/api/cards/admin/settle', adminTok, { auth_reference: authRef1 });
  await expect(twice.status === 404, 'Settle already-settled → 404', `status=${twice.status}`);
  const txRow = await pool.query(`SELECT status, settled_at FROM card_transactions WHERE auth_reference = $1`, [authRef1]);
  await expect(txRow.rows[0]?.status === 'SETTLED' && !!txRow.rows[0].settled_at, 'card_transactions marked SETTLED + settled_at');

  await section('Summary');
  const sum = await api('GET', '/api/cards/summary', holderTok);
  const s = sum.data.summary;
  await expect(s.totalCards === 3, 'Summary totalCards = 3', String(s.totalCards));
  await expect(s.activeCards === 2 && s.frozenCards === 0 && s.blockedCards === 1, 'Summary status counts (2 active / 1 blocked)', JSON.stringify({ a: s.activeCards, f: s.frozenCards, b: s.blockedCards }));
  await expect(Number(s.spendThisMonth) === 100000, 'spendThisMonth = settled 100k only', String(s.spendThisMonth));
  await expect(Number(s.lockedBalanceTotal) === 0, 'lockedBalanceTotal = 0 after settle', String(s.lockedBalanceTotal));

  console.log(failed === 0
    ? `\nPASSED ${passed}/${passed + failed} checks`
    : `\nFAILED ${failed}/${passed + failed} checks — ${failures.join('; ')}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SUITE_ERROR', e);
  process.exit(1);
});