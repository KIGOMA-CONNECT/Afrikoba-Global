/**
 * Database maintenance tasks — run via cron or scheduled.
 * Handles: idempotency cleanup, OTP cleanup, table stats.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Clean expired idempotency keys (older than 24h).
 */
async function cleanupIdempotencyKeys() {
  try {
    const result = await pool.query(
      "DELETE FROM idempotency_keys WHERE expires_at < NOW() - INTERVAL '24 hours'"
    );
    logger.info('CLEANUP', `Removed ${result.rowCount} expired idempotency keys.`);
    return result.rowCount;
  } catch (err) {
    logger.error('CLEANUP', `Idempotency cleanup failed: ${err.message}`);
    return 0;
  }
}

/**
 * Clean expired OTP codes (older than 1 hour).
 */
async function cleanupExpiredOTPs() {
  try {
    const result = await pool.query(
      "DELETE FROM otp_codes WHERE created_at < NOW() - INTERVAL '1 hour'"
    );
    logger.info('CLEANUP', `Removed ${result.rowCount} expired OTP codes.`);
    return result.rowCount;
  } catch (err) {
    logger.error('CLEANUP', `OTP cleanup failed: ${err.message}`);
    return 0;
  }
}

/**
 * Get table sizes and row counts for monitoring.
 */
async function getTableStats() {
  try {
    const result = await pool.query(`
      SELECT
        schemaname,
        tablename,
        n_live_tup AS row_count,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
      LIMIT 20
    `);
    return result.rows;
  } catch (err) {
    logger.error('CLEANUP', `Table stats failed: ${err.message}`);
    return [];
  }
}

/**
 * Get database health metrics.
 */
async function getHealthMetrics() {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active_connections,
        (SELECT count(*) FROM pg_stat_activity) AS total_connections,
        (SELECT count(*) FROM users) AS total_users,
        (SELECT count(*) FROM transactions) AS total_transactions,
        (SELECT count(*) FROM transactions WHERE status = 'PENDING') AS pending_transactions,
        (SELECT count(*) FROM audit_log) AS total_audit_entries,
        (SELECT pg_size_pretty(pg_database_size(current_database()))) AS db_size
    `);
    return result.rows[0];
  } catch (err) {
    logger.error('CLEANUP', `Health metrics failed: ${err.message}`);
    return null;
  }
}

/**
 * Run all maintenance tasks.
 */
async function runMaintenance() {
  logger.info('CLEANUP', 'Starting scheduled maintenance...');
  const startTime = Date.now();

  const idempotencyCleaned = await cleanupIdempotencyKeys();
  const otpsCleaned = await cleanupExpiredOTPs();

  const elapsed = Date.now() - startTime;
  logger.info('CLEANUP', `Maintenance complete in ${elapsed}ms. Idempotency: ${idempotencyCleaned}, OTPs: ${otpsCleaned}`);

  return { idempotencyCleaned, otpsCleaned, elapsed };
}

module.exports = {
  cleanupIdempotencyKeys,
  cleanupExpiredOTPs,
  getTableStats,
  getHealthMetrics,
  runMaintenance,
};
