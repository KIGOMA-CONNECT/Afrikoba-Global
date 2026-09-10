/**
 * SACCOS Digital Core - Foundation (increment 1).
 * Organization registration + config-driven setup + compliance boundary +
 * membership lifecycle (invite/accept/suspend/exit).
 *
 * Isolation rules:
 *   * Every query is scoped by saccos_id.
 *   * A non-member gets 404 (no enumeration across SACCOS entities).
 *   * RBAC is enforced at the SACCOS level (OWNER/BOARD/MEMBER) on top of
 *     platform auth; platform ADMIN may cross-read for oversight.
 */
const pool = require('../config/db');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');

const GOVERNING_ROLES = ['OWNER', 'BOARD'];
const INVITABLE_ROLES = ['BOARD', 'MEMBER'];
const OPEN_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED'];

function buildCode() {
  const stamp = Date.now().toString(36).toUpperCase().slice(-6);
  const salt = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return `SAC-${stamp}${salt}`;
}

async function assertVisible(actorId, saccosId) {
  const [mem, usr] = await Promise.all([
    pool.query('SELECT * FROM saccos_members WHERE saccos_id = $1 AND user_id = $2', [saccosId, actorId]),
    pool.query('SELECT role FROM users WHERE id = $1', [actorId]),
  ]);
  const membership = mem.rows[0] || null;
  const isPlatformAdmin = !!usr.rows[0] && usr.rows[0].role === 'ADMIN';
  if (membership) return { membership, isPlatformAdmin };
  if (isPlatformAdmin) return { membership: null, isPlatformAdmin };
  throw createAppError('SACCOS_NOT_FOUND');
}

async function assertActiveRole(actorId, saccosId, roles) {
  const mem = await pool.query(
    'SELECT * FROM saccos_members WHERE saccos_id = $1 AND user_id = $2 AND status = $3',
    [saccosId, actorId, 'ACTIVE']
  );
  if (!mem.rows.length) throw createAppError('SACCOS_NOT_MEMBER');
  if (!roles.includes(mem.rows[0].role)) throw createAppError('SACCOS_RBAC');
  return mem.rows[0];
}

async function assertMembershipCanAdminister(actorId, saccosId) {
  const { membership, isPlatformAdmin } = await assertVisible(actorId, saccosId);
  if (isPlatformAdmin) return { membership: null, isPlatformAdmin };
  if (!membership || membership.status !== 'ACTIVE' || !GOVERNING_ROLES.includes(membership.role)) {
    throw createAppError('SACCOS_RBAC');
  }
  return { membership, isPlatformAdmin };
}

async function nextMemberNumber(saccosId) {
  const r = await pool.query(
    'SELECT COALESCE(MAX(member_number::int), 0) + 1 AS next_no FROM saccos_members WHERE saccos_id = $1',
    [saccosId]
  );
  return String(r.rows[0].next_no).padStart(4, '0');
}

