/**
 * Commerce / Procurement / Supplier Network (Phase 9)
 *
 * Layers procurement (RFQs + bids + award) and supplier working-capital
 * financing onto the existing marketplace/escrow foundation. Financing flows
 * through the financial engine and is idempotent on a unique reference.
 */

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
const fin = require('./financialEngine');
const { logAudit } = require('./auditService');

class ValidityError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

async function getSupplierForOwner(userId, supplierId, client = pool) {
  const r = await client.query('SELECT * FROM suppliers WHERE id = $1', [supplierId]);
  if (r.rows.length === 0) throw new ValidityError('Msambazaji hapatikani.', 404);
  if (r.rows[0].owner_user_id !== userId) throw new ValidityError('Huna ruhusa za msambazaji huyu.', 403);
  return r.rows[0];
}

// ----------------------------------------------------------------------------
// SUPPLIERS
// ----------------------------------------------------------------------------

async function registerSupplier(userId, { business_name, category, description }) {
  if (!business_name) throw new ValidityError('Jina la biashara linahitajika.');
  const r = await pool.query(
    `INSERT INTO suppliers (owner_user_id, business_name, category, description)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, business_name, category, description]
  );
  await logAudit({ eventType: 'SUPPLIER_REGISTER', action: 'CREATE', entityType: 'SUPPLIER', userId, entityId: r.rows[0].id });
  return r.rows[0];
}

async function listSuppliers() {
  const r = await pool.query(
    'SELECT s.*, u.full_name FROM suppliers s JOIN users u ON u.id = s.owner_user_id ORDER BY s.verified DESC, s.rating DESC'
  );
  return r.rows;
}

// ----------------------------------------------------------------------------
// PROCUREMENT REQUESTS (RFQ)
// ----------------------------------------------------------------------------

async function createRequest(userId, data) {
  for (const f of ['title']) {
    if (!data[f]) throw new ValidityError(`Sehemu '${f}' inahitajika.`);
  }
  const r = await pool.query(
    `INSERT INTO procurement_requests (buyer_user_id, title, description, category, quantity, budget_cap, deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, data.title, data.description, data.category, data.quantity, data.budget_cap, data.deadline]
  );
  return r.rows[0];
}

async function publishRequest(userId, requestId) {
  const r = await pool.query(
    `UPDATE procurement_requests SET status = 'OPEN' WHERE id = $1 AND buyer_user_id = $2 RETURNING *`,
    [requestId, userId]
  );
  if (r.rows.length === 0) throw new ValidityError('Ombi halipatikani au huna ruhusa.', 404);
  return r.rows[0];
}

