/**
 * Payment Requests Service (request-to-pay)
 * A user (requester) asks another user (payer, by phone) for money.
 * The payer accepts by paying through the canonical wallet transfer path.
 */

const pool = require('../config/db');
const walletService = require('./walletService');
const { generateReference } = require('../utils/helpers');
const { logAudit } = require('./auditService');

const DEFAULT_EXPIRY_HOURS = 48;

function paymentError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Create a payment request from req (requester) to a payer (by phone).
 */
async function createRequest(requesterId, { payerPhone, amount, note, expiresInHours }) {
  const amountNum = parseFloat(amount);
  if (!amountNum || amountNum <= 0) {
    throw paymentError('Kiasi si sahihi.', 400);
  }
  if (!payerPhone || !payerPhone.trim()) {
    throw paymentError('Namba ya mlipaji inahitajika.', 400);
  }

  const phone = payerPhone.trim();
  const payerRes = await pool.query('SELECT id FROM users WHERE phone_number = $1', [phone]);
  if (payerRes.rows.length === 0) {
    throw paymentError('Mlipaji hajapatikana kwenye mfumo.', 404);
  }
  const payerId = payerRes.rows[0].id;
  if (payerId === requesterId) {
    throw paymentError('Huwezi kujitaka pesa mwenyewe.', 400);
  }

  const expiresHours = parseInt(expiresInHours, 10) || DEFAULT_EXPIRY_HOURS;
  const reference = generateReference('PRQ');

  const result = await pool.query(
    `INSERT INTO payment_requests (requester_id, payer_id, payer_phone, amount, note, reference, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' hours')::interval)
     RETURNING *`,
    [requesterId, payerId, phone, amountNum, note || null, reference, Math.max(1, Math.min(expiresHours, 168))]
  );

  await logAudit({
    eventType: 'PAYMENT_REQUEST', action: 'CREATE', entityType: 'PAYMENT_REQUEST', entityId: result.rows[0].id,
    userId: requesterId, referenceId: reference, amount: amountNum, afterData: { payer_id: payerId, payer_phone: phone },
  });

  return result.rows[0];
}

/**
 * Mark any PENDING requests that have passed their expiry as EXPIRED.
 */
async function expireStale() {
  await pool.query(
    `UPDATE payment_requests SET status = 'EXPIRED'
     WHERE status = 'PENDING' AND expires_at < NOW()`
  );
}

/**
 * Requests the user received (asked to pay) and sent (they request money).
 */
async function listRequests(userId) {
  await expireStale();
  const [incoming, outgoing] = await Promise.all([
    pool.query(
      `SELECT pr.*, u.full_name AS requester_name
       FROM payment_requests pr JOIN users u ON u.id = pr.requester_id
       WHERE pr.payer_id = $1 ORDER BY pr.created_at DESC`,
      [userId]
    ),
    pool.query(
      `SELECT pr.*, u.full_name AS payer_name
       FROM payment_requests pr JOIN users u ON u.id = pr.payer_id
       WHERE pr.requester_id = $1 ORDER BY pr.created_at DESC`,
      [userId]
    ),
  ]);
  return { incoming: incoming.rows, outgoing: outgoing.rows };
}

/**
 * Requester withdraws a PENDING request.
 */
async function cancelRequest(requesterId, requestId) {
  const result = await pool.query(
    `UPDATE payment_requests
     SET status = 'CANCELLED'
     WHERE id = $1 AND requester_id = $2 AND status = 'PENDING'
     RETURNING *`,
    [requestId, requesterId]
  );
  if (result.rows.length === 0) {
    throw paymentError('Ombi halipatikani au haliko PENDING.', 404);
  }
  await logAudit({
    eventType: 'PAYMENT_REQUEST', action: 'CANCEL', entityType: 'PAYMENT_REQUEST', entityId: result.rows[0].id,
    userId: requesterId, referenceId: result.rows[0].reference,
  });
  return result.rows[0];
}

/**
 * Payer settles a PENDING request through the canonical wallet transfer path.
 */
async function payRequest(payerId, requestId, note) {
  await expireStale();

  const reqRes = await pool.query('SELECT * FROM payment_requests WHERE id = $1 AND payer_id = $2', [requestId, payerId]);
  if (reqRes.rows.length === 0) {
    throw paymentError('Ombi halipatikani kwa mlipaji huyu.', 404);
  }
  const request = reqRes.rows[0];

  if (request.status === 'PAID') {
    return { id: request.id, status: 'PAID', transaction_reference: request.transaction_reference, amount: Number(request.amount), alreadyPaid: true };
  }
  if (request.status === 'CANCELLED' || request.status === 'EXPIRED') {
    throw paymentError('Ombi halipo tena (limefutwa au limeisha muda).', 400);
  }

  const requesterRes = await pool.query(
    'SELECT phone_number FROM users WHERE id = $1',
    [request.requester_id]
  );
  if (requesterRes.rows.length === 0) {
    throw paymentError('Mwombaji hajapatikana kwenye mfumo.', 404);
  }
  const requesterPhone = requesterRes.rows[0].phone_number;

  const transfer = await walletService.transferWallet(
    payerId,
    requesterPhone,
    request.amount,
    note || `Malipo ya ombi ${request.reference}`
  );

  await pool.query(
    `UPDATE payment_requests
     SET status = 'PAID', paid_at = NOW(), transaction_reference = $1
     WHERE id = $2 AND status = 'PENDING'
     RETURNING id`,
    [transfer.referenceId, request.id]
  );

  await logAudit({
    eventType: 'PAYMENT_REQUEST', action: 'PAY', entityType: 'PAYMENT_REQUEST', entityId: request.id,
    userId: payerId, referenceId: transfer.referenceId, amount: transfer.amount,
    afterData: { request_reference: request.reference, requester_id: request.requester_id },
  });

  return { id: request.id, status: 'PAID', transaction_reference: transfer.referenceId, amount: transfer.amount };
}

module.exports = { createRequest, expireStale, listRequests, cancelRequest, payRequest };