async function fetchMember(saccosId, memberId) {
  const r = await pool.query('SELECT * FROM saccos_members WHERE id = $1 AND saccos_id = $2', [memberId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_MEMBER_NOT_FOUND');
  return r.rows[0];
}

async function createSaccos(actorId, { name, registrationNumber, countryCode, legalEntity, config }) {
  const clean = (name || '').trim();
  if (!clean) throw createAppError('SACCOS_NAME_REQUIRED');

  const dup = await pool.query('SELECT id FROM saccos WHERE name = $1', [clean]);
  if (dup.rows.length) throw createAppError('SACCOS_NAME_TAKEN');

  const org = await pool.query(
    `INSERT INTO saccos (code, name, registration_number, country_code, created_by, config)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
    [buildCode(), clean, registrationNumber || null, (countryCode || 'TZ').toUpperCase(), actorId, JSON.stringify(config || {})]
  );
  const saccos = org.rows[0];

  await pool.query(
    `INSERT INTO saccos_compliance (saccos_id, legal_entity, regulatory_status)
     VALUES ($1, $2, 'TECH_INFRA')`,
    [saccos.id, legalEntity || 'Unspecified']
  );

  const founder = await pool.query(
    `INSERT INTO saccos_members (saccos_id, user_id, role, member_number, status, membership_category, admission_date, accepted_at)
     VALUES ($1, $2, 'OWNER', '0001', 'ACTIVE', 'REGULAR', CURRENT_DATE, NOW()) RETURNING *`,
    [saccos.id, actorId]
  );

  await logAudit(actorId, 'SACCOS_CREATED', { referenceId: saccos.id, details: { name: saccos.name } }).catch(() => {});
  return { saccos, membership: founder.rows[0] };
}

async function listMySaccos(userId) {
  const r = await pool.query(
    `SELECT s.id, s.code, s.name, s.status, s.country_code, s.created_at,
            m.role AS membership_role, m.member_number, m.status AS membership_status
     FROM saccos s
     JOIN saccos_members m ON m.saccos_id = s.id
     WHERE m.user_id = $1 AND m.status <> 'EXITED'
     ORDER BY s.created_at DESC`,
    [userId]
  );
  return r.rows;
}

async function getSaccos(actorId, saccosId) {
  const r = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  await assertVisible(actorId, saccosId);
  return r.rows[0];
}

async function activateSaccos(actorId, saccosId) {
  await assertActiveRole(actorId, saccosId, ['OWNER']);
  const org = await pool.query('SELECT status FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  if (org.rows[0].status === 'SUSPENDED') throw createAppError('SACCOS_MEMBER_STATUS_INVALID');
  const updated = await pool.query(
    `UPDATE saccos SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [saccosId]
  );
  await logAudit(actorId, 'SACCOS_ACTIVATED', { referenceId: saccosId }).catch(() => {});
  return updated.rows[0];
}

async function inviteMember(actorId, saccosId, { phoneNumber, role }) {
  await assertActiveRole(actorId, saccosId, GOVERNING_ROLES);
  const targetRole = role || 'MEMBER';
  if (!INVITABLE_ROLES.includes(targetRole)) throw createAppError('SACCOS_RBAC');

  const phone = (phoneNumber || '').trim();
  if (!phone) throw createAppError('SACCOS_PHONE_NOT_FOUND');
  const tgt = await pool.query('SELECT id FROM users WHERE phone_number = $1', [phone]);
  if (!tgt.rows.length) throw createAppError('SACCOS_PHONE_NOT_FOUND');
  const targetId = tgt.rows[0].id;

  const existing = await pool.query(
    'SELECT * FROM saccos_members WHERE saccos_id = $1 AND user_id = $2',
    [saccosId, targetId]
  );

  let membership;
  if (existing.rows.length) {
    const cur = existing.rows[0];
    if (OPEN_STATUSES.includes(cur.status)) throw createAppError('SACCOS_ALREADY_MEMBER');
    membership = (
      await pool.query(
        `UPDATE saccos_members SET status = 'INVITED', role = $2, invited_by = $3, membership_category = 'REGULAR', updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [cur.id, targetRole, actorId]
      )
    ).rows[0];
  } else {
    const memberNo = await nextMemberNumber(saccosId);
    membership = (
      await pool.query(
        `INSERT INTO saccos_members (saccos_id, user_id, role, member_number, status, membership_category, invited_by)
         VALUES ($1, $2, $3, $4, 'INVITED', 'REGULAR', $5) RETURNING *`,
        [saccosId, targetId, targetRole, memberNo, actorId]
      )
    ).rows[0];
  }

  await logAudit(actorId, 'SACCOS_MEMBER_INVITED', { referenceId: saccosId, details: { userId: targetId } }).catch(() => {});
  return membership;
}

async function acceptMembership(userId, saccosId, memberId) {
  const member = await fetchMember(saccosId, memberId);
  if (member.user_id !== userId) throw createAppError('SACCOS_MEMBER_FORBIDDEN');
  if (member.status !== 'INVITED') throw createAppError('SACCOS_MEMBER_STATUS_INVALID');
  const updated = await pool.query(
    `UPDATE saccos_members SET status = 'ACTIVE', admission_date = CURRENT_DATE, accepted_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [memberId]
  );
  return updated.rows[0];
}

async function listMembers(actorId, saccosId) {
  await assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query(
    `SELECT m.id, m.member_number, m.role, m.status, m.membership_category, m.admission_date,
            u.full_name, u.phone_number
     FROM saccos_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.saccos_id = $1
     ORDER BY m.member_number`,
    [saccosId]
  );
  return r.rows;
}

async function suspendMember(actorId, saccosId, memberId) {
  await assertActiveRole(actorId, saccosId, ['OWNER']);
  const member = await fetchMember(saccosId, memberId);
  if (member.role === 'OWNER') throw createAppError('SACCOS_RBAC');
  if (member.status === 'EXITED') throw createAppError('SACCOS_MEMBER_STATUS_INVALID');
  return (
    await pool.query(
      `UPDATE saccos_members SET status = 'SUSPENDED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [memberId]
    )
  ).rows[0];
}

async function exitMember(userId, saccosId, memberId) {
  const member = await fetchMember(saccosId, memberId);
  if (member.user_id !== userId) throw createAppError('SACCOS_MEMBER_FORBIDDEN');
  if (member.role === 'OWNER') throw createAppError('SACCOS_RBAC');
  if (member.status === 'EXITED') throw createAppError('SACCOS_MEMBER_STATUS_INVALID');
  return (
    await pool.query(
      `UPDATE saccos_members SET status = 'EXITED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [memberId]
    )
  ).rows[0];
}

async function getCompliance(actorId, saccosId) {
  await assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query('SELECT * FROM saccos_compliance WHERE saccos_id = $1', [saccosId]);
  return r.rows[0] || {};
}

module.exports = {
  createSaccos,
  listMySaccos,
  getSaccos,
  activateSaccos,
  inviteMember,
  acceptMembership,
  listMembers,
  suspendMember,
  exitMember,
  getCompliance,
  assertVisible,
  assertActiveRole,
  assertMembershipCanAdminister,
};