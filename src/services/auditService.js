/**
 * Audit Log Service
 * Records sensitive actions for security and compliance.
 *
 * The audit_logs table stores discretionary context in a `meta` jsonb column
 * (there is NO `changes` column). Every write here is internally guarded: a
 * failure is logged to the error logger and NEVER crashes the caller.
 */

const pool = require('../config/db');

/**
 * Core write. Stores an audit row; never throws.
 * @param {object} p { userId, action, entityType, entityId, meta, req, client }
 *   `client` (optional) is a caller-owned pg transaction/connection; when
 *   supplied the row is written INSIDE that transaction so FK checks on
 *   `users(id)` never deadlock against locks the caller's txn already holds.
 */
async function writeAudit({ userId, action, entityType, entityId, meta, req, client }) {
  try {
    let metaJson = null;
    if (meta != null) {
      if (typeof meta === 'string') metaJson = JSON.stringify({ description: meta });
      else if (Object.keys(meta).length) metaJson = JSON.stringify(meta);
    }
    const db = client || pool;
    await db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, meta, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId || null,
        action || null,
        entityType || null,
        entityId || null,
        metaJson,
        req ? req.ip : null,
        req ? req.headers['user-agent'] : null,
      ]
    );
  } catch (err) {
    const logger = require('../utils/logger');
    logger.error('AUDIT_LOG_FAILURE', err.message, { action, userId });
  }
}

/**
 * Positional API:
 *   logAction(userId, action, entityType, entityId, meta, req)
 * `meta` is any JSON-serializable context (stored in the jsonb `meta` column).
 */
async function logAction(userId, action, entityType, entityId, meta, req) {
  await writeAudit({ userId, action, entityType, entityId, meta, req });
}

/**
 * Unified dispatch for the two `logAudit` conventions used across the codebase.
 *
 * 1) Object form (event-system services: wallet, rosca, vicoba, p2p, mkoba, network):
 *      logAudit({ eventType, action, entityType, entityId, userId|adminUserId|
 *                 approverUserId|actorUserId, referenceId, amount, afterData })
 * 2) Positional form (feature services: savings, card, bap, business, insurance,
 *      family, autopilot):
 *      logAudit(userId, 'EVENT', 'description')
 *
 * The user-id field is resolved from whatever key the caller provides, so both
 * conventions persist without restructuring their call sites.
 */
async function logAudit(a, b, c) {
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const meta = {};
    if (a.referenceId !== undefined) meta.referenceId = a.referenceId;
    if (a.amount !== undefined) meta.amount = a.amount;
    if (a.afterData !== undefined) meta.afterData = a.afterData;
    if (a.beforeData !== undefined) meta.beforeData = a.beforeData;
    if (a.details !== undefined) meta.details = a.details;
    await writeAudit({
      userId: a.userId ?? a.adminUserId ?? a.approverUserId ?? a.actorUserId ?? null,
      action: a.eventType || a.action || null,
      entityType: a.entityType || null,
      entityId: a.entityId ?? null,
      meta,
      client: a.client,
    });
    return;
  }
  // positional: (userId, event, description)
  await writeAudit({ userId: a, action: b, entityType: null, entityId: null, meta: c ? { description: c } : null });
}

module.exports = { logAction, logAudit, writeAudit, listAudit };

/**
 * List audit log entries (read path for the admin ops dashboard).
 * @param {object} opts { limit, action, entityType }
 */
async function listAudit({ limit = 50, action, entityType } = {}) {
  const where = [];
  const params = [];
  if (action) { params.push(action); where.push(`action = $${params.length}`); }
  if (entityType) { params.push(entityType); where.push(`entity_type = $${params.length}`); }
  params.push(parseInt(limit, 10) || 50);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await pool.query(
    `SELECT a.*, u.full_name, u.phone_number
       FROM audit_logs a LEFT JOIN users u ON u.id::text = a.user_id::text
       ${whereSql}
      ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params
  );
  return res.rows;
}
