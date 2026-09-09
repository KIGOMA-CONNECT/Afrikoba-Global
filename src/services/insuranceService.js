/**
 * Micro-Insurance Service
 * Insurance products, policy management.
 */

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
const { createAppError } = require('../utils/errorCodes');
const fin = require('./financialEngine');

async function getProducts(category = null) {
  let query = `SELECT * FROM insurance_products WHERE is_active = TRUE`;
  const params = [];
  if (category) { query += ` AND category = $1`; params.push(category); }
  query += ` ORDER BY name`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function purchasePolicy(userId, { product_id, age }) {
  const product = await pool.query(`SELECT * FROM insurance_products WHERE id = $1 AND is_active = TRUE`, [product_id]);
  if (product.rows.length === 0) throw createAppError('INSURANCE_PRODUCT_NOT_FOUND');

  const p = product.rows[0];
  if (age && (age < p.min_age || age > p.max_age)) {
    throw createAppError('INSURANCE_AGE_INVALID');
  }

  // Check wallet for first premium
  const ref = generateReference('INS');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payerRow = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (Number(payerRow.rows[0]?.wallet_balance || 0) < parseFloat(p.premium_monthly)) {
      throw createAppError('WALLET_INSUFFICIENT_FUNDS');
    }

    await fin.debitWallet({
      client, userId, amount: parseFloat(p.premium_monthly), reference: ref,
      toAccount: 'MNO_CLEARING',
      description: `Insurance premium: ${p.name}`
    });

    const result = await client.query(
      `INSERT INTO insurance_policies (user_id, product_id, premium_paid, next_premium_date, coverage_start)
       VALUES ($1, $2, $3, CURRENT_DATE + INTERVAL '1 month', CURRENT_DATE) RETURNING *`,
      [userId, product_id, p.premium_monthly]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, wallet_amount, meta)
       VALUES ($1, 'WITHDRAWAL', $2, 0, 'SUCCESS', $3, $2, $4)`,
      [userId, p.premium_monthly, ref,
       JSON.stringify({ type: 'INSURANCE_PREMIUM', product: p.name })]
    );

    await client.query('COMMIT');
    return { policy: result.rows[0], product: p };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getPolicies(userId) {
  const result = await pool.query(
    `SELECT ip.*, ipr.name AS product_name, ipr.category, ipr.coverage_amount, ipr.premium_monthly
     FROM insurance_policies ip
     JOIN insurance_products ipr ON ip.product_id = ipr.id
     WHERE ip.user_id = $1
     ORDER BY ip.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function renewPolicy(userId, policyId) {
  const policy = await pool.query(
    `SELECT ip.*, ipr.premium_monthly, ipr.name AS product_name FROM insurance_policies ip
     JOIN insurance_products ipr ON ip.product_id = ipr.id
     WHERE ip.id = $1 AND ip.user_id = $2 AND ip.status = 'ACTIVE'`,
    [policyId, userId]
  );
  if (policy.rows.length === 0) throw createAppError('INSURANCE_POLICY_NOT_FOUND');

  const p = policy.rows[0];

  const ref = generateReference('INS');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payerRow = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (Number(payerRow.rows[0]?.wallet_balance || 0) < parseFloat(p.premium_monthly)) {
      throw createAppError('WALLET_INSUFFICIENT_FUNDS');
    }

    await fin.debitWallet({
      client, userId, amount: parseFloat(p.premium_monthly), reference: ref,
      toAccount: 'MNO_CLEARING',
      description: `Insurance premium renewal: policy ${policyId}`
    });

    await client.query(
      `UPDATE insurance_policies SET premium_paid = premium_paid + $1, next_premium_date = next_premium_date + INTERVAL '1 month' WHERE id = $2`,
      [p.premium_monthly, policyId]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, wallet_amount, meta)
       VALUES ($1, 'WITHDRAWAL', $2, 0, 'SUCCESS', $3, $2, $4)`,
      [userId, p.premium_monthly, ref,
       JSON.stringify({ type: 'INSURANCE_PREMIUM_RENEWAL', product: p.product_name })]
    );

    await client.query('COMMIT');
    return { success: true, message: 'Sera imesasishwa.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getProducts, purchasePolicy, getPolicies, renewPolicy };
