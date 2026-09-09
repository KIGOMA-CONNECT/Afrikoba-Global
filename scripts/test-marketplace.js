/* ============================================================
 * AFRIKOBA GLOBAL - MARKETPLACE ESCROW (migrations 038-041)
 * End-to-end escrow money path on marketplace_orders:
 *   - buy: buyer debited -> MARKETPLACE_ESCROW, order ESCROW_HELD
 *   - evidence: seller attaches delivery evidence
 *   - confirm: escrow settled to seller (DR escrow / CR wallet)
 *   - cancel: untouched order refunds the held amount to buyer
 *   - dispute: buyer freezes escrow; ADMIN rulings move money
 *     (BUYER_REFUND / SPLIT) with balanced ledger journal
 * exercises: stock decrement, self-buy block, bad ruling 400,
 * RBAC on admin resolve (403 for buyer), escrow never duplicated.
 * ============================================================ */
const BASE = process.env.MARKETPLACE_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
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
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.user) throw new Error(`register ${phoneNumber} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}
async function fundUser(id, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, id]);
}
async function makeAdmin(regData) {
  if (!regData || !regData.user || !regData.user.id) return null;
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [regData.user.id]);
  return regData.user.id;
}

async function run() {
  const s = String(Date.now()).slice(-5);
  const suffix = `${s}${Math.floor(Math.random() * 90) + 10}`;

  await section('Setup: seller + buyer funded');
  const seller = await register(`255750${suffix}`, `MktSeller${suffix}`);
  const buyer = await register(`255751${suffix}`, `MktBuyer${suffix}`);
  await fundUser(buyer.user.id, 300000);
  const sToken = seller.token;
  const bToken = buyer.token;

  await section('Listing + buy (escrow hold)');
  const listing = await api('POST', '/api/marketplace/listings', sToken, {
    category: 'FURNITURE', title: `Sofa Set ${suffix}`, description: 'Kizuri', unit_price: 20000, stock_quantity: 5,
  });
  const listingId = listing.data.listing.id;
  await expect(Boolean(listingId), 'listing created', JSON.stringify(listing.data).slice(0, 120));

  const selfBuy = await api('POST', '/api/marketplace/orders', sToken, { listing_id: listingId, quantity: 1 });
  await expect(selfBuy.status === 400, 'self-buy blocked', String(selfBuy.status));

  const before = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [buyer.user.id])).rows[0].wallet_balance;
  const buy = await api('POST', '/api/marketplace/orders', bToken, { listing_id: listingId, quantity: 2 });
  const orderId = buy.data.order.id;
  const ref = buy.data.order.reference;
  await expect(buy.status >= 200 && buy.status < 300, 'buy 2xx', `status=${buy.status}`);
  await expect(Number(buy.data.order.total_amount) === 40000, 'total 40000', String(buy.data.order.total_amount));
  await expect(Number(buy.data.order.escrow_held_amount) === 40000, 'escrow held 40000');
  await expect(buy.data.order.status === 'ESCROW_HELD', 'order ESCROW_HELD');
  const after = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [buyer.user.id])).rows[0].wallet_balance;
  await expect(Number(before) - Number(after) === 40000, 'buyer debited 40000', `before=${before} after=${after}`);

  const stock = await pool.query('SELECT stock_quantity FROM marketplace_listings WHERE id=$1', [listingId]);
  await expect(Number(stock.rows[0].stock_quantity) === 3, 'stock decremented 5->3');

  const escrowJournal = await pool.query(
    `SELECT direction, amount FROM journal_entries WHERE reference_id=$1`, [ref]
  );
  await expect(escrowJournal.rows.length === 2, 'escrow hold journal pair (2 lines)');
  if (escrowJournal.rows.length === 2) {
    const dr = escrowJournal.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
    const cr = escrowJournal.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
    await expect(dr === cr && dr === 40000, 'hold journal DR=CR balanced at 40000', `DR=${dr} CR=${cr}`);
  }

  const buyTxn = await pool.query(
    `SELECT * FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 5`, [buyer.user.id]
  );
  await expect(buyTxn.rows.some((r) => r.status === 'SUCCESS' && Number(r.wallet_amount) === 40000 && r.meta && r.meta.feature === 'marketplace_purchase' && String(r.meta.reference) === ref),
    'escrow purchase transaction recorded (40000)');

  await section('Seller evidence + confirm settle');
  const badEvid = await api('POST', `/api/marketplace/orders/${orderId}/evidence`, bToken, { urls: [] });
  await expect(badEvid.status === 400, 'evidence requires URL (400)', String(badEvid.status));

  const evid = await api('POST', `/api/marketplace/orders/${orderId}/evidence`, sToken, { urls: ['https://img.x/sofa.jpg'], note: 'Imewekwa' });
  await expect(evid.status === 200 && evid.data.order.evidence_urls.length === 1, 'seller submits evidence');

  const sellerBefore = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [seller.user.id])).rows[0].wallet_balance;
  const confirm = await api('POST', `/api/marketplace/orders/${orderId}/confirm`, bToken, {});
  await expect(confirm.status === 200 && Number(confirm.data.amount) === 40000, 'confirm settles 40000', JSON.stringify(confirm.data).slice(0, 120));
  const sellerAfter = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [seller.user.id])).rows[0].wallet_balance;
  await expect(Number(sellerAfter) - Number(sellerBefore) === 40000, 'seller credited 40000 on settle', `before=${sellerBefore} after=${sellerAfter}`);

  const settledOrder = await pool.query(
    `SELECT status, escrow_held_amount, escrow_release_ref FROM marketplace_orders WHERE id=$1`, [orderId]
  );
  await expect(settledOrder.rows[0].status === 'CONFIRMED' && Number(settledOrder.rows[0].escrow_held_amount) === 0,
    'order CONFIRMED + escrow released to 0');

  const confirmTxn = await pool.query(
    `SELECT * FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 3`, [seller.user.id]
  );
  await expect(confirmTxn.rows.some((r) => r.status === 'SUCCESS' && Number(r.wallet_amount) === 40000 && r.meta && r.meta.feature === 'marketplace_settlement'),
    'settlement transaction recorded for seller');

  await section('Cancel refunds untouched escrow');
  const listing2 = await api('POST', '/api/marketplace/listings', sToken, {
    category: 'ELECTRONICS', title: `Radio ${suffix}`, unit_price: 5000, stock_quantity: 4,
  });
  const buy2 = await api('POST', '/api/marketplace/orders', bToken, { listing_id: listing2.data.listing.id, quantity: 1 });
  const cancel = await api('POST', `/api/marketplace/orders/${buy2.data.order.id}/cancel`, bToken, {});
  await expect(cancel.status === 200, 'cancel 200', JSON.stringify(cancel.data).slice(0, 120));
  await expect(Number(cancel.data.refunded) === 5000, 'refunded 5000');

  const cancelled = await pool.query('SELECT status, escrow_held_amount FROM marketplace_orders WHERE id=$1', [buy2.data.order.id]);
  await expect(cancelled.rows[0].status === 'CANCELLED' && Number(cancelled.rows[0].escrow_held_amount) === 0, 'order CANCELLED, escrow released');

  await section('Dispute freezes escrow + ADMIN ruling');
  const listing3 = await api('POST', '/api/marketplace/listings', sToken, {
    category: 'FURNITURE', title: `Bedd ${suffix}`, unit_price: 8000, stock_quantity: 2,
  });
  const buy3 = await api('POST', '/api/marketplace/orders', bToken, { listing_id: listing3.data.listing.id, quantity: 1 });
  const ord3 = buy3.data.order;

  const badReason = await api('POST', `/api/marketplace/orders/${ord3.id}/dispute`, bToken, { reason: 'NOPE' });
  await expect(badReason.status === 400, 'invalid dispute reason 400', String(badReason.status));

  const dispute = await api('POST', `/api/marketplace/orders/${ord3.id}/dispute`, bToken, { reason: 'NOT_DELIVERED', description: 'Hakujafika' });
  await expect(dispute.status >= 200 && dispute.status < 300 && dispute.data.dispute.status === 'OPEN', 'dispute opened', `status=${dispute.status}`);
  const disputeId = dispute.data.dispute.id;

  const confirmWhileDispute = await api('POST', `/api/marketplace/orders/${ord3.id}/confirm`, bToken, {});
  await expect(confirmWhileDispute.status === 409, 'confirm blocked while dispute open (409)', String(confirmWhileDispute.status));

  const buyerResolve = await api('POST', `/api/marketplace/disputes/${disputeId}/resolve`, bToken, { ruling: 'BUYER_REFUND' });
  await expect(buyerResolve.status === 403, 'non-admin cannot resolve (403)', String(buyerResolve.status));

  const admin = await register(`255752${suffix}`, `MktAdmin${suffix}`);
  await makeAdmin(admin);
  const adminToken = admin.token;

  const badRuling = await api('POST', `/api/marketplace/disputes/${disputeId}/resolve`, adminToken, { ruling: 'SELLER_BONUS' });
  await expect(badRuling.status === 400, 'invalid ruling 400', String(badRuling.status));

  const buyerPre = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [buyer.user.id])).rows[0].wallet_balance;
  const resolve = await api('POST', `/api/marketplace/disputes/${disputeId}/resolve`, adminToken, { ruling: 'BUYER_REFUND' });
  await expect(resolve.status === 200, 'admin resolve 200', JSON.stringify(resolve.data).slice(0, 120));
  await expect(Number(resolve.data.buyer_refund) === 8000 && Number(resolve.data.seller_payout) === 0, 'BUYER_REFUND: 8000 / 0');
  const buyerPost = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [buyer.user.id])).rows[0].wallet_balance;
  await expect(Number(buyerPost) - Number(buyerPre) === 8000, 'buyer refunded 8000', `pre=${buyerPre} post=${buyerPost}`);

  const resolved = await pool.query(`SELECT status, resolution FROM disputes WHERE id=$1`, [disputeId]);
  await expect(resolved.rows[0].status === 'RESOLVED' && String(resolved.rows[0].resolution).includes('Ruling BUYER_REFUND'), 'dispute RESOLVED with ruling');

  await section('SPLIT ruling leaves a balanced journal');
  const listing4 = await api('POST', '/api/marketplace/listings', sToken, {
    category: 'FURNITURE', title: `Table ${suffix}`, unit_price: 10000, stock_quantity: 2,
  });
  const buy4 = await api('POST', '/api/marketplace/orders', bToken, { listing_id: listing4.data.listing.id, quantity: 1 });
  const d4 = await api('POST', `/api/marketplace/orders/${buy4.data.order.id}/dispute`, bToken, { reason: 'DAMAGED' });
  const split = await api('POST', `/api/marketplace/disputes/${d4.data.dispute.id}/resolve`, adminToken, { ruling: 'SPLIT', split_buyer_percent: 50 });
  await expect(split.status === 200, 'SPLIT resolve 200', JSON.stringify(split.data).slice(0, 120));
  await expect(Number(split.data.buyer_refund) === 5000 && Number(split.data.seller_payout) === 5000, 'SPLIT 50/50 = 5000/5000');

  const journal = await pool.query(
    `SELECT direction, amount FROM journal_entries
     WHERE reference_id IN ('${buy4.data.order.reference}:DSPB','${buy4.data.order.reference}:DSPS')`
  );
  await expect(journal.rows.length === 4, 'split journal lines (2 balanced pairs)', `got ${journal.rows.length}`);
  if (journal.rows.length === 4) {
    const dr = journal.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
    const cr = journal.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
    await expect(dr === cr && dr === 10000, 'split journal DR=CR balanced (10000 total)', `DR=${dr} CR=${cr}`);
  }

  await section('RBAC');
  const unauth = await api('GET', '/api/marketplace/listings', null);
  await expect(unauth.status === 200, 'public listings reachable', String(unauth.status));

  console.log(`\nMARKETPLACE ESCROW RESULT: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('FAILED:', failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error('\nFATAL:', e && e.message ? e.message : e);
  process.exit(1);
});