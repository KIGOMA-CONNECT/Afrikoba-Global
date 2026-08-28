/**
 * Receipt Service
 * Generate transaction receipts.
 */

const pool = require('../config/db');

async function getReceipt(transactionId, userId) {
  const tx = await pool.query(
    `SELECT t.*, u.phone AS user_phone, u.name AS user_name
     FROM transactions t
     LEFT JOIN users u ON t.user_id = u.id
     WHERE t.id = $1 AND t.user_id = $2`,
    [transactionId, userId]
  );

  if (tx.rows.length === 0) throw new Error('Muamala haupatikani.');

  const t = tx.rows[0];
  const meta = t.meta || {};

  return {
    receiptNumber: `REC-${t.reference_id}`,
    date: t.created_at,
    transaction: {
      id: t.id,
      reference: t.reference_id,
      type: t.type,
      status: t.status,
    },
    from: {
      name: t.user_name,
      phone: t.user_phone,
    },
    to: {
      phone: meta.recipient || null,
      name: meta.recipient_name || null,
    },
    amount: parseFloat(t.total_charged),
    commission: parseFloat(t.commission),
    total: parseFloat(t.total_charged),
    currency: t.currency_code || 'TZS',
    description: meta.note || meta.description || null,
    merchant: meta.merchant || null,
  };
}

module.exports = { getReceipt };
