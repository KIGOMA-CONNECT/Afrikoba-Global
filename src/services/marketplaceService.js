/**
 * AFRIKOBA MARKETPLACE
 * Need -> discover -> compare -> finance -> purchase -> pay -> insure -> save
 *                                                          -> review
 *
 * Builds on existing primitives rather than reinventing the money layer:
 *   * Payments / escrow  -> financialEngine (debitWallet into MARKETPLACE_ESCROW,
 *                           creditWallet to seller on confirm / refund on cancel)
 *   * Finance / affordability -> FinancialPassport (getPassport.capacity.disposable)
 *   * Save                -> savings engine / autopilot (out of scope here)
 *   * Insure              -> insuranceService (reused by callers)
 *
 * Ledger safety: a unique reference per order; every movement journals a balanced
 * double-entry group with an idempotency claim, so retries can never double-move.
 */

const pool = require('../config/db');
const fin = require('./financialEngine');
const { getPassport } = require('./financialPassportService');
const { logAction } = require('./auditService');
const { generateReference, formatMoney } = require('../utils/helpers');
const logger = require('../utils/logger');

function badge(err, statusCode) {
  return Object.assign(new Error(err), { statusCode });
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

async function logTx(client, userId, amount, type, meta) {
  await client.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', $4, $5)`,
    [generateReference(), userId, amount, type, JSON.stringify(meta || {})]
  );
}

// ====================================================================
// LISTINGS (catalog / discover)
// ====================================================================

async function createListing(userId, data) {
  const { category, title, description, unit_price, stock_quantity, business_id } = data;
  if (!category || !title) throw badge('Kategoria na jina vinahitajika.', 400);
  const price = Number(unit_price);
  if (!price || price <= 0) throw badge('Bei si sahihi.', 400);
  const stock = Number(stock_quantity);
  if (!Number.isInteger(stock) || stock < 0) throw badge('Hisa si sahihi.', 400);
  if (business_id) {
    const b = await pool.query('SELECT id FROM business_accounts WHERE id=$1 AND owner_id=$2', [business_id, userId]);
    if (!b.rows.length) throw badge('Biashara hii haipatikani kwa mtumiaji huu.', 403);
  }
  const ref = generateReference('MKT');
  const res = await pool.query(
    `INSERT INTO marketplace_listings (reference, seller_user_id, business_id, category, title, description, unit_price, stock_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [ref, userId, business_id || null, category, title, description || null, price, stock]
  );
  await logAction(userId, 'MARKETPLACE_LISTING_CREATED', 'MARKETPLACE_LISTING', res.rows[0].id, `Listing "${title}" @ ${price}`);
  return res.rows[0];
}

async function listListings({ category, q, min, max, sort, limit } = {}) {
  const where = ["status = 'ACTIVE'"];
  const params = [];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`); }
  if (min) { params.push(Number(min)); where.push(`unit_price >= $${params.length}`); }
  if (max) { params.push(Number(max)); where.push(`unit_price <= $${params.length}`); }
  const order = sort === 'price_asc' ? 'unit_price ASC' : sort === 'price_desc' ? 'unit_price DESC' : 'created_at DESC';
  const lim = Math.min(Number(limit) || 50, 100);
  const res = await pool.query(
    `SELECT l.*, u.full_name AS seller_name,
            ROUND((SELECT AVG(r.rating)::numeric FROM marketplace_reviews r JOIN marketplace_orders o ON o.id=r.order_id
                   WHERE o.listing_id=l.id)::numeric,1) AS avg_rating
       FROM marketplace_listings l
       JOIN users u ON u.id = l.seller_user_id
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length + 1}`,
    [...params, lim]
  );
  return res.rows;
}

async function getListing(listingId) {
  const res = await pool.query(
    `SELECT l.*, u.full_name AS seller_name,
            ROUND((SELECT AVG(r.rating)::numeric FROM marketplace_reviews r JOIN marketplace_orders o ON o.id=r.order_id
                   WHERE o.listing_id=l.id)::numeric,1) AS avg_rating
       FROM marketplace_listings l JOIN users u ON u.id=l.seller_user_id
      WHERE l.id=$1`, [listingId]
  );
  if (!res.rows.length) throw badge('Bidhaa haipatikani.', 404);
  return res.rows[0];
}

// ====================================================================
// PRICE GUIDE (compare) - market-informed bands, merged with live listings
// ====================================================================

/**
 * Returns min/avg/max price band for a category + item key.
 * If live listings exist they are merged into the guide; otherwise a seeded
 * market-data band is returned so the buyer still gets a fair price reference.
 */
