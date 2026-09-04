/**
 * Governance Access Control & Retention
 * Enforces fine-grained permissions on confidential documents, recordings, and
 * transcripts. Not every member gets access to every confidential discussion.
 * Officers (Chair/Treasurer/Secretary) manage access and retention policies.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const OFFICER_ROLES = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'];

async function getMemberRole(groupId, userId) {
  const res = await pool.query(
    'SELECT role_in_group FROM vicoba_members WHERE group_id=$1 AND user_id=$2',
    [groupId, userId]
  );
  return res.rows[0]?.role_in_group || null;
}

/**
 * Determine whether a member can view a governance record.
 * Order of precedence: explicit grant/deny > confidential officers-only > default allow.
 */
async function canView({ groupId, userId, recordType, recordId, recordConfidential }) {
  if (!recordConfidential) return { allowed: true, reason: 'public_record' };

  // Officers can always view confidential records of their group
  const role = await getMemberRole(groupId, userId);
  if (role && OFFICER_ROLES.includes(role)) return { allowed: true, reason: 'officer_role' };

  // Check explicit grants
  const grant = (await pool.query(
    `SELECT * FROM governance_access_grants
      WHERE record_type=$1 AND record_id=$2
        AND (user_id=$3 OR role=$4)  -- use $4 placeholder
      ORDER BY grant_type LIMIT 1`,
    [recordType, recordId, userId, role || '']
  )).rows[0];

  if (grant) return { allowed: grant.grant_type === 'GRANT', reason: `explicit_${grant.grant_type.toLowerCase()}` };

  // Confidential records default to officers-only
  return { allowed: false, reason: 'confidential_officers_only' };
}

/**
 * Set a document's confidentiality, optionally with retention days.
 */
async function updateDocumentAccess(documentId, { confidential, retentionDays, accessLevel }) {
  const res = await pool.query(
    `UPDATE governance_documents
        SET confidential=COALESCE($2, confidential),
            retention_days=COALESCE($3, retention_days),
            access_level=COALESCE($4, access_level)
      WHERE id=$1 RETURNING *`,
    [documentId, confidential !== undefined ? confidential : null, retentionDays !== undefined ? retentionDays : null, accessLevel || null]
  );
  return res.rows[0];
}

/**
 * Set a transcript's confidentiality.
 */
async function updateTranscriptAccess(transcriptId, { confidential }) {
  const res = await pool.query(
    `UPDATE governance_transcripts SET confidential=COALESCE($2, confidential) WHERE id=$1 RETURNING *`,
    [transcriptId, confidential !== undefined ? confidential : null]
  );
  return res.rows[0];
}

/**
 * Add an explicit grant/deny for a confidential record.
 */
async function addAccessGrant({ recordType, recordId, grantType, userId, role, creatorUserId }) {
  if (!['GRANT', 'DENY'].includes(grantType)) {
    throw Object.assign(new Error('grant_type lazima iwe GRANT au DENY'), { statusCode: 400 });
  }
  const res = await pool.query(
    `INSERT INTO governance_access_grants (record_type, record_id, grant_type, user_id, role, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [recordType, recordId, grantType, userId || null, role || null, creatorUserId]
  );
  logger.info('GOV_ACCESS', `Access ${grantType} on ${recordType}#${recordId}`);
  return res.rows[0];
}

async function removeAccessGrant(grantId) {
  await pool.query('DELETE FROM governance_access_grants WHERE id=$1', [grantId]);
  return { success: true };
}

async function listAccessGrants(recordType, recordId) {
  const res = await pool.query(
    `SELECT g.*, u.full_name FROM governance_access_grants g LEFT JOIN users u ON g.user_id=u.id
     WHERE g.record_type=$1 AND g.record_id=$2`,
    [recordType, recordId]
  );
  return res.rows;
}

/**
 * Set or update the retention policy for a record type in a group.
 */
async function setRetentionPolicy({ groupType, groupId, recordType, retentionDays }) {
  const res = await pool.query(
    `INSERT INTO governance_retention_policies (group_type, group_id, record_type, retention_days)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (group_type, group_id, record_type)
     DO UPDATE SET retention_days=EXCLUDED.retention_days, updated_at=NOW()
     RETURNING *`,
    [groupType || 'VICOBA', groupId, recordType, retentionDays]
  );
  return res.rows[0];
}

async function listRetentionPolicies(groupType, groupId) {
  const res = await pool.query(
    `SELECT * FROM governance_retention_policies WHERE group_type=$1 AND group_id=$2`,
    [groupType || 'VICOBA', groupId]
  );
  return res.rows;
}

module.exports = { canView, getMemberRole, updateDocumentAccess, updateTranscriptAccess, addAccessGrant, removeAccessGrant, listAccessGrants, setRetentionPolicy, listRetentionPolicies };