async function listRequests({ status, mine } = {}, userId) {
  if (mine) {
    const r = await pool.query(
      `SELECT * FROM procurement_requests WHERE buyer_user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return r.rows;
  }
  const r = await pool.query(
    `SELECT * FROM procurement_requests WHERE ($1::varchar IS NULL OR status = $1) ORDER BY created_at DESC`,
    [status || null]
  );
  return r.rows;
}

async function getRequest(requestId) {
  const reqRes = await pool.query('SELECT * FROM procurement_requests WHERE id = $1', [requestId]);
  if (reqRes.rows.length === 0) throw new ValidityError('Ombi halipatikani.', 404);
  const bids = await pool.query(
    `SELECT b.*, s.business_name, s.category AS supplier_category, u.full_name AS supplier_name
     FROM procurement_bids b
     JOIN suppliers s ON s.id = b.supplier_id
     JOIN users u ON u.id = s.owner_user_id
     WHERE b.request_id = $1 ORDER BY b.amount ASC`,
    [requestId]
  );
  return { request: reqRes.rows[0], bids: bids.rows };
}

// ----------------------------------------------------------------------------
// BIDS & AWARD
// ----------------------------------------------------------------------------

async function submitBid(userId, requestId, { amount, delivery_days, note }) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
  const supplier = await pool.query('SELECT * FROM suppliers WHERE owner_user_id = $1 LIMIT 1', [userId]);
  if (supplier.rows.length === 0) throw new ValidityError('Tengeneza wasifu wa msambazaji kwanza.');
  const reqRes = await pool.query('SELECT * FROM procurement_requests WHERE id = $1', [requestId]);
  if (reqRes.rows.length === 0) throw new ValidityError('Ombi halipatikani.', 404);
  const req = reqRes.rows[0];
  if (!['OPEN', 'ACCEPTING_BIDS'].includes(req.status)) throw new ValidityError('Ombi halikubali zabuni kwa sasa.');

  const existing = await pool.query(
    'SELECT id FROM procurement_bids WHERE request_id = $1 AND supplier_id = $2',
    [requestId, supplier.rows[0].id]
  );
  if (existing.rows.length > 0) throw new ValidityError('Umeshatuma zabuni kwa ombi hili.');

  const r = await pool.query(
    `INSERT INTO procurement_bids (request_id, supplier_id, amount, delivery_days, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [requestId, supplier.rows[0].id, amt, delivery_days, note]
  );
  await pool.query(`UPDATE procurement_requests SET status = 'ACCEPTING_BIDS' WHERE id = $1`, [requestId]);
  await logAudit({ eventType: 'PROC_BID', action: 'CREATE', entityType: 'PROCUREMENT_BID', userId, entityId: r.rows[0].id, amount: amt });
  return r.rows[0];
}

async function awardRequest(userId, requestId, bidId) {
  const reqRes = await pool.query(
    `UPDATE procurement_requests SET status = 'AWARDED', selected_bid_id = $2
     WHERE id = $1 AND buyer_user_id = $3 RETURNING *`,
    [requestId, bidId, userId]
  );
  if (reqRes.rows.length === 0) throw new ValidityError('Ombi halipatikani au huna ruhusa.', 404);
  await pool.query(
    `UPDATE procurement_bids SET status = CASE WHEN id = $1 THEN 'ACCEPTED' ELSE 'REJECTED' END
     WHERE request_id = $2`,
    [bidId, requestId]
  );
  await logAudit({ eventType: 'PROC_AWARD', action: 'AWARD', entityType: 'PROCUREMENT_BID', userId, entityId: bidId });
  return reqRes.rows[0];
}

// ----------------------------------------------------------------------------
// SUPPLIER FINANCING (working-capital advance)
// ----------------------------------------------------------------------------

async function createSupplierFinancing(userId, supplierId, { request_id, amount, term_months, annual_rate, unique_reference }) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
  const supplier = await getSupplierForOwner(userId, supplierId);
  const ref = unique_reference || generateReference('SFIN');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO supplier_financing (supplier_id, request_id, amount, term_months, annual_rate, unique_reference)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [supplier.id, request_id || null, amt, term_months, annual_rate || 10, ref]
    );
    await fin.creditWallet({ client, userId, amount: amt, reference: ref, fromAccount: 'SUSPENSE', description: 'Supplier working-capital advance' });
    const txRes = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SUPPLIER_FINANCING', $4)
       RETURNING id`,
      [ref, userId, amt, JSON.stringify({ supplier_id: supplier.id, unique_reference: ref })]
    );
    await client.query(
      `UPDATE supplier_financing
         SET status = 'DISBURSED', txn_id = $1
       WHERE unique_reference = $2`,
      [txRes.rows[0].id, ref]
    );
    await logAudit({ eventType: 'SUPPLIER_FINANCING', action: 'DISBURSE', entityType: 'SUPPLIER_FINANCING', userId, entityId: supplier.id, referenceId: ref, amount: amt });

    await client.query('COMMIT');
    return { success: true, financing_id: ref, amount: amt };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e.message || '').toLowerCase().includes('duplicate') || String(e.message || '').includes('unique_reference')) {
      throw new ValidityError('Ufadhili huu tayari umetolewa.', 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

async function listSupplierFinancings(userId) {
  const r = await pool.query(
    `SELECT f.*, s.business_name
     FROM supplier_financing f
     JOIN suppliers s ON s.id = f.supplier_id
     WHERE s.owner_user_id = $1 ORDER BY f.created_at DESC`,
    [userId]
  );
  return r.rows;
}

module.exports = {
  registerSupplier, listSuppliers,
  createRequest, publishRequest, listRequests, getRequest,
  submitBid, awardRequest,
  createSupplierFinancing, listSupplierFinancings,
};