async function priceGuide(category, itemKey) {
  if (!category) throw badge('Kategoria inahitajika.', 400);
  let guide = null;
  if (itemKey) {
    const r = await pool.query(
      `SELECT * FROM marketplace_price_guide WHERE category=$1 AND item_key=$2`, [category, itemKey]);
    guide = r.rows[0] || null;
  }
  // Live aggregation over active listings in this category.
  const live = await pool.query(
    `SELECT COUNT(*)::int AS cnt, COALESCE(MIN(unit_price),0)::numeric AS mn,
            COALESCE(AVG(unit_price),0)::numeric AS avg, COALESCE(MAX(unit_price),0)::numeric AS mx
       FROM marketplace_listings WHERE category=$1 AND status='ACTIVE'`, [category]
  );
  const L = live.rows[0];
  if (L.cnt > 0) {
    if (guide) {
      // Merge seeded + live; prefer whichever is up to date, note source.
      const sum = [
        { p: Number(guide.min_price), n: guide.sample_count },
        { p: Number(L.mn), n: L.cnt },
      ];
      const [mnP, mxP] = [Math.min(...sum.map(s => s.p)), Math.max(...sum.map(s => s.p))];
      const totalN = guide.sample_count + L.cnt;
      const avg = (Number(guide.avg_price) * guide.sample_count + Number(L.avg) * L.cnt) / totalN;
      guide.min_price = mnP;
      guide.avg_price = round2(avg);
      guide.max_price = mxP;
      guide.sample_count = totalN;
      guide.source = 'MERGED';
    } else {
      guide = { category, item_key: itemKey || category, min_price: L.mn, avg_price: round2(Number(L.avg)), max_price: L.mx, sample_count: L.cnt, source: 'LIVE' };
    }
  }
  return {
    category,
    item_key: itemKey || null,
    live_listings: L.cnt,
    band: guide ? {
      min_price: Number(guide.min_price),
      avg_price: Number(guide.avg_price),
      max_price: Number(guide.max_price),
      sample_count: guide.sample_count,
      source: guide.source,
    } : null,
    note: guide ? null : 'No listings yet and no market data - price will be set by sellers.',
  };
}

// ====================================================================
// ORDERS (finance -> purchase -> pay/escrow)
// ====================================================================

/**
 * Buy: hold the buyer's money in MARKETPLACE_ESCROW, decrement stock, create order.
 * Affordability advisory from the Financial Passport - recorded but not a hard
 * gate for a cash purchase (the hard gate is the buyer's wallet balance).
 */
