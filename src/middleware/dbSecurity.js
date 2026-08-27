/**
 * Database Security Hardening
 * Query timeouts, connection limits, injection prevention.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Set statement timeout for all queries (30 seconds default).
 * Prevents long-running queries from consuming resources.
 */
async function setStatementTimeout() {
  try {
    await pool.query('SET statement_timeout = 30000'); // 30 seconds
    logger.info('DB', 'Statement timeout set to 30s');
  } catch (err) {
    logger.warn('DB', `Failed to set statement timeout: ${err.message}`);
  }
}

/**
 * Set lock timeout (10 seconds).
 * Prevents deadlocks from hanging indefinitely.
 */
async function setLockTimeout() {
  try {
    await pool.query('SET lock_timeout = 10000'); // 10 seconds
    logger.info('DB', 'Lock timeout set to 10s');
  } catch (err) {
    logger.warn('DB', `Failed to set lock timeout: ${err.message}`);
  }
}

/**
 * Set idle transaction timeout (30 seconds).
 * Prevents abandoned transactions from holding locks.
 */
async function setIdleTransactionTimeout() {
  try {
    await pool.query('SET idle_in_transaction_session_timeout = 30000');
    logger.info('DB', 'Idle transaction timeout set to 30s');
  } catch (err) {
    logger.warn('DB', `Failed to set idle transaction timeout: ${err.message}`);
  }
}

/**
 * Validate query parameters to prevent injection.
 * This is a defense-in-depth measure - parameterized queries are primary.
 */
function validateQueryParam(value, type = 'string') {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'integer':
      const intVal = parseInt(value, 10);
      if (isNaN(intVal)) throw new Error('Invalid integer parameter');
      return intVal;
    case 'float':
      const floatVal = parseFloat(value);
      if (isNaN(floatVal)) throw new Error('Invalid float parameter');
      return floatVal;
    case 'string':
      if (typeof value !== 'string') return String(value);
      // Block common SQL injection patterns
      const dangerousPatterns = [
        /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|FETCH|DECLARE|TRUNCATE)\b)/i,
        /(--|;|\/\*|\*\/|xp_|sp_)/i,
        /(\b(OR|AND)\b\s+\d+\s*=\s*\d+)/i,
        /(CHAR\(|CONCAT\(|0x[0-9a-f]+)/i,
      ];
      if (dangerousPatterns.some(p => p.test(value))) {
        logger.warn('SECURITY', `Blocked suspicious query param: ${value}`);
        throw new Error('Invalid parameter value');
      }
      return value;
    default:
      return value;
  }
}

/**
 * Monitor slow queries.
 */
async function monitorSlowQueries() {
  try {
    const result = await pool.query(`
      SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
      FROM pg_stat_activity
      WHERE state != 'idle'
      AND now() - pg_stat_activity.query_start > interval '5 seconds'
      ORDER BY duration DESC
      LIMIT 10
    `);

    if (result.rows.length > 0) {
      logger.warn('DB', `Slow queries detected: ${result.rows.length}`);
      result.rows.forEach(row => {
        logger.warn('DB-SLOW', `PID ${row.pid}: ${row.duration} - ${row.query.substring(0, 100)}`);
      });
    }
  } catch (err) {
    // Ignore - monitoring is best effort
  }
}

// Monitor slow queries every 30 seconds
setInterval(monitorSlowQueries, 30 * 1000);

/**
 * Initialize all database security settings.
 */
async function initDbSecurity() {
  await setStatementTimeout();
  await setLockTimeout();
  await setIdleTransactionTimeout();
  logger.info('DB', 'Database security hardening initialized');
}

module.exports = {
  initDbSecurity,
  validateQueryParam,
  monitorSlowQueries,
};
