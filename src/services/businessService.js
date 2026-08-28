/**
 * Business Accounts Service
 * Multi-user business accounts with roles and audit trail.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const BUSINESS_ROLES = {
  OWNER: { permissions: ['manage', 'transact', 'view', 'invite', 'audit'] },
  ADMIN: { permissions: ['manage', 'transact', 'view', 'invite'] },
  ACCOUNTANT: { permissions: ['transact', 'view'] },
  VIEWER: { permissions: ['view'] },
};

async function createBusiness(ownerId, { business_name, business_type, registration_number, tax_id, phone, email }) {
  if (!business_name || !phone) throw new Error('Jina la biashara na simu vinahitajika.');

  // Create wallet for business
  const wallet = await pool.query(
    `INSERT INTO wallets (user_id, wallet_amount, currency_code) VALUES ($1, 0, 'TZS') RETURNING id`,
    [0] // Placeholder
  );

  const result = await pool.query(
    `INSERT INTO business_accounts (owner_id, business_name, business_type, registration_number, tax_id, phone, email, wallet_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [ownerId, business_name, business_type || 'OTHER', registration_number || null,
     tax_id || null, phone, email || null, wallet.rows[0].id]
  );

  // Add owner as member
  await pool.query(
    `INSERT INTO business_members (business_id, user_id, role, permissions, joined_at)
     VALUES ($1, $2, 'OWNER', $3, NOW())`,
    [result.rows[0].id, ownerId, BUSINESS_ROLES.OWNER.permissions]
  );

  // Audit log
  await logAction(result.rows[0].id, ownerId, 'BUSINESS_CREATED', { name: business_name });

  return result.rows[0];
}

async function getBusinesses(userId) {
  const result = await pool.query(
    `SELECT ba.*, bm.role, bm.permissions
     FROM business_members bm
     JOIN business_accounts ba ON bm.business_id = ba.id
     WHERE bm.user_id = $1 AND bm.is_active = TRUE AND ba.is_active = TRUE`,
    [userId]
  );
  return result.rows;
}

async function getBusinessDetail(businessId) {
  const result = await pool.query(
    `SELECT ba.*, u.phone AS owner_phone FROM business_accounts ba
     LEFT JOIN users u ON ba.owner_id = u.id WHERE ba.id = $1`,
    [businessId]
  );
  return result.rows[0];
}

async function getMembers(businessId) {
  const result = await pool.query(
    `SELECT bm.*, u.phone, u.name FROM business_members bm
     LEFT JOIN users u ON bm.user_id = u.id
     WHERE bm.business_id = $1 AND bm.is_active = TRUE`,
    [businessId]
  );
  return result.rows;
}

async function inviteMember(businessId, inviterId, { phone, role }) {
  if (!BUSINESS_ROLES[role]) throw new Error('Jukumu batili.');

  // Find user by phone
  const user = await pool.query(`SELECT id FROM users WHERE phone = $1`, [phone]);
  if (user.rows.length === 0) throw new Error('Mtumiaji haupatikani kwa nambari hii.');

  // Check inviter permissions
  const inviter = await pool.query(
    `SELECT role FROM business_members WHERE business_id = $1 AND user_id = $2`,
    [businessId, inviterId]
  );
  if (!['OWNER', 'ADMIN'].includes(inviter.rows[0]?.role)) {
    throw new Error('Huna ruhusa ya kuongeza wanachama.');
  }

  const result = await pool.query(
    `INSERT INTO business_members (business_id, user_id, role, permissions)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, user_id) DO UPDATE SET role = $3, permissions = $4, is_active = TRUE
     RETURNING *`,
    [businessId, user.rows[0].id, role, BUSINESS_ROLES[role].permissions]
  );

  await logAction(businessId, inviterId, 'MEMBER_INVITED', { phone, role });

  return result.rows[0];
}

async function removeMember(businessId, adminId, userId) {
  const admin = await pool.query(
    `SELECT role FROM business_members WHERE business_id = $1 AND user_id = $2`,
    [businessId, adminId]
  );
  if (!['OWNER', 'ADMIN'].includes(admin.rows[0]?.role)) {
    throw new Error('Huna ruhusa.');
  }

  const result = await pool.query(
    `UPDATE business_members SET is_active = FALSE WHERE business_id = $1 AND user_id = $2 RETURNING id`,
    [businessId, userId]
  );

  await logAction(businessId, adminId, 'MEMBER_REMOVED', { userId });
  return result.rows.length > 0;
}

async function getAuditLog(businessId, limit = 50) {
  const result = await pool.query(
    `SELECT bal.*, u.phone AS user_phone
     FROM business_audit_log bal
     LEFT JOIN users u ON bal.user_id = u.id
     WHERE bal.business_id = $1
     ORDER BY bal.created_at DESC LIMIT $2`,
    [businessId, limit]
  );
  return result.rows;
}

async function logAction(businessId, userId, action, details = {}) {
  await pool.query(
    `INSERT INTO business_audit_log (business_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [businessId, userId, action, JSON.stringify(details)]
  );
}

module.exports = { createBusiness, getBusinesses, getBusinessDetail, getMembers, inviteMember, removeMember, getAuditLog, BUSINESS_ROLES };