async function buyListing(buyerId, listingId, quantity) {
  const qty = parseInt(quantity, 10);
  if (!qty || qty <= 0) throw badge('Idadi si sahihi.', 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const l = await client.query(
      `SELECT * FROM marketplace_listings WHERE id=$1 AND status='ACTIVE' FOR UPDATE`, [listingId]);
    if (!l.rows.length) throw badge('Bidhaa haipatikani au haijaanzishwa.', 404);
    const listing = l.rows[0];
    if (Number(listing.stock_quantity) < qty) throw badge('Hisa haitoshi.', 400);
    if (listing.seller_user_id === buyerId) throw badge('Huwezi kununua bidhaa yako mwenyewe.', 400);

    const total = round2(Number(listing.unit_price) * qty);

    // Passport affordability advisory (not a hard gate for cash purchase).
    let affordability = null;
    try {
      const p = await getPassport(buyerId);
      const disposable = Number(p.capacity?.disposable ?? 0);
      affordability = {
        disposable,
        affordable: disposable >= total,
        reason: disposable >= total
          ? `Disposable capacity (${formatMoney(disposable)}) covers the purchase.`
          : `Purchase exceeds monthly disposable capacity (${formatMoney(disposable)}); consider financing or saving toward it.`,
        recommendedMonthly: round2(total / 6),
      };
    } catch (e) {
      affordability = { disposable: null, affordable: null, reason: 'No financial profile yet; wallet balance is the gate.', recommendedMonthly: null };
    }

    const ref = `MKTORD:${generateReference()}`;
    await fin.debitWallet({ client, userId: buyerId, amount: total, reference: ref, toAccount: 'MARKETPLACE_ESCROW', description: `Marketplace payment for ${listing.title}` });

    const order = await client.query(
      `INSERT INTO marketplace_orders (reference, buyer_user_id, seller_user_id, listing_id, category, title, unit_price, quantity, total_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [ref, buyerId, listing.seller_user_id, listing.id, listing.category, listing.title, listing.unit_price, qty, total]
    );
    await client.query(
      `UPDATE marketplace_listings SET stock_quantity = stock_quantity - $1, updated_at=NOW() WHERE id=$2`, [qty, listingId]);
    await logTx(client, buyerId, total, 'TRANSFER', { feature: 'marketplace_purchase', order_id: order.rows[0].id, reference: ref });
    await client.query('COMMIT');
    await logAction(buyerId, 'MARKETPLACE_ORDER_CREATED', 'MARKETPLACE_ORDER', order.rows[0].id, `Order ${total} for "${listing.title}"`);
    logger.info('MARKETPLACE', `Order #${order.rows[0].id} created: ${total} escrowed`);
    return { order: order.rows[0], affordability };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** List orders (buyer or seller role). */
async function listOrders(userId, opts = {}) {
  const role = opts.role === 'seller' ? 'seller_user_id' : 'buyer_user_id';
  const res = await pool.query(
    `SELECT o.*, u.full_name AS counterparty
       FROM marketplace_orders o JOIN users u ON u.id = o.${role === 'buyer_user_id' ? 'seller_user_id' : 'buyer_user_id'}
      WHERE o.${role}=$1 ORDER BY o.created_at DESC LIMIT 100`, [userId]
  );
  return res.rows;
}

/** Buyer confirms delivery -> settle escrow to seller. */
async function confirmDelivery(buyerId, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      `SELECT * FROM marketplace_orders WHERE id=$1 AND buyer_user_id=$2 AND status='ESCROW_HELD' FOR UPDATE`, [orderId, buyerId]);
    if (!o.rows.length) throw badge('Agizo halipatikani au hali ya malipo ni isiyo sahihi.', 404);
    const order = o.rows[0];
    const confirmRef = `${order.reference}:CFM`;
    await fin.creditWallet({ client, userId: order.seller_user_id, amount: Number(order.total_amount), reference: confirmRef, fromAccount: 'MARKETPLACE_ESCROW', description: `Marketplace settlement for order ${order.reference}` });
    await client.query(
      `UPDATE marketplace_orders SET status='CONFIRMED', escrow_release_ref=$1, escrow_released_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [confirmRef, orderId]
    );
    await logTx(client, order.seller_user_id, Number(order.total_amount), 'TRANSFER', { feature: 'marketplace_settlement', order_id: orderId, reference: order.reference });
    await client.query('COMMIT');
    await logAction(buyerId, 'MARKETPLACE_ORDER_CONFIRMED', 'MARKETPLACE_ORDER', orderId, `Settled ${order.total_amount} to seller`);
    return { success: true, order_id: orderId, settled_to: order.seller_user_id, amount: Number(order.total_amount) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** Cancel an untouched escrowed order -> refund buyer. */
async function cancelOrder(buyerId, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      `SELECT * FROM marketplace_orders WHERE id=$1 AND buyer_user_id=$2 AND status='ESCROW_HELD' FOR UPDATE`, [orderId, buyerId]);
    if (!o.rows.length) throw badge('Agizo haliwezi kufutwa (halipo, si lako, ama limetoka escrow).', 404);
    const order = o.rows[0];
    const refundRef = `${order.reference}:REF`;
    await fin.creditWallet({ client, userId: buyerId, amount: Number(order.total_amount), reference: refundRef, fromAccount: 'MARKETPLACE_ESCROW', description: `Marketplace refund for order ${order.reference}` });
    await client.query(
      `UPDATE marketplace_orders SET status='CANCELLED', escrow_release_ref=$1, escrow_released_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [refundRef, orderId]
    );
    await logTx(client, buyerId, Number(order.total_amount), 'TRANSFER', { feature: 'marketplace_refund', order_id: orderId, reference: order.reference });
    await client.query('COMMIT');
    await logAction(buyerId, 'MARKETPLACE_ORDER_CANCELLED', 'MARKETPLACE_ORDER', orderId, `Refunded ${order.total_amount}`);
    return { success: true, order_id: orderId, refunded: Number(order.total_amount) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ====================================================================
// REVIEWS
// ====================================================================

async function reviewOrder(buyerId, orderId, data) {
  const rating = parseInt(data?.rating, 10);
  if (!rating || rating < 1 || rating > 5) throw badge('Rating ni kati ya 1 na 5.', 400);
  const comment = data?.comment ? String(data.comment).slice(0, 500) : null;
  const o = await pool.query(
    `SELECT id, listing_id, status FROM marketplace_orders WHERE id=$1 AND buyer_user_id=$2`, [orderId, buyerId]);
  if (!o.rows.length) throw badge('Agizo halipatikani.', 404);
  if (o.rows[0].status !== 'CONFIRMED') throw badge('Unaweza kuweka ukaguzi baada ya kuthibitisha agizo.', 400);
  const res = await pool.query(
    `INSERT INTO marketplace_reviews (order_id, listing_id, buyer_user_id, rating, comment)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (order_id) DO UPDATE SET rating=EXCLUDED.rating, comment=EXCLUDED.comment, created_at=NOW()
     RETURNING *`,
    [orderId, o.rows[0].listing_id, buyerId, rating, comment]
  );
  return res.rows[0];
}

module.exports = {
  createListing, listListings, getListing, priceGuide,
  buyListing, listOrders, confirmDelivery, cancelOrder, reviewOrder,
};