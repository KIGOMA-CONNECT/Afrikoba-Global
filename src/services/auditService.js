/**
 * Audit Log Service
 * Records sensitive actions for security and compliance.
 */

const pool = require('../config/db');

async function logAction(userId, action, entityType, entityId, changes, req) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        action,
        entityType,
        entityId,
        changes,
        req ? req.ip : null,
        req ? req.headers['user-agent'] : null,
      ]
    );
  } catch (err) {
    // Audit logging failure should not crash the main application,
    // but MUST be logged to the main error logger.
    const logger = require('../utils/logger');
    logger.error('AUDIT_LOG_FAILURE', err.message, { action, userId });
  }
}

module.exports = { logAction };