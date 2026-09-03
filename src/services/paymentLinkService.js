/**
 * Payment Links Service
 * Shareable merchant payment links. A merchant creates a link that resolves
 * to a requested amount; any authenticated user can pay it by code.
 */

const pool = require('../config/db');
const crypto = require('crypto');
const merchantService = require('./merchantService');

function generatePaymentLinkCode() {
  return 'PL-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

async function getMyMerchant(userId) {
  const result = await pool.query(
    'SELECT * FROM merchants WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
    [userId]
  );
  return result.rows[0] || null;
}

async function createPaymentLink(userId, { amount, description, currency }) {
  const merchant = await getMyMerchant(userId);
  if (!merchant) throw new Error('Lazima ujiandikishe kama biashara kwanza.');

  const code = generatePaymentLinkCode();
  const result = await pool.query(
    `INSERT INTO merchant_payment_links (merchant_id, code, amount, description, currency)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [merchant.id, code, amount || null, description || null, currency || 'TZS']
  );
  return result.rows[0];
}

async function getPaymentLinks(userId) {
  const merchant = await getMyMerchant(userId);
  if (!merchant) return [];
  const result = await pool.query(
    `SELECT id, code, amount, description, currency, is_active, scan_count, created_at
     FROM merchant_payment_links WHERE merchant_id = $1 ORDER BY created_at DESC`,
    [merchant.id]
  );
  return result.rows;
}

async function getPaymentLinkByCode(code, payerId) {
  const row = await pool.query(
    `SELECT pl.*, m.name AS merchant_name, m.business_type
     FROM merchant_payment_links pl
     JOIN merchants m ON pl.merchant_id = m.id
     WHERE pl.code = $1 AND pl.is_active = TRUE`,
    [code]
  );
  if (row.rows.length === 0) throw new Error('Kiungo cha malipo hakipatikani.');

  const p = row.rows[0];
  if (payerId) {
    await pool.query(`UPDATE merchant_payment_links SET scan_count = scan_count + 1 WHERE id = $1`, [p.id]);
  }

  return {
    id: p.id,
    merchant_id: p.merchant_id,
    code: p.code,
    amount: p.amount,
    description: p.description,
    currency: p.currency,
    merchant_name: p.merchant_name,
    business_type: p.business_type,
    isFixed: !!p.amount,
  };
}

async function payPaymentLink(code, payerId, amount) {
  const p = await getPaymentLinkByCode(code);
  const payAmount = p.amount || amount;
  if (!payAmount || payAmount <= 0) throw new Error('Kiasi kinahitajika.');

  const link = await pool.query(
    `SELECT pl.*, m.user_id AS merchant_user_id
     FROM merchant_payment_links pl JOIN merchants m ON pl.merchant_id = m.id
     WHERE pl.code = $1 AND pl.is_active = TRUE`,
    [code]
  );
  if (link.rows.length === 0) throw new Error('Kiungo cha malipo hakipatikani.');

  const merchantUserId = link.rows[0].merchant_user_id;
  if (merchantUserId === payerId) throw new Error('Huwezi kulipa kiungo chako mwenyewe.');

  return merchantService.payMerchant(payerId, p.merchant_id, payAmount, p.description || undefined);
}

async function deactivatePaymentLink(userId, id) {
  const result = await pool.query(
    `UPDATE merchant_payment_links SET is_active = FALSE
     WHERE id = $1 AND merchant_id = (SELECT id FROM merchants WHERE user_id = $2 ORDER BY id DESC LIMIT 1)
     RETURNING id`,
    [id, userId]
  );
  return result.rows.length > 0;
}

async function lookupMerchantForCode(code) {
  const row = await pool.query(
    `SELECT m.id, m.user_id
     FROM merchant_payment_links pl JOIN merchants m ON pl.merchant_id = m.id
     WHERE pl.code = $1`,
    [code]
  );
  return row.rows[0] || null;
}

module.exports = {
  createPaymentLink,
  getPaymentLinks,
  getPaymentLinkByCode,
  payPaymentLink,
  deactivatePaymentLink,
  lookupMerchantForCode,
};