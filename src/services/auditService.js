const pool = require('../config/db');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Immutable audit trail for all financial mutations & admin actions.
 * PCI-DSS / SOC2 requirement: every financial mutation must be traceable.
 * This table is append-only — no UPDATE or DELETE operations are permitted.
 */

/**
 * Log an audit event. All parameters except eventType, action, entityType are optional.
 *
 * @param {Object} entry
 * @param {string} entry.eventType - DEPOSIT, WITHDRAWAL, TRANSFER, INVESTMENT, etc.
 * @param {string} entry.action - CREATE, UPDATE, DELETE, APPROVE, REJECT, RELEASE
 * @param {string} entry.entityType - USER, TRANSACTION, PROJECT, VICOBA_GROUP, etc.
 * @param {number} [entry.entityId]
 * @param {number} [entry.userId]
 * @param {string} [entry.actorRole] - ADMIN, USER, SYSTEM, CRON
 * @param {Object} [entry.beforeData]
 * @param {Object} [entry.afterData]
 * @param {string} [entry.ipAddress]
 * @param {string} [entry.userAgent]
 * @param {string} [entry.referenceId]
 * @param {number} [entry.amount]
 * @param {string} [entry.currency]
 * @param {string} [entry.status]
 * @param {string} [entry.errorMessage]
 * @param {Object} [entry.metadata]
 */
async function logAudit(entry) {
  try {
    await pool.query(
      `INSERT INTO audit_log
        (event_type, action, entity_type, entity_id, user_id, actor_role,
         before_data, after_data, ip_address, user_agent, reference_id,
         amount, currency, status, error_message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        entry.eventType,
        entry.action,
        entry.entityType,
        entry.entityId || null,
        entry.userId || null,
        entry.actorRole || 'USER',
        entry.beforeData ? JSON.stringify(entry.beforeData) : null,
        entry.afterData ? JSON.stringify(entry.afterData) : null,
        entry.ipAddress || null,
        entry.userAgent || null,
        entry.referenceId || null,
        entry.amount || null,
        entry.currency || 'TZS',
        entry.status || 'SUCCESS',
        entry.errorMessage || null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ]
    );
  } catch (err) {
    logger.error('AUDIT', `Failed to write audit log: ${err.message}`);
  }
}

/**
 * Query audit trail with filters.
 */
async function queryAudit({ userId, entityType, entityId, eventType, referenceId, page = 1, limit = 20 }) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (userId) { conditions.push(`user_id = $${idx++}`); params.push(userId); }
  if (entityType) { conditions.push(`entity_type = $${idx++}`); params.push(entityType); }
  if (entityId) { conditions.push(`entity_id = $${idx++}`); params.push(entityId); }
  if (eventType) { conditions.push(`event_type = $${idx++}`); params.push(eventType); }
  if (referenceId) { conditions.push(`reference_id = $${idx++}`); params.push(referenceId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM audit_log ${where}`,
    params
  );
  const total = countRes.rows[0].total;

  const { limit: lim, offset } = parsePagination({ page, limit });
  params.push(lim, offset);

  const result = await pool.query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    params
  );
  return { data: result.rows, pagination: paginationMeta(total, Number(page), lim) };
}

module.exports = { logAudit, queryAudit };
