/**
 * SACCOS Digital Core (increment 21) - Wallet Freeze / Unfreeze for AML compliance.
 *
 * wallet_freezes is enforced on the two primary cash-out routes (P2P transfer + MNO withdrawal).
 * RBAC: ADMIN or COMPLIANCE (COMPLIANCE_ROLES).
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');

const COMPLIANCE_ROLES = ['ADMIN', 'COMPLIANCE'];

function newRef() {
  return 'FRZ-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

async function assertNotFrozen(userId) {
  const r = await pool.query(
    "SELECT id, reference, reason FROM wallet_freezes WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
    [userId]
  );
  if (r.rows.length) {
    throw createAppError('AML_ACCOUNT_FROZEN');
  }
}

async function assertComplianceRole(actorId) {
  const r = await pool.query("SELECT role FROM users WHERE id = $1", [actorId]);
  if (!r.rows.length || !COMPLIANCE_ROLES.includes(r.rows[0].role)) {
    throw createAppError('AML_CASE_RBAC');
  }
}

async function freezeWallet(actorId, targetUserId, { reason, caseId }) {
  const r = await pool.query(
    "SELECT id FROM wallet_freezes WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
    [targetUserId]
  );
  if (r.rows.length) {
    throw createAppError('AML_FREEZE_ALREADY_ACTIVE');
  }
  const reference = newRef();
  const res = await pool.query(
    `INSERT INTO wallet_freezes (user_id, case_id, reference, reason, initiated_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [targetUserId, caseId || null, reference, reason, actorId]
  );
  await logAudit(actorId, 'AML_WALLET_FROZEN', { referenceId: targetUserId, details: { freezeId: res.rows[0].id, reference, reason } }).catch(() => {});
  return res.rows[0];
}

async function liftFreeze(actorId, freezeId, { comment }) {
  const existing = await pool.query(
    "SELECT id, user_id, status FROM wallet_freezes WHERE id = $1",
    [freezeId]
  );
  if (!existing.rows.length) {
    throw createAppError('AML_FREEZE_NOT_FOUND');
  }
  const freeze = existing.rows[0];
  if (freeze.status !== 'ACTIVE') {
    throw createAppError('AML_FREEZE_NOT_ACTIVE');
  }
  const res = await pool.query(
    `UPDATE wallet_freezes SET status = 'LIFTED', lifted_by = $2, lifted_at = NOW(), lifted_comment = $3 WHERE id = $1 RETURNING *`,
    [freezeId, actorId, comment || null]
  );
  await logAudit(actorId, 'AML_WALLET_LIFTED', { referenceId: freeze.user_id, details: { freezeId, comment: comment || null } }).catch(() => {});
  return res.rows[0];
}

async function listFreezes({ status, userId, limit = 50, offset = 0 }) {
  const conditions = [];
  const params = [];
  if (status) {
    conditions.push(`f.status = $${params.length + 1}`);
    params.push(status);
  }
  if (userId) {
    conditions.push(`f.user_id = $${params.length + 1}`);
    params.push(userId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const r = await pool.query(
    `SELECT f.id, f.user_id, f.case_id, f.reference, f.reason, f.status,
            f.initiated_by, f.initiated_at, f.lifted_by, f.lifted_at, f.lifted_comment,
            f.created_at,
            u.full_name AS user_name, u.phone_number AS user_phone,
            a.full_name AS actor_name
     FROM wallet_freezes f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN users a ON a.id = f.initiated_by
     ${where}
     ORDER BY f.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return r.rows;
}

async function getFreeze(freezeId) {
  const r = await pool.query(
    `SELECT f.id, f.user_id, f.case_id, f.reference, f.reason, f.status,
            f.initiated_by, f.initiated_at, f.lifted_by, f.lifted_at, f.lifted_comment,
            f.created_at,
            u.full_name AS user_name, u.phone_number AS user_phone,
            a.full_name AS actor_name, l.full_name AS lifted_by_name
     FROM wallet_freezes f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN users a ON a.id = f.initiated_by
     LEFT JOIN users l ON l.id = f.lifted_by
     WHERE f.id = $1`,
    [freezeId]
  );
  if (!r.rows.length) {
    throw createAppError('AML_FREEZE_NOT_FOUND');
  }
  return r.rows[0];
}

module.exports = {
  COMPLIANCE_ROLES,
  assertNotFrozen,
  assertComplianceRole,
  freezeWallet,
  liftFreeze,
  listFreezes,
  getFreeze,
};
