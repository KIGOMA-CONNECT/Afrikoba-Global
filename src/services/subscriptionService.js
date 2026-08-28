/**
 * Subscription Tracker Service
 * Track recurring payments and subscriptions.
 */

const pool = require('../config/db');

async function createSubscription(userId, { name, amount, frequency, category, next_billing, auto_pay }) {
  if (!name || !amount || !frequency) throw new Error('Taarifa zote zinahitajika.');
  if (!['WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency)) throw new Error('Mzunguko batili.');

  const result = await pool.query(
    `INSERT INTO subscriptions (user_id, name, amount, frequency, category, next_billing, auto_pay)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, name, amount, frequency, category || 'OTHER', next_billing, auto_pay || false]
  );
  return result.rows[0];
}

async function getSubscriptions(userId) {
  const result = await pool.query(
    `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY next_billing ASC`,
    [userId]
  );
  return result.rows;
}

async function updateSubscription(userId, subId, updates) {
  const { name, amount, frequency, category, next_billing, auto_pay, is_active } = updates;
  const result = await pool.query(
    `UPDATE subscriptions
     SET name = COALESCE($1, name), amount = COALESCE($2, amount), frequency = COALESCE($3, frequency),
         category = COALESCE($4, category), next_billing = COALESCE($5, next_billing),
         auto_pay = COALESCE($6, auto_pay), is_active = COALESCE($7, is_active), updated_at = NOW()
     WHERE id = $8 AND user_id = $9 RETURNING *`,
    [name, amount, frequency, category, next_billing, auto_pay, is_active, subId, userId]
  );
  return result.rows[0];
}

async function deleteSubscription(userId, subId) {
  const result = await pool.query(
    `DELETE FROM subscriptions WHERE id = $1 AND user_id = $2 RETURNING id`,
    [subId, userId]
  );
  return result.rows.length > 0;
}

async function getSubscriptionSummary(userId) {
  const result = await pool.query(
    `SELECT frequency,
       COUNT(*)::int AS count,
       COALESCE(SUM(amount), 0)::numeric AS total_amount
     FROM subscriptions WHERE user_id = $1 AND is_active = TRUE
     GROUP BY frequency`,
    [userId]
  );

  let monthlyTotal = 0;
  for (const row of result.rows) {
    const multiplier = row.frequency === 'WEEKLY' ? 4.33 : row.frequency === 'YEARLY' ? 1/12 : 1;
    monthlyTotal += parseFloat(row.total_amount) * multiplier;
  }

  return {
    activeCount: result.rows.reduce((s, r) => s + r.count, 0),
    monthlyEquivalent: Math.round(monthlyTotal),
    byFrequency: result.rows,
  };
}

async function getDueSoon(userId, days = 7) {
  const result = await pool.query(
    `SELECT * FROM subscriptions
     WHERE user_id = $1 AND is_active = TRUE AND next_billing <= NOW() + $2::interval
     ORDER BY next_billing ASC`,
    [userId, `${days} days`]
  );
  return result.rows;
}

module.exports = { createSubscription, getSubscriptions, updateSubscription, deleteSubscription, getSubscriptionSummary, getDueSoon };
