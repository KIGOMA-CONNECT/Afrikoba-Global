/* ============================================================
 * AFRIKOBA GLOBAL - CROSS-BORDER REMITTANCE LIFECYCLE
 * + PAYOUT ADAPTER LAYER (increment 21, suite 66)
 *
 * migration 121 adds:
 *   - remittance_quotes (RMQ-*): 5-min rate-locked quotes
 *   - remittance_payouts: adapter-layer payout instructions
 *     (WALLET real credit / MNO-AGENT simulated rails)
 *   - beneficiaries += country_code, currency_code, payout_method
 *   - remittance_transfers += quote_id, beneficiary_id,
 *     payout_method, expires_at (24h), picked_up_at,
 *     cancelled_at, refunded_at, refund_reference
 *
 * API surface (all under /api/network):
 *   POST /remittance/quote          { to_country, from_amount }
 *   GET  /remittance/quotes          active quotes for caller
 *   POST /remittance/send            quote_id/beneficiary_id/payout_method aware
 *   POST /remittance/pickup          no-auth pickup (legacy)
 *   GET  /remittance/history         enriched history (auto-expire)
 *   POST /remittance/:reference/cancel  sender cancel + full refund
 *   POST /remittance/expire          ADMIN force-expire stale PENDING
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
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
const nowSuffix = () => String(Date.now()).slice(-7);
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
}
async function walletOf(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}
async function ledgerTotal(code, direction, ref) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(j.amount),0) AS total FROM journal_entries j
     JOIN ledger_accounts a ON a.id = j.account_id
     WHERE a.account_code = $1 AND j.direction = $2 AND j.reference_id = $3`,
    [code, direction, ref]
  );
  return Number(r.rows[0].total);
}
async function deliveryCount(eventType) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE event_type = $1', [eventType]);
  return r.rows[0].n;
}
const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  // ---------- 1. Schema evidence (121_remittance_lifecycle) ----------
  await section('Schema evidence (121_remittance_lifecycle)');
  const qc = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'remittance_quotes'`
  )).rows.map((r) => r.column_name);
  await expect(['id', 'reference_id', 'user_id', 'from_country', 'to_country', 'from_currency',
    'to_currency', 'amount_in', 'fee', 'fee_percentage', 'exchange_rate', 'amount_out',
    'status', 'expires_at', 'used_at'].every((c) => qc.includes(c)),
    'remittance_quotes carries quote/rate-lock columns');
  const pc = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'remittance_payouts'`
  )).rows.map((r) => r.column_name);
  await expect(['transfer_id', 'payout_method', 'provider', 'amount', 'currency', 'status',
    'instruction', 'reference', 'error', 'processed_at'].every((c) => pc.includes(c)),
    'remittance_payouts carries adapter-layer columns');
  const bc = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'beneficiaries'`
  )).rows.map((r) => r.column_name);
  await expect(['country_code', 'currency_code', 'payout_method'].every((c) => bc.includes(c)),
    'beneficiaries enriched with routing fields');
  const tc = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'remittance_transfers'`
  )).rows.map((r) => r.column_name);
  await expect(['quote_id', 'beneficiary_id', 'payout_method', 'expires_at', 'picked_up_at',
    'cancelled_at', 'refunded_at', 'refund_reference'].every((c) => tc.includes(c)),
    'remittance_transfers lifecycle columns present');

  // ---------- 2. Setup ----------
  await section('Setup: users + webhook');
  const sfx = nowSuffix();
  const sender = await register(`25560${sfx}`, 'RM Sender');
  const recipient = await register(`25561${sfx}`, 'RM Recipient');
  const admin = await register(`25562${sfx}`, 'RM Admin');
  const member = await register(`25563${sfx}`, 'RM Member');
  await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [admin.user.id]);
  await pool.query(`UPDATE users SET kyc_level = 1 WHERE id IN ($1,$2,$3,$4)`,
    [sender.user.id, recipient.user.id, admin.user.id, member.user.id]);
  await fundWallet(sender.user.id, 200000);
  await fundWallet(recipient.user.id, 500000);
  const sTok = sender.token, rTok = recipient.token, aTok = admin.token, mTok = member.token;
  const sId = sender.user.id, rId = recipient.user.id;

  const wh = await api('POST', '/api/network/webhooks', sTok, {
    url: 'http://127.0.0.1:9/afrikoba-hook',
    events: ['remittance.sent', 'remittance.picked_up', 'remittance.cancelled', 'remittance.expired']
  });
  await expect(wh.status === 200 && wh.data.success && Array.isArray(wh.data.webhook.events),
    'sender webhook subscription created', `status=${wh.status}`);

  // ---------- 3. Quote API (rate-lock) ----------
  await section('Quote API (5-minute rate lock)');
  const qUnauth = await api('POST', '/api/network/remittance/quote', null, { to_country: 'KE', from_amount: 10000 });
  await expect(qUnauth.status === 401, 'unauthenticated quote -> 401');

  const q1 = await api('POST', '/api/network/remittance/quote', sTok, { to_country: 'KE', from_amount: 10000 });
  await expect(q1.status === 200 && q1.data.success && q1.data.result.reference_id.indexOf('RMQ-') === 0,
    'valid quote created (RMQ-* reference)', `status=${q1.status}`);
  const Q = q1.data.result;
  await expect(Number(Q.amount_in) === 10000 && Number(Q.fee) === 250 && Number(Q.amount_out) === 409.5
    && Number(Q.fee_percentage) === 2.5 && Number(Q.exchange_rate) === 0.042
    && Q.from_currency === 'TZS' && Q.to_currency === 'KES',
    'quote math locked (fee 2.5%, rate 0.042, out 409.5)',
    JSON.stringify({ f: Q.fee, o: Q.amount_out }));
  const mins = (new Date(Q.expires_at) - Date.now()) / 60000;
  await expect(mins > 4 && mins < 6, 'quote expires in ~5 minutes', `mins=${mins.toFixed(1)}`);
  await expect(Q.status === 'ACTIVE', 'quote status ACTIVE');

  const qList = await api('GET', '/api/network/remittance/quotes', sTok);
  await expect(qList.status === 200 && qList.data.quotes.some((x) => x.id === Q.quote_id),
    'active quote visible in GET /remittance/quotes');

  const qBad = await api('POST', '/api/network/remittance/quote', sTok, { to_country: 'KE', from_amount: 0 });
  await expect(qBad.status === 400 && qBad.data.code === 'REMITTANCE_AMOUNT_INVALID',
    'zero amount -> 400 REMITTANCE_AMOUNT_INVALID', JSON.stringify(qBad.data));
  const qNoCorr = await api('POST', '/api/network/remittance/quote', sTok, { to_country: 'XX', from_amount: 5000 });
  await expect(qNoCorr.status === 404 && qNoCorr.data.code === 'REMITTANCE_CORRIDOR_NOT_FOUND',
    'unsupported corridor -> 404 REMITTANCE_CORRIDOR_NOT_FOUND', JSON.stringify(qNoCorr.data));
  const qRange = await api('POST', '/api/network/remittance/quote', sTok, { to_country: 'KE', from_amount: 1 });
  await expect(qRange.status === 400 && qRange.data.code === 'REMITTANCE_AMOUNT_OUT_OF_RANGE',
    'out-of-range amount -> 400 REMITTANCE_AMOUNT_OUT_OF_RANGE', JSON.stringify(qRange.data));

  // ---------- 4. Beneficiary registry + routing fields ----------
  await section('Beneficiary routing (country/currency/payout)');
  const ben = await api('POST', '/api/banking/beneficiaries', sTok,
    { phone: `25561${sfx}`, name: 'RJ Recipient', nickname: 'R', country_code: 'KE', currency_code: 'KES', payout_method: 'WALLET' });
  await expect(ben.status === 200 && ben.data.beneficiary.country_code === 'KE'
    && ben.data.beneficiary.currency_code === 'KES' && ben.data.beneficiary.payout_method === 'WALLET',
    'beneficiary saved with country/currency/payout fields', JSON.stringify(ben.data.beneficiary));
  const benId = ben.data.beneficiary.id;

  const boS = await api('POST', '/api/network/remittance/send', sTok, { beneficiary_id: 999999, from_amount: 10000 });
  await expect(boS.status === 404 && boS.data.code === 'REMITTANCE_BENEFICIARY_NOT_FOUND',
    'foreign beneficiary -> 404 REMITTANCE_BENEFICIARY_NOT_FOUND', JSON.stringify(boS.data));

  const benUpd = await api('PUT', `/api/banking/beneficiaries/${benId}`, sTok,
    { country_code: 'UG', payout_method: 'WALLET' });
  await expect(benUpd.status === 200 && benUpd.data.beneficiary.country_code === 'UG'
    && benUpd.data.beneficiary.payout_method === 'WALLET',
    'beneficiary routing editable via PUT', JSON.stringify(benUpd.data.beneficiary));
  const benUpd2 = await api('PUT', `/api/banking/beneficiaries/${benId}`, sTok, { country_code: 'KE' });
  await expect(benUpd2.status === 200 && benUpd2.data.beneficiary.country_code === 'KE',
    'beneficiary country restored to KE');

  // ---------- 5. Quote + beneficiary driven send ----------
  await section('Quote+beneficiary send (rate-lock consumed)');
  const balBeforeSend = await walletOf(sId);
  const x1 = await api('POST', '/api/network/remittance/send', sTok,
    { quote_id: Q.quote_id, beneficiary_id: benId, from_amount: 10000 });
  await expect(x1.status === 200 && x1.data.success && x1.data.result.reference.indexOf('RM-') === 0
    && x1.data.result.quote_id === Q.quote_id && x1.data.result.pickup_code
    && x1.data.result.payout_method === 'WALLET' && x1.data.result.expires_at,
    'send consumes quote + beneficiary (WALLET routing)', `status=${x1.status} ${JSON.stringify(x1.data)}`);
  const refX1 = x1.data.result.reference;
  await expect((await walletOf(sId)) === balBeforeSend - 10250,
    'sender wallet debited principal + fee (10,000 + 250)',
    `before=${balBeforeSend} after=${await walletOf(sId)}`);
  await expect((await ledgerTotal('MNO_CLEARING', 'CR', `${refX1}:AMT`)) === 10000
    && (await ledgerTotal('PLATFORM_FEES', 'CR', `${refX1}:FEE`)) === 250,
    'ledger posted DR wallet = CR MNO_CLEARING (10,000) + CR PLATFORM_FEES (250)');
  const qList2 = await api('GET', '/api/network/remittance/quotes', sTok);
  await expect(qList2.data.quotes.every((x) => x.id !== Q.quote_id),
    'used quote removed from ACTIVE quote list');
  const qReuse = await api('POST', '/api/network/remittance/send', sTok,
    { quote_id: Q.quote_id, recipient_phone: '254710000099', recipient_name: 'Reuse Guy', recipient_country: 'KE', from_amount: 10000 });
  await expect(qReuse.status === 400 && qReuse.data.code === 'REMITTANCE_QUOTE_USED',
    'reusing a used quote -> 400 REMITTANCE_QUOTE_USED', JSON.stringify(qReuse.data));

  const qExp = await api('POST', '/api/network/remittance/quote', sTok, { to_country: 'KE', from_amount: 6000 });
  await pool.query(`UPDATE remittance_quotes SET expires_at = NOW() - interval '30 seconds' WHERE id = $1`, [qExp.data.result.quote_id]);
  const qExpSend = await api('POST', '/api/network/remittance/send', sTok,
    { quote_id: qExp.data.result.quote_id, recipient_phone: '254710000098', recipient_name: 'Exp Guy', from_amount: 6000 });
  await expect(qExpSend.status === 400 && qExpSend.data.code === 'REMITTANCE_QUOTE_EXPIRED',
    'expired quote -> 400 REMITTANCE_QUOTE_EXPIRED', JSON.stringify(qExpSend.data));

  const qMismatch = await api('POST', '/api/network/remittance/quote', sTok, { to_country: 'KE', from_amount: 7000 });
  const qMisSend = await api('POST', '/api/network/remittance/send', sTok,
    { quote_id: qMismatch.data.result.quote_id, recipient_phone: '254710000097', recipient_name: 'Mis Guy', from_amount: 99999 });
  await expect(qMisSend.status === 400 && qMisSend.data.code === 'REMITTANCE_AMOUNT_INVALID',
    'amount mismatch vs locked quote -> 400 REMITTANCE_AMOUNT_INVALID', JSON.stringify(qMisSend.data));

  // ---------- 6. Legacy send + MNO simulated rail ----------
  await section('Legacy send (no quote) + MNO simulated pickup');
  const leg = await api('POST', '/api/network/remittance/send', sTok,
    { recipient_phone: '254710000000', recipient_name: 'Legacy RM', recipient_country: 'KE', from_amount: 15000 });
  await expect(leg.status === 200 && leg.data.result.payout_method === 'MNO',
    'legacy send defaults to MNO payout routing', `status=${leg.status}`);
  const refLeg = leg.data.result.reference;
  const pk1 = leg.data.result.pickup_code;

  const pickLeg = await api('POST', '/api/network/remittance/pickup', null,
    { pickup_code: pk1, recipient_phone: '254710000000', recipient_name: 'Legacy RM' });
  await expect(pickLeg.status === 200 && pickLeg.data.result.status === 'PICKED_UP'
    && pickLeg.data.result.payout_method === 'MNO'
    && pickLeg.data.result.payout.provider === 'SIMULATED_MNO'
    && pickLeg.data.result.payout.status === 'PROCESSED',
    'MNO payout processed via simulated adapter (PICKED_UP)',
    `status=${pickLeg.status} ${JSON.stringify(pickLeg.data)}`);

  const pBadName = await api('POST', '/api/network/remittance/pickup', null,
    { pickup_code: pk1, recipient_phone: '254710000000', recipient_name: 'Wrong Guy' });
  await expect(pBadName.status === 400, 'pickup with wrong name -> 400');
  const pUnknown = await api('POST', '/api/network/remittance/pickup', null,
    { pickup_code: 'ZZZZZZ', recipient_phone: '254710000000', recipient_name: 'Legacy RM' });
  await expect(pUnknown.status === 404 && pUnknown.data.code === 'REMITTANCE_TRANSFER_NOT_FOUND',
    'unknown pickup code -> 404 REMITTANCE_TRANSFER_NOT_FOUND', JSON.stringify(pUnknown.data));
  const pDup = await api('POST', '/api/network/remittance/pickup', null,
    { pickup_code: pk1, recipient_phone: '254710000000', recipient_name: 'Legacy RM' });
  await expect(pDup.status === 400 && pDup.data.code === 'REMITTANCE_ALREADY_PICKED_UP',
    'double pickup -> 400 REMITTANCE_ALREADY_PICKED_UP', JSON.stringify(pDup.data));

  // ---------- 7. WALLET payout adapter ----------
  await section('WALLET payout adapter (real credit to platform member)');
  const rBalBefore = await walletOf(rId);
  const w1 = await api('POST', '/api/network/remittance/send', sTok, { beneficiary_id: benId, from_amount: 10000 });
  await expect(w1.status === 200 && w1.data.result.payout_method === 'WALLET',
    'beneficiary send routes to WALLET payout', `status=${w1.status}`);
  const refW1 = w1.data.result.reference;
  const pickW = await api('POST', '/api/network/remittance/pickup', null,
    { pickup_code: w1.data.result.pickup_code, recipient_phone: `25561${sfx}`, recipient_name: 'RJ Recipient' });
  await expect(pickW.status === 200 && pickW.data.result.payout.provider === 'PLATFORM_WALLET'
    && pickW.data.result.payout.status === 'PROCESSED' && Number(pickW.data.result.amount) === 409.5,
    'WALLET payout processed with real credit (PLATFORM_WALLET)',
    `status=${pickW.status} ${JSON.stringify(pickW.data)}`);
  await expect((await walletOf(rId)) === rBalBefore + 409.5,
    'recipient platform wallet credited 409.5 (TZS->KES rate applied)',
    `before=${rBalBefore} after=${await walletOf(rId)}`);
  const w1Txn = await pool.query(`SELECT * FROM transactions WHERE reference_id = $1 AND type = 'REMITTANCE_PAYOUT'`, [`${refW1}:PAYOUT`]);
  await expect(w1Txn.rows.length === 1 && Number(w1Txn.rows[0].wallet_amount) === 409.5,
    'recipient journaled a REMITTANCE_PAYOUT transaction');

  const ext = await api('POST', '/api/network/remittance/send', sTok,
    { recipient_phone: '255999000001', recipient_name: 'External X', recipient_country: 'KE', from_amount: 20000, payout_method: 'WALLET' });
  const pickExt = await api('POST', '/api/network/remittance/pickup', null,
    { pickup_code: ext.data.result.pickup_code, recipient_phone: '255999000001', recipient_name: 'External X' });
  await expect(pickExt.status === 200 && pickExt.data.result.payout.provider === 'SIMULATED_EXTERNAL'
    && pickExt.data.result.payout.status === 'PROCESSED',
    'WALLET payout to non-member falls back to simulated external rail',
    `status=${pickExt.status} ${JSON.stringify(pickExt.data)}`);

  // ---------- 8. Cancel + refund ----------
  await section('Sender cancel + full refund');
  const cBalBefore = await walletOf(sId);
  const c1 = await api('POST', '/api/network/remittance/send', sTok,
    { recipient_phone: '254710000001', recipient_name: 'Cancel Me', recipient_country: 'KE', from_amount: 11000 });
  const refC = c1.data.result.reference;
  const cn = await api('POST', `/api/network/remittance/${refC}/cancel`, sTok);
  await expect(cn.status === 200 && cn.data.result.status === 'CANCELLED'
    && Number(cn.data.result.refunded_amount) === 11275 && cn.data.result.refund_reference,
    'pending transfer cancelled with full refund (11,000 + 275 fee)',
    `status=${cn.status} ${JSON.stringify(cn.data)}`);
  await expect((await walletOf(sId)) === cBalBefore,
    'cancelled sender wallet fully restored', `before=${cBalBefore} after=${await walletOf(sId)}`);
  const cn2 = await api('POST', `/api/network/remittance/${refC}/cancel`, sTok);
  await expect(cn2.status === 400 && cn2.data.code === 'REMITTANCE_TRANSFER_STATE',
    'double cancel -> 400 REMITTANCE_TRANSFER_STATE', JSON.stringify(cn2.data));
  const cn3 = await api('POST', `/api/network/remittance/${refC}/cancel`, mTok);
  await expect(cn3.status === 404 && cn3.data.code === 'REMITTANCE_TRANSFER_NOT_FOUND',
    'member cancelling another sender transfer -> 404 REMITTANCE_TRANSFER_NOT_FOUND', JSON.stringify(cn3.data));
  const cn4 = await api('POST', '/api/network/remittance/RM-DOESNOTEXIST/cancel', sTok);
  await expect(cn4.status === 404 && cn4.data.code === 'REMITTANCE_TRANSFER_NOT_FOUND',
    'bogus reference cancel -> 404 REMITTANCE_TRANSFER_NOT_FOUND', JSON.stringify(cn4.data));

  // ---------- 9. 24h expiry (lazy + admin) ----------
  await section('24-hour expiry + refund');
  const eBalBefore = await walletOf(sId);
  const e1 = await api('POST', '/api/network/remittance/send', sTok,
    { recipient_phone: '254710000002', recipient_name: 'Expire Me', recipient_country: 'KE', from_amount: 12000 });
  const refE = e1.data.result.reference;
  await pool.query(`UPDATE remittance_transfers SET expires_at = NOW() - interval '1 minute' WHERE reference = $1`, [refE]);
  const hist = await api('GET', '/api/network/remittance/history', sTok);
  const histRow = hist.data.transfers.find((t) => t.reference === refE);
  await expect(hist.status === 200 && histRow && histRow.status === 'EXPIRED' && histRow.refund_reference,
    'history GET auto-expires stale PENDING transfer (status EXPIRED + refund ref)', JSON.stringify(histRow));
  await expect((await walletOf(sId)) === eBalBefore,
    'expired sender wallet fully restored (principal + fee)');
  const refundTxn = await pool.query(`SELECT * FROM transactions WHERE type = 'REMITTANCE_REFUND' AND meta->>'cause' = 'expired' AND meta->>'original_reference' = $1`, [refE]);
  await expect(refundTxn.rows.length === 1 && Number(refundTxn.rows[0].wallet_amount) === 12300,
    'expiry posts REMITTANCE_REFUND transaction (12,300 reversal)', JSON.stringify(refundTxn.rows[0]));

  const pExp = await api('POST', '/api/network/remittance/pickup', null,
    { pickup_code: e1.data.result.pickup_code, recipient_phone: '254710000002', recipient_name: 'Expire Me' });
  await expect(pExp.status === 400 && pExp.data.code === 'REMITTANCE_TRANSFER_STATE',
    'picking up an already-expired transfer -> 400 REMITTANCE_TRANSFER_STATE', JSON.stringify(pExp.data));

  const hBalBefore = await walletOf(sId);
  const h1 = await api('POST', '/api/network/remittance/send', sTok,
    { recipient_phone: '254710000003', recipient_name: 'Admin Expire', recipient_country: 'KE', from_amount: 13000 });
  const refH = h1.data.result.reference;
  await pool.query(`UPDATE remittance_transfers SET expires_at = NOW() - interval '1 minute' WHERE reference = $1`, [refH]);
  const eMem = await api('POST', '/api/network/remittance/expire', mTok);
  await expect(eMem.status === 403, 'member force-expire -> 403');
  const eAdm = await api('POST', '/api/network/remittance/expire', aTok);
  await expect(eAdm.status === 200 && Number(eAdm.data.expired) >= 1,
    'admin force-expire sweeps stale PENDING', `status=${eAdm.status} ${JSON.stringify(eAdm.data)}`);
  await expect((await walletOf(sId)) === hBalBefore,
    'admin-expired sender wallet restored', `before=${hBalBefore} after=${await walletOf(sId)}`);

  // ---------- 10. Webhook events ----------
  await section('Webhook events (remittance.*)');
  await expect((await deliveryCount('remittance.sent')) >= 1, 'remittance.sent delivery recorded');
  await expect((await deliveryCount('remittance.picked_up')) >= 1, 'remittance.picked_up delivery recorded');
  await expect((await deliveryCount('remittance.cancelled')) >= 1, 'remittance.cancelled delivery recorded');
  await expect((await deliveryCount('remittance.expired')) >= 1, 'remittance.expired delivery recorded');
  const whFail = await pool.query('SELECT failure_count FROM webhook_subscriptions WHERE id = $1', [wh.data.webhook.id]);
  await expect(Number(whFail.rows[0].failure_count) >= 1, 'webhook failure accounting incremented');

  // ---------- 11. Enriched history ----------
  await section('Enriched history (quote/beneficiary/payout join)');
  const finalHist = await api('GET', '/api/network/remittance/history', sTok);
  const x1Row = finalHist.data.transfers.find((t) => t.reference === refX1);
  await expect(x1Row && x1Row.quote_reference && x1Row.beneficiary_name === 'RJ Recipient'
    && x1Row.beneficiary_country_code === 'KE',
    'history rows carry quote reference + beneficiary name/country', JSON.stringify(x1Row));

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed) { console.log('FAILED CHECKS:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });