const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Analytics service — event tracking + metrics.
 */

/**
 * Track an analytics event.
 */
async function trackEvent(userId, eventType, eventData = {}, req = null) {
  try {
    const ip = req?.ip || null;
    const ua = req?.get('user-agent') || null;
    await pool.query(
      `INSERT INTO analytics_events (user_id, event_type, event_data, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, eventType, eventData, ip, ua]
    );
  } catch (err) {
    logger.warn('ANALYTICS', `Track event failed: ${err.message}`);
  }
}

/**
 * Get platform metrics (admin dashboard).
 */
async function getPlatformMetrics() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours') AS new_users_24h,
      (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') AS new_users_7d,
      (SELECT COUNT(*) FROM transactions) AS total_transactions,
      (SELECT COUNT(*) FROM transactions WHERE created_at > NOW() - INTERVAL '24 hours') AS tx_24h,
      (SELECT COALESCE(SUM(wallet_amount), 0) FROM transactions WHERE status = 'SUCCESS' AND created_at > NOW() - INTERVAL '24 hours') AS volume_24h,
      (SELECT COALESCE(SUM(wallet_amount), 0) FROM transactions WHERE status = 'SUCCESS' AND created_at > NOW() - INTERVAL '30 days') AS volume_30d,
      (SELECT COUNT(*) FROM investment_projects WHERE status = 'ACTIVE') AS active_projects,
      (SELECT COALESCE(SUM(total_amount), 0) FROM investments) AS total_invested,
      (SELECT COUNT(*) FROM vicoba_groups WHERE status = 'ACTIVE') AS active_vicoba_groups,
      (SELECT COUNT(*) FROM rosca_pools WHERE status = 'ACTIVE') AS active_rosca_pools,
      (SELECT COUNT(*) FROM user_service_subscriptions WHERE status = 'ACTIVE') AS active_subscriptions
  `);
  return result.rows[0];
}

/**
 * Get user activity breakdown.
 */
async function getUserActivity(userId) {
  const result = await pool.query(`
    SELECT
      event_type,
      COUNT(*) AS count,
      MAX(created_at) AS last_active
    FROM analytics_events
    WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY event_type
    ORDER BY count DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get daily transaction volume (last 30 days).
 */
async function getDailyVolume() {
  const result = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      type,
      COUNT(*)::int AS count,
      COALESCE(SUM(wallet_amount), 0)::numeric AS volume
    FROM transactions
    WHERE status = 'SUCCESS' AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at), type
    ORDER BY date DESC`,
  );
  return result.rows;
}

/**
 * Get top users by transaction volume.
 */
async function getTopUsers(limit = 10) {
  const result = await pool.query(`
    SELECT
      u.id, u.full_name, u.phone_number, u.role,
      COUNT(t.id)::int AS tx_count,
      COALESCE(SUM(t.wallet_amount), 0)::numeric AS total_volume
    FROM users u
    JOIN transactions t ON t.user_id = u.id AND t.status = 'SUCCESS'
    GROUP BY u.id
    ORDER BY total_volume DESC
    LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = { trackEvent, getPlatformMetrics, getUserActivity, getDailyVolume, getTopUsers };
