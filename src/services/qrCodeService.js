/**
 * QR Code Payment Service
 * Generate and scan QR codes for payments.
 */

const pool = require('../config/db');
const crypto = require('crypto');

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
    `SELECT qc.*, u.phone AS payee_phone, u.name AS payee_name
     FROM qr_codes qc LEFT JOIN users u ON qc.user_id = u.id
     WHERE qc.code = $1 AND qc.is_active = TRUE`,
    [code]
  );

  if (qr.rows.length === 0) throw new Error('QR code haipatikani.');
  const q = qr.rows[0];

  if (q.expires_at && new Date(q.expires_at) < new Date()) {
    throw new Error('QR code imeisha muda.');
  }

  if (q.user_id === payerId) {
    throw new Error('Huwezi kulipa QR code yako mwenyewe.');
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
  if (qr.rows.length === 0) throw new Error('QR code haipatikani.');

  const q = qr.rows[0];
  const payAmount = q.amount || amount;
  if (!payAmount || payAmount <= 0) throw new Error('Kiasi kinahitajika.');

  // Check wallet
  const wallet = await pool.query(`SELECT wallet_amount FROM wallets WHERE user_id = $1`, [payerId]);
  if (wallet.rows.length === 0 || parseFloat(wallet.rows[0].wallet_amount) < payAmount) {
    throw new Error('Salio la wallet haikutosha.');
  }

  // Transfer
  await pool.query(`UPDATE wallets SET wallet_amount = wallet_amount - $1 WHERE user_id = $2`, [payAmount, payerId]);
  await pool.query(`UPDATE wallets SET wallet_amount = wallet_amount + $1 WHERE user_id = $2`, [payAmount, q.user_id]);

  const ref = `QR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  await pool.query(
    `INSERT INTO qr_payments (qr_code_id, payer_id, payee_id, amount, status) VALUES ($1, $2, $3, $4, 'SUCCESS')`,
    [qrCodeId, payerId, q.user_id, payAmount]
  );

  await pool.query(
    `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, meta)
     VALUES ($1, 'TRANSFER', $2, 0, 'SUCCESS', $3, $4)`,
    [payerId, payAmount, ref, JSON.stringify({ type: 'QR_PAYMENT', qr_code: q.code, payee_id: q.user_id })]
  );

  return { success: true, reference: ref, amount: payAmount, payee: q.user_id };
}

async function deactivateQrCode(userId, qrId) {
  const result = await pool.query(
    `UPDATE qr_codes SET is_active = FALSE WHERE id = $1 AND user_id = $2 RETURNING id`,
    [qrId, userId]
  );
  return result.rows.length > 0;
}

module.exports = { createQrCode, getQrCodes, scanQrCode, payQrCode, deactivateQrCode };
