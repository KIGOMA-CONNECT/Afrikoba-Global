/**
 * QR Code Payment Service
 * Generate and scan QR codes for payments.
 */

const pool = require('../config/db');
const crypto = require('crypto');
const fin = require('./financialEngine');
const { createAppError } = require('../utils/errorCodes');

function generateQrCode() {
  return 'QR-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

async function createQrCode(userId, { amount, description, type, expires_in_minutes }) {
  const code = generateQrCode();
  const expiresAt = expires_in_minutes ? new Date(Date.now() + expires_in_minutes * 60 * 1000) : null;

  const result = await pool.query(
    `INSERT INTO qr_codes (user_id, code, amount, description, type, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, code, amount || null, description || null, type || 'STATIC', expiresAt]
  );
  return result.rows[0];
}

async function getQrCodes(userId) {
  const result = await pool.query(
    `SELECT * FROM qr_codes WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function scanQrCode(code, payerId) {
  const qr = await pool.query(
    `SELECT qc.*, u.phone_number AS payee_phone, u.full_name AS payee_name
     FROM qr_codes qc LEFT JOIN users u ON qc.user_id = u.id
     WHERE qc.code = $1 AND qc.is_active = TRUE`,
    [code]
  );

  if (qr.rows.length === 0) throw createAppError('QR_CODE_NOT_FOUND');
  const q = qr.rows[0];

  if (q.expires_at && new Date(q.expires_at) < new Date()) {
    throw createAppError('QR_CODE_EXPIRED');
  }

  if (q.user_id === payerId) {
    throw createAppError('QR_SELF_PAY_INVALID');
  }

  await pool.query(`UPDATE qr_codes SET scan_count = scan_count + 1 WHERE id = $1`, [q.id]);

  return {
    id: q.id,
    amount: q.amount,
    description: q.description,
    payee: { phone: q.payee_phone, name: q.payee_name },
    isDynamic: q.type === 'DYNAMIC',
  };
}

async function payQrCode(qrCodeId, payerId, amount) {
  const qr = await pool.query(`SELECT * FROM qr_codes WHERE id = $1 AND is_active = TRUE`, [qrCodeId]);
  if (qr.rows.length === 0) throw createAppError('QR_CODE_NOT_FOUND');

  const q = qr.rows[0];
  const payAmount = q.amount || amount;
  if (!payAmount || payAmount <= 0) throw createAppError('QR_AMOUNT_REQUIRED');

  const ref = `QR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payerRow = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [payerId]);
    if (Number(payerRow.rows[0]?.wallet_balance || 0) < payAmount) {
      throw createAppError('WALLET_INSUFFICIENT_FUNDS');
    }

    await fin.internalTransfer({
      client, fromUserId: payerId, toUserId: q.user_id, amount: payAmount,
      reference: ref, description: `QR payment to ${q.user_id}`
    });

    await client.query(
      `INSERT INTO qr_payments (qr_code_id, payer_id, payee_id, amount, status) VALUES ($1, $2, $3, $4, 'SUCCESS')`,
      [qrCodeId, payerId, q.user_id, payAmount]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, wallet_amount, total_charged, commission, status, reference_id, meta)
       VALUES ($1, 'TRANSFER', $2, $2, 0, 'SUCCESS', $3, $4)`,
      [payerId, payAmount, ref, JSON.stringify({ type: 'QR_PAYMENT', qr_code: q.code, payee_id: q.user_id })]
    );

    await client.query('COMMIT');
    return { success: true, reference: ref, amount: payAmount, payee: q.user_id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function deactivateQrCode(userId, qrId) {
  const result = await pool.query(
    `UPDATE qr_codes SET is_active = FALSE WHERE id = $1 AND user_id = $2 RETURNING id`,
    [qrId, userId]
  );
  return result.rows.length > 0;
}

module.exports = { createQrCode, getQrCodes, scanQrCode, payQrCode, deactivateQrCode };
