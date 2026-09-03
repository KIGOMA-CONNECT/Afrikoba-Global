/**
 * Analytics Data Warehouse Service
 * Computes and aggregates daily business metrics into the analytics_daily_aggregates table.
 */

const pool = require('../config/db');
const logger = require('./utils/logger');

async function runDailyAggregation(targetDateStr = null) {
  const targetDate = targetDateStr ? new Date(targetDateStr) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateStr = targetDate.toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    const txStats = await client.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(total_charged), 0)::numeric AS volume,
              COALESCE(SUM(commission), 0)::numeric AS fees
       FROM transactions
       WHERE status = 'SUCCESS' AND DATE(created_at) = $1`,
      [dateStr]
    );

    const activeUsers = await client.query(
      `SELECT COUNT(DISTINCT user_id)::int AS count
       FROM transactions
       WHERE DATE(created_at) = $1`,
      [dateStr]
    );

    const newUsers = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM users
       WHERE DATE(created_at) = $1`,
      [dateStr]
    );

    const stats = txStats.rows[0];
    const activeCount = activeUsers.rows[0].count;
    const newCount = newUsers.rows[0].count;

    await client.query(
      `INSERT INTO analytics_daily_aggregates (aggregate_date, total_transactions, total_volume, total_fees, active_users, new_users)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (aggregate_date) DO UPDATE SET
         total_transactions = EXCLUDED.total_transactions,
         total_volume = EXCLUDED.total_volume,
         total_fees = EXCLUDED.total_fees,
         active_users = EXCLUDED.active_users,
         new_users = EXCLUDED.new_users,
         created_at = NOW()`,
      [dateStr, stats.count, stats.volume, stats.fees, activeCount, newCount]
    );

    logger.info('WAREHOUSE', `Daily aggregation completed for ${dateStr}`);
    return { success: true, date: dateStr, stats };
  } catch (err) {
    logger.error('WAREHOUSE', `Daily aggregation failed for ${dateStr}: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function getWarehouseMetrics(limit = 30) {
  const res = await pool.query(
    `SELECT * FROM analytics_daily_aggregates ORDER BY aggregate_date DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

module.exports = { runDailyAggregation, getWarehouseMetrics };
