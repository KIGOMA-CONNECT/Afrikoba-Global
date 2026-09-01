/**
 * Merchant Payment Service
 * Pay merchants, list merchants, payment history.
 */

const pool = require('../config/db');
const crypto = require('crypto');
const fin = require('./financialEngine');

async function registerMerchant(userId, { name, business_type, phone, email }) {
  const result = await pool.query(
    `INSERT INTO merchants (user_id, name, business_type, phone, email)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, name, business_type || 'OTHER', phone, email || null]
  );
  return result.rows[0];
}

async function getMerchants(search = null) {
  // Usirudishe email/user_id kwenye public endpoint (PII protection)
  let query = `SELECT id, name, business_type, phone, is_active FROM merchants WHERE is_active = TRUE`;
  const params = [];
  if (search) {
    query += ` AND (name ILIKE $1 OR phone = $2)`;
    params.push(`%${search}%`, search);
  }
  query += ` ORDER BY name ASC`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function payMerchant(payerId, merchantId, amount, description) {
  if (amount <= 0) throw new Error('Kiasi lazima kiwe chanya.');

  const merchant = await pool.query(
    `SELECT * FROM merchants WHERE id = $1 AND is_active = TRUE`,
    [merchantId]
  );
  if (merchant.rows.length === 0) throw new Error('Biashara haipatikani.');

  const merchantUserId = merchant.rows[0].user_id;

  const ref = `MERCH-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (merchantUserId && merchantUserId !== payerId) {
      await fin.internalTransfer({
        client, fromUserId: payerId, toUserId: merchantUserId, amount,
        reference: ref, description: `Merchant payment to ${merchant.rows[0].name}`
      });
    } else {
      await fin.debitWallet({
        client, userId: payerId, amount, reference: ref,
        toAccount: 'SUSPENSE',
        description: `Merchant payment to ${merchant.rows[0].name}`
      });
    }

    // Record payment
    await client.query(
      `INSERT INTO merchant_payments (merchant_id, payer_id, amount, reference, description, status)
       VALUES ($1, $2, $3, $4, $5, 'SUCCESS')`,
      [merchantId, payerId, amount, ref, description || `Malipo kwa ${merchant.rows[0].name}`]
    );

    // Record transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, meta)
       VALUES ($1, 'TRANSFER', $2, 0, 'SUCCESS', $3, $4)`,
      [payerId, amount, ref, JSON.stringify({
        merchant_id: merchantId,
        merchant_name: merchant.rows[0].name,
        type: 'MERCHANT_PAYMENT',
      })]
    );

    await client.query('COMMIT');
    return { success: true, reference: ref, merchant: merchant.rows[0].name };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getMerchantPayments(merchantId) {
  const result = await pool.query(
    `SELECT mp.*, u.phone AS payer_phone, u.name AS payer_name
     FROM merchant_payments mp
     LEFT JOIN users u ON mp.payer_id = u.id
     WHERE mp.merchant_id = $1
     ORDER BY mp.created_at DESC`,
    [merchantId]
  );
  return result.rows;
}

module.exports = { registerMerchant, getMerchants, payMerchant, getMerchantPayments };
