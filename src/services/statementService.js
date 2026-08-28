/**
 * Account Statement Service
 * Generate PDF statements with transaction history.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Get filtered transactions for statement.
 */
async function getStatement(userId, { startDate, endDate, type, minAmount, maxAmount, limit = 100, offset = 0 }) {
  let query = `SELECT * FROM transactions WHERE user_id = $1`;
  const params = [userId];
  let paramIdx = 2;

  if (startDate) {
    query += ` AND created_at >= $${paramIdx++}`;
    params.push(startDate);
  }
  if (endDate) {
    query += ` AND created_at <= $${paramIdx++}`;
    params.push(endDate);
  }
  if (type) {
    query += ` AND type = $${paramIdx++}`;
    params.push(type);
  }
  if (minAmount) {
    query += ` AND total_charged >= $${paramIdx++}`;
    params.push(minAmount);
  }
  if (maxAmount) {
    query += ` AND total_charged <= $${paramIdx++}`;
    params.push(maxAmount);
  }

  // Summary
  const summaryQuery = query.replace('SELECT *', `
    SELECT COUNT(*)::int AS total_transactions,
           COALESCE(SUM(CASE WHEN type = 'DEPOSIT' THEN total_charged ELSE 0 END), 0)::numeric AS total_in,
           COALESCE(SUM(CASE WHEN type IN ('TRANSFER', 'WITHDRAWAL') THEN total_charged ELSE 0 END), 0)::numeric AS total_out,
           COALESCE(SUM(commission), 0)::numeric AS total_fees
  `);
  const summary = await pool.query(summaryQuery, params);

  query += ` ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  params.push(limit, offset);

  const transactions = await pool.query(query, params);

  return {
    transactions: transactions.rows,
    summary: summary.rows[0],
    period: { startDate: startDate || 'All', endDate: endDate || 'Now' },
  };
}

/**
 * Get opening balance at date.
 */
async function getOpeningBalance(userId, date) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(
       CASE WHEN type = 'DEPOSIT' THEN total_charged
            WHEN type IN ('TRANSFER', 'WITHDRAWAL') THEN -total_charged
            ELSE 0 END
     ), 0)::numeric AS balance
     FROM transactions
     WHERE user_id = $1 AND status = 'SUCCESS' AND created_at < $2`,
    [userId, date]
  );
  return parseFloat(result.rows[0]?.balance || 0);
}

/**
 * Generate statement data for PDF.
 */
async function generateStatementData(userId, options) {
  const { startDate, endDate } = options;

  const [statement, user, openingBalance] = await Promise.all([
    getStatement(userId, options),
    pool.query(`SELECT id, phone, name FROM users WHERE id = $1`, [userId]),
    startDate ? getOpeningBalance(userId, startDate) : Promise.resolve(0),
  ]);

  const closingBalance = openingBalance
    + parseFloat(statement.summary.total_in)
    - parseFloat(statement.summary.total_out)
    - parseFloat(statement.summary.total_fees);

  return {
    user: user.rows[0] || {},
    period: statement.period,
    openingBalance,
    closingBalance,
    summary: statement.summary,
    transactions: statement.transactions,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getStatement, getOpeningBalance, generateStatementData };
