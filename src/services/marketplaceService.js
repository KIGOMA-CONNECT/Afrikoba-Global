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

// Financing governance (mirrors the credit/eligibility rules used for loans).
const FINANCING_ANNUAL_RATE = 0.15;      // nominal flat annual financing fee
const FINANCING_MIN_SCORE = 400;         // passport minimum for installment financing
const FINANCING_MAX_TERM = 24;           // months
const FINANCING_DISPOSABLE_CAP = 0.5;    // installment must be <= 50% of disposable capacity

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
      `INSERT INTO marketplace_orders (reference, buyer_user_id, seller_user_id, listing_id, category, title, unit_price, quantity, total_amount, escrow_held_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
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

/** Buyer confirms delivery -> settle escrow (and financed portion) to seller. */
async function confirmDelivery(buyerId, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      `SELECT * FROM marketplace_orders WHERE id=$1 AND buyer_user_id=$2 AND status='ESCROW_HELD' FOR UPDATE`, [orderId, buyerId]);
    if (!o.rows.length) throw badge('Agizo halipatikani au hali ya malipo ni isiyo sahihi.', 404);
    const order = o.rows[0];
    const escrowAmt = Number(order.escrow_held_amount || order.total_amount);

    // 1) settle the held escrow to the seller.
    const cfmRef = `${order.reference}:CFM`;
    if (escrowAmt > 0) {
      await fin.creditWallet({ client, userId: order.seller_user_id, amount: escrowAmt, reference: cfmRef, fromAccount: 'MARKETPLACE_ESCROW', description: `Marketplace settlement for order ${order.reference}` });
    }

    // 2) if financed, front the financed portion to the seller (books a receivable).
    let financing = null;
    const finRow = await client.query(
      `SELECT * FROM marketplace_financing WHERE order_id=$1 AND status='ACTIVE' FOR UPDATE`, [orderId]);
    if (finRow.rows.length) {
      financing = finRow.rows[0];
      const finAmt = Number(financing.financed_amount);
      if (finAmt > 0) {
        await fin.creditWallet({ client, userId: order.seller_user_id, amount: finAmt, reference: `${order.reference}:FND`, fromAccount: 'MARKETPLACE_FINANCING', description: `Marketplace financing fronted for order ${order.reference}` });
      }
      await client.query(
        `UPDATE marketplace_financing SET disbursed_at=NOW(), updated_at=NOW() WHERE id=$1`, [financing.id]);
    }

    await client.query(
      `UPDATE marketplace_orders SET escrow_held_amount=0, status='CONFIRMED', escrow_release_ref=$1, escrow_released_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [finRow.rows.length ? `${order.reference}:FND` : cfmRef, orderId]
    );
    const settlement = Number(escrowAmt) + (financing ? Number(financing.financed_amount) : 0);
    await logTx(client, order.seller_user_id, settlement, 'TRANSFER', { feature: 'marketplace_settlement', order_id: orderId, reference: order.reference, financed: !!financing });
    await client.query('COMMIT');
    await logAction(buyerId, 'MARKETPLACE_ORDER_CONFIRMED', 'MARKETPLACE_ORDER', orderId, `Settled ${settlement} to seller (${financing ? 'financed' : 'cash'})`);
    return { success: true, order_id: orderId, settled_to: order.seller_user_id, amount: settlement, financed: !!financing };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** Cancel an untouched escrowed order -> refund the held amount to buyer. */
