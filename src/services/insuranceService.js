/**
 * Micro-Insurance Service
 * Insurance products, policy management.
 */

const pool = require('../config/db');

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
  if (product.rows.length === 0) throw new Error('Bidhaa haipatikani.');

  const p = product.rows[0];
  if (age && (age < p.min_age || age > p.max_age)) {
    throw new Error(`Umri lazima uwe kati ya ${p.min_age} na ${p.max_age}.`);
  }

  // Check wallet for first premium
  const wallet = await pool.query(`SELECT wallet_amount FROM wallets WHERE user_id = $1`, [userId]);
  if (wallet.rows.length === 0 || parseFloat(wallet.rows[0].wallet_amount) < parseFloat(p.premium_monthly)) {
    throw new Error('Salio la wallet haikutosha kwa ada ya kwanza.');
  }

  await pool.query(`UPDATE wallets SET wallet_amount = wallet_amount - $1 WHERE user_id = $2`,
    [parseFloat(p.premium_monthly), userId]);

  const result = await pool.query(
    `INSERT INTO insurance_policies (user_id, product_id, premium_paid, next_premium_date, coverage_start)
     VALUES ($1, $2, $3, CURRENT_DATE + INTERVAL '1 month', CURRENT_DATE) RETURNING *`,
    [userId, product_id, p.premium_monthly]
  );

  await pool.query(
    `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, meta)
     VALUES ($1, 'WITHDRAWAL', $2, 0, 'SUCCESS', $3, $4)`,
    [userId, p.premium_monthly, `INS-${result.rows[0].id}`,
     JSON.stringify({ type: 'INSURANCE_PREMIUM', product: p.name })]
  );

  return { policy: result.rows[0], product: p };
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
    `SELECT ip.*, ipr.premium_monthly FROM insurance_policies ip
     JOIN insurance_products ipr ON ip.product_id = ipr.id
     WHERE ip.id = $1 AND ip.user_id = $2 AND ip.status = 'ACTIVE'`,
    [policyId, userId]
  );
  if (policy.rows.length === 0) throw new Error('Sera haipatikani.');

  const p = policy.rows[0];
  const wallet = await pool.query(`SELECT wallet_amount FROM wallets WHERE user_id = $1`, [userId]);
  if (parseFloat(wallet.rows[0].wallet_amount) < parseFloat(p.premium_monthly)) {
    throw new Error('Salio la wallet haikutosha.');
  }

  await pool.query(`UPDATE wallets SET wallet_amount = wallet_amount - $1 WHERE user_id = $2`,
    [parseFloat(p.premium_monthly), userId]);

  await pool.query(
    `UPDATE insurance_policies SET premium_paid = premium_paid + $1, next_premium_date = next_premium_date + INTERVAL '1 month' WHERE id = $2`,
    [p.premium_monthly, policyId]
  );

  return { success: true, message: 'Sera imesh Renewed.' };
}

module.exports = { getProducts, purchasePolicy, getPolicies, renewPolicy };
