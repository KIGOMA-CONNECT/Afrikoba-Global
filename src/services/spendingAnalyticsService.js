/**
 * Spending Analytics Service
 * Category breakdown, trends, insights.
 */

const pool = require('../config/db');

async function getByCategory(userId, period = 'month') {
  const interval = period === 'week' ? '7 days' : period === 'year' ? '1 year' : '1 month';
  const result = await pool.query(
    `SELECT sc.name, sc.icon, sc.color,
       COALESCE(SUM(t.total_charged), 0)::numeric AS total,
       COUNT(t.id)::int AS count
     FROM spending_categories sc
     LEFT JOIN transactions t ON t.type IN ('TRANSFER', 'WITHDRAWAL')
       AND t.user_id = $1
       AND t.status = 'SUCCESS'
       AND t.created_at > NOW() - $2::interval
     GROUP BY sc.id, sc.name, sc.icon, sc.color
     ORDER BY total DESC`,
    [userId, interval]
  );
  return result.rows;
}

async function getMonthlyTrend(userId, months = 6) {
  const result = await pool.query(
    `SELECT 
       TO_CHAR(t.created_at, 'YYYY-MM') AS month,
       COALESCE(SUM(t.total_charged), 0)::numeric AS total_spent,
       COUNT(t.id)::int AS transaction_count
     FROM transactions t
     WHERE t.user_id = $1
       AND t.type IN ('TRANSFER', 'WITHDRAWAL')
       AND t.status = 'SUCCESS'
       AND t.created_at > NOW() - $2::interval
     GROUP BY TO_CHAR(t.created_at, 'YYYY-MM')
     ORDER BY month ASC`,
    [userId, `${months} months`]
  );
  return result.rows;
}

async function getDailySpending(userId) {
  const result = await pool.query(
    `SELECT 
       TO_CHAR(t.created_at, 'YYYY-MM-DD') AS date,
       COALESCE(SUM(t.total_charged), 0)::numeric AS total
     FROM transactions t
     WHERE t.user_id = $1
       AND t.type IN ('TRANSFER', 'WITHDRAWAL')
       AND t.status = 'SUCCESS'
       AND t.created_at > NOW() - INTERVAL '7 days'
     GROUP BY TO_CHAR(t.created_at, 'YYYY-MM-DD')
     ORDER BY date ASC`,
    [userId]
  );
  return result.rows;
}

async function getTopRecipients(userId, limit = 5) {
  const result = await pool.query(
    `SELECT meta->>'recipient' AS recipient_phone,
       COUNT(*)::int AS count,
       COALESCE(SUM(total_charged), 0)::numeric AS total
     FROM transactions
     WHERE user_id = $1 AND type = 'TRANSFER' AND status = 'SUCCESS'
       AND meta->>'recipient' IS NOT NULL
     GROUP BY meta->>'recipient'
     ORDER BY total DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

async function getHealthSummary(userId) {
  const result = await pool.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN type = 'DEPOSIT' THEN total_charged END), 0)::numeric AS total_income,
       COALESCE(SUM(CASE WHEN type IN ('TRANSFER', 'WITHDRAWAL') THEN total_charged END), 0)::numeric AS total_expenses,
       COUNT(CASE WHEN type = 'DEPOSIT' THEN 1 END)::int AS deposit_count,
       COUNT(CASE WHEN type IN ('TRANSFER', 'WITHDRAWAL') THEN 1 END)::int AS expense_count
     FROM transactions
     WHERE user_id = $1 AND status = 'SUCCESS'
       AND created_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );

  const r = result.rows[0];
  return {
    ...r,
    net_flow: parseFloat(r.total_income) - parseFloat(r.total_expenses),
    savings_rate: parseFloat(r.total_income) > 0
      ? (((parseFloat(r.total_income) - parseFloat(r.total_expenses)) / parseFloat(r.total_income)) * 100).toFixed(1)
      : 0,
  };
}

async function getAverageTransaction(userId, period = 'month') {
  const interval = period === 'week' ? '7 days' : period === 'year' ? '1 year' : '1 month';
  const result = await pool.query(
    `SELECT 
       COALESCE(AVG(total_charged), 0)::numeric AS avg_amount,
       COALESCE(MAX(total_charged), 0)::numeric AS max_amount,
       COALESCE(MIN(total_charged), 0)::numeric AS min_amount,
       COUNT(*)::int AS total_count
     FROM transactions
     WHERE user_id = $1 AND status = 'SUCCESS'
       AND created_at > NOW() - $2::interval`,
    [userId, interval]
  );
  return result.rows[0];
}

module.exports = { getByCategory, getMonthlyTrend, getDailySpending, getTopRecipients, getHealthSummary, getAverageTransaction };