async function cancelOrder(buyerId, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      `SELECT * FROM marketplace_orders WHERE id=$1 AND buyer_user_id=$2 AND status='ESCROW_HELD' FOR UPDATE`, [orderId, buyerId]);
    if (!o.rows.length) throw badge('Agizo haliwezi kufutwa (halipo, si lako, ama limetoka escrow).', 404);
    const order = o.rows[0];
    const held = Number(order.escrow_held_amount || order.total_amount);
    const refundRef = `${order.reference}:REF`;
    if (held > 0) {
      await fin.creditWallet({ client, userId: buyerId, amount: held, reference: refundRef, fromAccount: 'MARKETPLACE_ESCROW', description: `Marketplace refund for order ${order.reference}` });
    }
    // A financed order cancelled before confirm never disbursed -> void the agreement.
    await client.query(
      `UPDATE marketplace_financing SET status='CANCELLED', updated_at=NOW()
        WHERE order_id=$1 AND disbursed_at IS NULL`, [orderId]
    );
    await client.query(
      `UPDATE marketplace_orders SET escrow_held_amount=0, status='CANCELLED', escrow_release_ref=$1, escrow_released_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [refundRef, orderId]
    );
    await logTx(client, buyerId, held, 'TRANSFER', { feature: 'marketplace_refund', order_id: orderId, reference: order.reference });
    await client.query('COMMIT');
    await logAction(buyerId, 'MARKETPLACE_ORDER_CANCELLED', 'MARKETPLACE_ORDER', orderId, `Refunded ${held}`);
    return { success: true, order_id: orderId, refunded: held };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ====================================================================
// FINANCING (buy now, repay in installments)
// ====================================================================

/**
 * Buy a listing with a down payment; the remainder is financed over N months.
 * Only the down payment is held in escrow; at confirm the seller is paid in
 * full (escrow + financed portion fronted onto a receivable). The buyer repays
 * principal (-> MARKETPLACE_FINANCING) and financing fee (-> FINANCE_INCOME)
 * through payFinancingInstallment.
 */
async function buyListingFinanced(buyerId, listingId, qty, opts = {}) {
  const term = parseInt(opts.term_months, 10);
  const down = Math.max(0, Number(opts.down_payment ?? 0));
  if (!term || term < 1 || term > FINANCING_MAX_TERM) throw badge(`Muda wa malipo lazima uwe kati ya mwezi 1 na ${FINANCING_MAX_TERM}.`, 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const l = await client.query(
      `SELECT * FROM marketplace_listings WHERE id=$1 AND status='ACTIVE' FOR UPDATE`, [listingId]);
    if (!l.rows.length) throw badge('Uzoswa haulipo au haupatikani.', 404);
    const listing = l.rows[0];

    const buyer = await client.query(`SELECT id FROM users WHERE id=$1`, [buyerId]);
    if (!buyer.rows.length) throw badge('Mtumiaji hapatikani.', 404);
    if (buyerId === listing.seller_user_id) throw badge('Huwezi kununua uzoswa wako mwenyewe.', 400);

    const q = parseInt(qty, 10);
    if (!q || q < 1) throw badge('Idadi lazima iwe angalau 1.', 400);
    if (q > Number(listing.stock_quantity)) throw badge(`Hisia hazitoshi (zimesalia ${listing.stock_quantity}).`, 409);

    const unit = Number(listing.unit_price);
    const total = round2(unit * q);
    if (down > total) throw badge('Malipo ya awali hayawezi kuzidi jumla ya bei.', 400);
    const financed = round2(total - down);

    // Governance: passport-gated installment capacity.
    const feeTotal = round2(financed * FINANCING_ANNUAL_RATE * (term / 12));
    const monthly = round2((financed + feeTotal) / term);
    let govern = { eligible: true, factors: [] };
    try {
      const p = await getPassport(buyerId);
      const score = Number(p.afrikobaScore ?? 0);
      const disposable = Number(p.capacity?.disposable ?? 0);
      if (score < FINANCING_MIN_SCORE) govern.factors.push(`Score ${score} below ${FINANCING_MIN_SCORE} required`);
      if (monthly > disposable * FINANCING_DISPOSABLE_CAP) govern.factors.push(`Installment ${formatMoney(monthly)} exceeds 50% of disposable (${formatMoney(disposable)})`);
      if (govern.factors.length) {
        govern.eligible = false;
        const blockedWithDown = down >= total; // cash order with down=total is effectively full prepay
        if (!blockedWithDown) throw badge(`Ufadhili umekataliwa na Afrikoba ID: ${govern.factors.join('; ')}.`, 403);
      }
    } catch (e) {
      if (e.statusCode && e.statusCode !== 200) throw e;
      govern = { eligible: false, factors: ['No financial profile yet; full prepayment required'], soft: true };
    }

    // If governance fails and down < total we already threw. Otherwise this is
    // a cash-prepay order wearing a financed container, so make it behave like one.
    if (!govern.eligible && down < total) throw badge(`Ufadhili umekataliwa: ${govern.factors.join('; ')}.`, 403);

    const ref = `MKTORD:${generateReference()}`;
    if (down > 0) {
      await fin.debitWallet({ client, userId: buyerId, amount: down, reference: ref, toAccount: 'MARKETPLACE_ESCROW', description: `Marketplace down payment for ${listing.title}` });
    }

    const order = await client.query(
      `INSERT INTO marketplace_orders (reference, buyer_user_id, seller_user_id, listing_id, category, title, unit_price, quantity, total_amount, escrow_held_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ref, buyerId, listing.seller_user_id, listing.id, listing.category, listing.title, unit, q, total, down]
    );

    const finAgree = await client.query(
      `INSERT INTO marketplace_financing (order_id, buyer_user_id, financed_amount, fee_total, term_months, monthly_installment, next_due_date)
       VALUES ($1,$2,$3,$4,$5,$6, NOW()::date + ($5 || ' months')::interval)
       RETURNING *`,
      [order.rows[0].id, buyerId, financed, feeTotal, term, monthly]
    );

    await client.query(
      `UPDATE marketplace_listings SET stock_quantity = stock_quantity - $1, updated_at=NOW() WHERE id=$2`, [q, listingId]);
    await logTx(client, buyerId, down, 'TRANSFER', { feature: 'marketplace_purchase', order_id: order.rows[0].id, reference: ref, financed: true, term, down_payment: down });
    await client.query('COMMIT');
    await logAction(buyerId, 'MARKETPLACE_ORDER_CREATED_FINANCED', 'MARKETPLACE_ORDER', order.rows[0].id, `Financed order ${order.rows[0].reference}: ${financed} over ${term} months`);
    logger.info('MARKETPLACE_FIN', `Order #${order.rows[0].id} financed ${financed}/${total} over ${term} mo (fee ${feeTotal})`);
    return {
      order: order.rows[0],
      financing: { ...finAgree.rows[0], monthly_breakdown: { principal: round2(financed / term), fee: round2(feeTotal / term) } },
      governance: { eligible: true, score_gate: FINANCING_MIN_SCORE, disposable_cap: FINANCING_DISPOSABLE_CAP, fee_rate_annual: FINANCING_ANNUAL_RATE },
      total_to_repay: round2(financed + feeTotal),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** Pay one due installment: debits principal + fee share from the buyer wallet. */
async function payFinancingInstallment(buyerId, financingId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const f = await client.query(
      `SELECT * FROM marketplace_financing WHERE id=$1 AND buyer_user_id=$2 AND status='ACTIVE' FOR UPDATE`, [financingId, buyerId]);
    if (!f.rows.length) throw badge('Mkataba wa ufadhili haulipo au si wako.', 404);
    const finAg = f.rows[0];

    const financed = Number(finAg.financed_amount);
    const feeTotal = Number(finAg.fee_total);
    const term = Number(finAg.term_months);
    const paid = Number(finAg.paid_amount);
    const total = financed + feeTotal;
    const remaining = round2(total - paid);
    if (remaining <= 0) throw badge('Mkataba huu tayari umelipwa kabisa.', 409);

    const principalShare = round2(financed / term);
    const feeShare = round2(feeTotal / term);
    let pPart = Math.min(principalShare, remaining);
    let fPart = Math.min(feeShare, Math.max(0, remaining - pPart));
    if (pPart + fPart < remaining) { pPart = round2(remaining - fPart); } // last payment clears remainder

    const instRef = `MKTFIN:${generateReference()}`;
    if (pPart > 0) {
      await fin.debitWallet({ client, userId: buyerId, amount: pPart, reference: `${instRef}:P`, toAccount: 'MARKETPLACE_FINANCING', description: `Marketplace financing principal payment` });
    }
    if (fPart > 0) {
      await fin.debitWallet({ client, userId: buyerId, amount: fPart, reference: `${instRef}:F`, toAccount: 'FINANCE_INCOME', description: `Marketplace financing fee payment` });
    }

    const newPaid = round2(paid + pPart + fPart);
    const done = newPaid >= total - 0.009;
    await client.query(
      `UPDATE marketplace_financing
          SET paid_amount=$1,
              principal_paid=principal_paid + $2,
              fee_paid=fee_paid + $3,
              next_due_date=CASE WHEN $4 THEN next_due_date ELSE next_due_date + INTERVAL '1 month' END,
              status=CASE WHEN $4 THEN 'PAID' ELSE 'ACTIVE' END,
              updated_at=NOW()
        WHERE id=$5`,
      [newPaid, pPart, fPart, done, finAg.id]
    );
    await logTx(client, buyerId, round2(pPart + fPart), 'TRANSFER', { feature: 'marketplace_financing_payment', financing_id: finAg.id, order_id: finAg.order_id, principal: pPart, fee: fPart, installment: 1 });
    await client.query('COMMIT');
    await logAction(buyerId, 'MARKETPLACE_FINANCING_PAID', 'MARKETPLACE_FINANCING', finAg.id, `Installment ${formatMoney(pPart + fPart)} (principal ${formatMoney(pPart)} + fee ${formatMoney(fPart)})`);
    return { success: true, financing_id: finAg.id, paid_this: round2(pPart + fPart), principal: pPart, fee: fPart, total_paid: newPaid, status: done ? 'PAID' : 'ACTIVE', next_due_date: done ? null : finAg.next_due_date };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** List a buyer's financing agreements (with linked order info). */
async function listFinancings(buyerId) {
  const res = await pool.query(
    `SELECT mf.*, o.reference AS order_reference, o.title AS item
       FROM marketplace_financing mf JOIN marketplace_orders o ON o.id = mf.order_id
      WHERE mf.buyer_user_id=$1 ORDER BY mf.created_at DESC LIMIT 100`, [buyerId]);
  return res.rows;
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
  buyListingFinanced, payFinancingInstallment, listFinancings,
};