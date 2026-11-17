'use strict';

/**
 * GSF Governance Service — database-backed institutional governance (OD-10 Phase 2 P3/P4).
 *
 * Uses PostgreSQL tables defined in db/migrations/drafts/004_gsf_governance_foundation.sql.
 * Strict role isolation: global users.role (ADMIN), VICOBA and SACCOS roles grant
 * zero implicit GSF authority. All authorization is explicit institution-scoped grants.
 */

const { Pool } = require('pg');
const LIFECYCLE_STATES = ['OPEN', 'COLLECTING', 'TARGET_REACHED', 'CLOSED', 'CANCELLED', 'EXPIRED', 'DISBURSEMENT_PENDING', 'PARTIALLY_DISBURSED', 'DISBURSED'];
const ALLOWED_TRANSITIONS = {
  OPEN: ['COLLECTING', 'CLOSED', 'CANCELLED', 'EXPIRED'],
  COLLECTING: ['TARGET_REACHED', 'CLOSED', 'CANCELLED', 'EXPIRED'],
  TARGET_REACHED: ['CLOSED', 'CANCELLED', 'DISBURSEMENT_PENDING'],
  CLOSED: ['CANCELLED', 'DISBURSEMENT_PENDING'],
  CANCELLED: [],
  EXPIRED: ['CANCELLED'],
  DISBURSEMENT_PENDING: ['PARTIALLY_DISBURSED', 'DISBURSED', 'CANCELLED'],
  PARTIALLY_DISBURSED: ['DISBURSED', 'CANCELLED'],
  DISBURSED: [],
};
function canTransition(from, to) {
  if (!LIFECYCLE_STATES.includes(from) || !LIFECYCLE_STATES.includes(to)) return false;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function createPool(config) {
  if (config) return new Pool(config);
  const db = process.env.DB_NAME || process.env.PGDATABASE;
  if (!db) throw new Error('DB_NAME (or PGDATABASE) is required for GSF governance service');
  return new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 55432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: db,
  });
}

class GsfGovernanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GsfGovernanceError';
    this.code = code;
  }
}

async function auditEvent(pool, { institutionId, actorId, action, resourceType, resourceId, outcome, correlationId, details }) {
  await pool.query(
    `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome, correlation_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [institutionId || null, actorId || null, action, resourceType || null, resourceId || null, outcome, correlationId || null, details ? JSON.stringify(details) : null]
  );
}

async function createInstitution(pool, { name, createdBy }) {
  if (!name) throw new GsfGovernanceError('INSTITUTION_INVALID', 'name required');
  const r = await pool.query(
    `INSERT INTO institutions (name, created_by) VALUES ($1,$2) RETURNING *`,
    [name, createdBy || null]
  );
  await auditEvent(pool, { institutionId: r.rows[0].id, actorId: createdBy, action: 'INSTITUTION_CREATED', resourceType: 'institution', resourceId: r.rows[0].id, outcome: 'SUCCESS' });
  return r.rows[0];
}

async function addOwner(pool, { institutionId, userId, verifiedBy, criticalApprover = false }) {
  // hybrid verification: automated consistency (no duplicate) + independent reviewer approval
  const existing = await pool.query('SELECT * FROM gsf_institution_owners WHERE institution_id=$1 AND user_id=$2', [institutionId, userId]);
  if (existing.rows.length) throw new GsfGovernanceError('OWNER_EXISTS', 'owner already exists');
  // independent reviewer must differ from applicant
  if (verifiedBy != null && Number(verifiedBy) === Number(userId)) {
    throw new GsfGovernanceError('SELF_APPROVAL_FORBIDDEN', 'applicant cannot verify themselves');
  }
  const r = await pool.query(
    `INSERT INTO gsf_institution_owners (institution_id, user_id, status, verified_by) VALUES ($1,$2,'VERIFIED',$3) RETURNING *`,
    [institutionId, userId, verifiedBy || null]
  );
  await auditEvent(pool, { institutionId, actorId: verifiedBy, action: 'OWNER_VERIFIED', resourceType: 'owner', resourceId: String(userId), outcome: 'SUCCESS' });
  return r.rows[0];
}

async function revokeOwner(pool, { institutionId, userId, revokedBy }) {
  await pool.query('UPDATE gsf_institution_owners SET status=$1, revoked_at=NOW(), revoked_by=$2 WHERE institution_id=$3 AND user_id=$4', ['REVOKED', revokedBy || null, institutionId, userId]);
  await auditEvent(pool, { institutionId, actorId: revokedBy, action: 'OWNER_REVOKED', resourceType: 'owner', resourceId: String(userId), outcome: 'SUCCESS' });
}

async function isVerifiedOwner(pool, institutionId, userId) {
  const r = await pool.query("SELECT 1 FROM gsf_institution_owners WHERE institution_id=$1 AND user_id=$2 AND status='VERIFIED'", [institutionId, userId]);
  return r.rows.length > 0;
}

async function grantPermission(pool, { institutionId, userId, permissionCode, grantedBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO gsf_governance_grants (institution_id, user_id, permission_code, granted_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [institutionId, userId, permissionCode, grantedBy || null]
    );
    await client.query(
      `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [institutionId, grantedBy || null, 'ROLE_GRANTED', 'permission', String(userId), 'SUCCESS', JSON.stringify({ permissionCode })]
    );
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function revokePermission(pool, { institutionId, userId, permissionCode, revokedBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE gsf_governance_grants SET revoked_at=NOW(), revoked_by=$1 WHERE institution_id=$2 AND user_id=$3 AND permission_code=$4 AND revoked_at IS NULL`,
      [revokedBy || null, institutionId, userId, permissionCode]
    );
    await client.query(
      `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [institutionId, revokedBy || null, 'ROLE_REVOKED', 'permission', String(userId), 'SUCCESS', JSON.stringify({ permissionCode })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function hasPermission(pool, institutionId, userId, permissionCode) {
  const r = await pool.query(
    `SELECT 1 FROM gsf_governance_grants
     WHERE institution_id=$1 AND user_id=$2 AND permission_code=$3 AND revoked_at IS NULL`,
    [institutionId, userId, permissionCode]
  );
  return r.rows.length > 0;
}

async function bindCampaign(pool, { campaignId, institutionId, linkStatus, evidence, linkedBy }) {
  const status = ['VERIFIED','UNRESOLVED','INTENTIONALLY_UNBOUND','AMBIGUOUS'].includes(linkStatus) ? linkStatus : 'UNRESOLVED';
  const r = await pool.query(
    `INSERT INTO gsf_campaign_institution_links (campaign_id, institution_id, link_status, evidence, linked_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (campaign_id) DO UPDATE SET institution_id=EXCLUDED.institution_id, link_status=EXCLUDED.link_status, evidence=EXCLUDED.evidence, linked_by=EXCLUDED.linked_by, linked_at=NOW()
     RETURNING *`,
    [campaignId, institutionId, status, evidence || null, linkedBy || null]
  );
  await auditEvent(pool, { institutionId, actorId: linkedBy, action: 'CAMPAIGN_BOUND', resourceType: 'campaign', resourceId: String(campaignId), outcome: status, details: { linkStatus: status } });
  return r.rows[0];
}

async function getCampaignInstitution(pool, campaignId) {
  const r = await pool.query('SELECT institution_id, link_status FROM gsf_campaign_institution_links WHERE campaign_id=$1', [campaignId]);
  return r.rows[0] || null;
}

// Institution-scoped authorization: actor permission + campaign-institution link
async function authorizeCampaignAction(pool, { actorId, institutionId, permissionCode, campaignId }) {
  // 1. active membership
  const mem = await pool.query("SELECT 1 FROM gsf_institution_members WHERE institution_id=$1 AND user_id=$2 AND membership_status='ACTIVE'", [institutionId, actorId]);
  if (!mem.rows.length) return { allowed: false, reason: 'NO_ACTIVE_MEMBERSHIP' };
  // 2. verified institution
  const inst = await pool.query("SELECT 1 FROM institutions WHERE id=$1 AND status='ACTIVE'", [institutionId]);
  if (!inst.rows.length) return { allowed: false, reason: 'INSTITUTION_NOT_ACTIVE' };
  // 3. explicit active permission grant
  const has = await hasPermission(pool, institutionId, actorId, permissionCode);
  if (!has) return { allowed: false, reason: 'MISSING_PERMISSION' };
  // 4. verified campaign-institution link
  const link = await getCampaignInstitution(pool, campaignId);
  if (!link || link.link_status !== 'VERIFIED' || link.institution_id !== institutionId) {
    return { allowed: false, reason: 'CAMPAIGN_NOT_VERIFIED_BOUND' };
  }
  return { allowed: true, reason: 'OK' };
}

// Dual-control ownership change (two distinct verified owners; SELECT FOR UPDATE)
async function requestOwnershipChange(pool, { institutionId, targetUserId, changeType, requestedBy, requiredApprovers }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query("SELECT 1 FROM gsf_institution_owners WHERE institution_id=$1 AND user_id=$2 AND status='VERIFIED' FOR UPDATE", [institutionId, requestedBy]);
    if (!owner.rows.length) throw new GsfGovernanceError('NOT_VERIFIED_OWNER', 'requester must be a verified owner');
    // Resolve required approvers from trusted gsf_critical_approvers table (not caller-controlled)
    const crit = await client.query("SELECT user_id FROM gsf_critical_approvers WHERE institution_id=$1", [institutionId]);
    const required = crit.rows.map((r) => Number(r.user_id));
    if (required.length !== 2 || new Set(required).size !== 2) {
      throw new GsfGovernanceError('INVALID_REQUIRED_APPROVERS', 'exactly two distinct trusted critical approvers must be configured');
    }
    // Validate each is a verified owner
    for (const aid of required) {
      const r = await client.query("SELECT 1 FROM gsf_institution_owners WHERE institution_id=$1 AND user_id=$2 AND status='VERIFIED' FOR UPDATE", [institutionId, aid]);
      if (!r.rows.length) throw new GsfGovernanceError('REQUIRED_APPROVER_NOT_VERIFIED', 'required approver is not a verified owner');
    }
    // maker must be distinct from both required approvers
    if (required.includes(Number(requestedBy))) {
      throw new GsfGovernanceError('MAKER_CANNOT_BE_APPROVER', 'maker must be distinct from required approvers');
    }
    const r = await client.query(
      `INSERT INTO gsf_ownership_change_requests (institution_id, target_user_id, change_type, requested_by, expires_at, required_approvers)
       VALUES ($1,$2,$3,$4, NOW() + INTERVAL '1 hour', $5) RETURNING *`,
      [institutionId, targetUserId, changeType, requestedBy, JSON.stringify(required)]
    );
    await client.query(
      `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome) VALUES ($1,$2,$3,$4,$5,$6)`,
      [institutionId, requestedBy, 'OWNERSHIP_CHANGE_REQUESTED', 'ownership', r.rows[0].id, 'PENDING']
    );
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function approveOwnershipChange(pool, { requestId, approverId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const req = await client.query('SELECT * FROM gsf_ownership_change_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (!req.rows.length) throw new GsfGovernanceError('REQUEST_NOT_FOUND', 'request not found');
    const r = req.rows[0];
    if (r.status !== 'PENDING') throw new GsfGovernanceError('REQUEST_NOT_PENDING', 'request not pending');
    if (r.expires_at && new Date(r.expires_at) < new Date()) throw new GsfGovernanceError('REQUEST_EXPIRED', 'request expired');
    if (r.requested_by === approverId) throw new GsfGovernanceError('SELF_APPROVAL_FORBIDDEN', 'self-approval forbidden');
    const owner = await client.query("SELECT 1 FROM gsf_institution_owners WHERE institution_id=$1 AND user_id=$2 AND status='VERIFIED' FOR UPDATE", [r.institution_id, approverId]);
    if (!owner.rows.length) throw new GsfGovernanceError('NOT_VERIFIED_OWNER', 'approver must be a verified owner');
    const dup = await client.query('SELECT 1 FROM gsf_ownership_change_approvals WHERE request_id=$1 AND approver_id=$2', [requestId, approverId]);
    if (dup.rows.length) throw new GsfGovernanceError('DUPLICATE_APPROVAL', 'approver already decided');

    // Enforce required approvers (Ayub + Mariana) resolved from trusted records.
    const required = r.required_approvers ? (typeof r.required_approvers === 'string' ? JSON.parse(r.required_approvers) : r.required_approvers) : null;
    // Fail closed on missing/malformed/empty/duplicate/non-exact approver set
    if (!Array.isArray(required) || required.length !== 2) {
      throw new GsfGovernanceError('INVALID_REQUIRED_APPROVERS', 'required approvers must be an array of exactly two trusted identities');
    }
    const normalizedRequired = required.map(Number);
    if (normalizedRequired.some((x) => !Number.isFinite(x)) || new Set(normalizedRequired).size !== 2) {
      throw new GsfGovernanceError('INVALID_REQUIRED_APPROVERS', 'required approvers must be two distinct valid identities');
    }
    if (normalizedRequired.includes(NaN)) {
      throw new GsfGovernanceError('INVALID_REQUIRED_APPROVERS', 'required approvers must be valid identities');
    }
    if (!normalizedRequired.includes(Number(approverId))) {
      throw new GsfGovernanceError('APPROVER_NOT_AUTHORIZED', 'approver is not in the required approver set');
    }

    await client.query('INSERT INTO gsf_ownership_change_approvals (request_id, approver_id, decision) VALUES ($1,$2,$3)', [requestId, approverId, 'APPROVED']);
    const approvedIds = (await client.query("SELECT approver_id FROM gsf_ownership_change_approvals WHERE request_id=$1 AND decision='APPROVED'", [requestId])).rows.map((x) => Number(x.approver_id));

    // All required approvers must have approved; no fallback to generic count
    const allRequiredMet = normalizedRequired.every((id) => approvedIds.includes(id));

    if (allRequiredMet) {
      await client.query("UPDATE gsf_ownership_change_requests SET status='APPROVED' WHERE id=$1", [requestId]);
      if (r.change_type === 'REVOKE_OWNER') {
        await client.query("UPDATE gsf_institution_owners SET status='REVOKED', revoked_at=NOW() WHERE institution_id=$1 AND user_id=$2", [r.institution_id, r.target_user_id]);
      }
    }
    // audit in same transaction
    await client.query(
      `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome) VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.institution_id, approverId, 'OWNERSHIP_CHANGE_APPROVED', 'ownership', requestId, 'APPROVED']
    );
    await client.query('COMMIT');
    return { requestId, approvers: approvedIds.length, approved: allRequiredMet, approvedIds };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function reconcileLegacyCampaign(pool, { campaignId, institutionId, status, evidence, linkedBy }) {
  const s = ['VERIFIED','UNRESOLVED','INTENTIONALLY_UNBOUND','AMBIGUOUS'].includes(status) ? status : 'UNRESOLVED';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO gsf_campaign_institution_links (campaign_id, institution_id, link_status, evidence, linked_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (campaign_id) DO UPDATE SET institution_id=EXCLUDED.institution_id, link_status=EXCLUDED.link_status, evidence=EXCLUDED.evidence, linked_by=EXCLUDED.linked_by, linked_at=NOW()
       RETURNING *`,
      [campaignId, institutionId, s, evidence || null, linkedBy || null]
    );
    await client.query(
      `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [institutionId, linkedBy || null, 'LEGACY_RECONCILIATION', 'campaign', String(campaignId), s, JSON.stringify({ evidence })]
    );
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Atomic campaign status transition with governance audit (GAP-1)
async function governedCampaignStatusChange(pool, { actorId, institutionId, campaignId, newStatus, correlationId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // active membership
    const mem = await client.query("SELECT 1 FROM gsf_institution_members WHERE institution_id=$1 AND user_id=$2 AND membership_status='ACTIVE' FOR UPDATE", [institutionId, actorId]);
    if (!mem.rows.length) throw new GsfGovernanceError('NO_ACTIVE_MEMBERSHIP', 'no active membership');
    // verified institution
    const inst = await client.query("SELECT 1 FROM institutions WHERE id=$1 AND status='ACTIVE'", [institutionId]);
    if (!inst.rows.length) throw new GsfGovernanceError('INSTITUTION_NOT_ACTIVE', 'institution not active');
    // explicit permission
    const perm = await client.query('SELECT 1 FROM gsf_governance_grants WHERE institution_id=$1 AND user_id=$2 AND permission_code=$3 AND revoked_at IS NULL', [institutionId, actorId, 'GSF_CAMPAIGN_STATUS_CHANGE']);
    if (!perm.rows.length) throw new GsfGovernanceError('MISSING_PERMISSION', 'missing permission');
    // verified campaign-institution link
    const link = await client.query("SELECT institution_id, link_status FROM gsf_campaign_institution_links WHERE campaign_id=$1 FOR UPDATE", [campaignId]);
    if (!link.rows.length || link.rows[0].link_status !== 'VERIFIED' || link.rows[0].institution_id !== institutionId) {
      throw new GsfGovernanceError('CAMPAIGN_NOT_VERIFIED_BOUND', 'campaign not verified-bound to institution');
    }
    // lifecycle state validation + update
    const caseRes = await client.query('SELECT status FROM social_fund_cases WHERE id=$1 FOR UPDATE', [campaignId]);
    if (!caseRes.rows.length) throw new GsfGovernanceError('CASE_NOT_FOUND', 'case not found');
    const currentStatus = caseRes.rows[0].status;
    if (!LIFECYCLE_STATES.includes(newStatus)) throw new GsfGovernanceError('INVALID_STATUS', 'invalid lifecycle status');
    if (!canTransition(currentStatus, newStatus)) throw new GsfGovernanceError('INVALID_TRANSITION', 'invalid lifecycle transition');
    await client.query('UPDATE social_fund_cases SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, campaignId]);
    // audit event in same transaction
    await client.query(
      `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome, correlation_id, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [institutionId, actorId, 'GSF_CAMPAIGN_STATUS_CHANGE', 'campaign', String(campaignId), 'SUCCESS', correlationId || null, JSON.stringify({ newStatus })]
    );
    await client.query('COMMIT');
    return { allowed: true, updated: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function designateCriticalApprover(pool, { institutionId, userId, designatedBy }) {
  // Requires designatedBy to be a verified owner distinct from userId
  const owner = await pool.query("SELECT 1 FROM gsf_institution_owners WHERE institution_id=$1 AND user_id=$2 AND status='VERIFIED'", [institutionId, designatedBy]);
  if (!owner.rows.length) throw new GsfGovernanceError('NOT_VERIFIED_OWNER', 'designator must be a verified owner');
  if (Number(designatedBy) === Number(userId)) throw new GsfGovernanceError('SELF_DESIGNATION_FORBIDDEN', 'cannot designate self');
  const target = await pool.query("SELECT 1 FROM gsf_institution_owners WHERE institution_id=$1 AND user_id=$2 AND status='VERIFIED'", [institutionId, userId]);
  if (!target.rows.length) throw new GsfGovernanceError('TARGET_NOT_VERIFIED', 'target must be a verified owner');
  await pool.query('INSERT INTO gsf_critical_approvers (institution_id, user_id, designated_by) VALUES ($1,$2,$3) ON CONFLICT (institution_id,user_id) DO NOTHING', [institutionId, userId, designatedBy]);
  await auditEvent(pool, { institutionId, actorId: designatedBy, action: 'CRITICAL_APPROVER_DESIGNATED', resourceType: 'owner', resourceId: String(userId), outcome: 'SUCCESS' });
  return { institutionId, userId, designatedBy };
}

module.exports = {
  createPool,
  GsfGovernanceError,
  createInstitution,
  addOwner,
  revokeOwner,
  isVerifiedOwner,
  grantPermission,
  revokePermission,
  hasPermission,
  bindCampaign,
  getCampaignInstitution,
  authorizeCampaignAction,
  requestOwnershipChange,
  approveOwnershipChange,
  reconcileLegacyCampaign,
  auditEvent,
  governedCampaignStatusChange,
  submitInstitutionEvidence,
  reviewInstitution,
  escalateOwnershipChange,
  designateCriticalApprover,
  createInstitutionService,
};

// --- GAP remediation functions ---

async function submitInstitutionEvidence(pool, { institutionId, evidenceType, evidenceRef, submittedBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO gsf_institution_evidence (institution_id, evidence_type, evidence_ref, submitted_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [institutionId, evidenceType, evidenceRef, submittedBy || null]
    );
    await client.query("UPDATE institutions SET status='PENDING' WHERE id=$1", [institutionId]);
    await client.query(
      `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome) VALUES ($1,$2,$3,$4,$5,$6)`,
      [institutionId, submittedBy || null, 'EVIDENCE_SUBMITTED', 'institution', institutionId, 'PENDING_REVIEW']
    );
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function reviewInstitution(pool, { institutionId, reviewerId, decision, note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE gsf_institution_evidence SET verified_by=$1, verified_at=NOW() WHERE institution_id=$2 AND verified_by IS NULL', [reviewerId, institutionId]);
    const status = decision === 'APPROVE' ? 'ACTIVE' : 'SUSPENDED';
    await client.query('UPDATE institutions SET status=$1, updated_at=NOW() WHERE id=$2', [status, institutionId]);
    await client.query(
      `INSERT INTO gsf_governance_audit_events (institution_id, actor_id, action, resource_type, resource_id, outcome, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [institutionId, reviewerId, 'INSTITUTION_REVIEWED', 'institution', institutionId, decision, JSON.stringify({ note })]
    );
    await client.query('COMMIT');
    return { institutionId, decision, status };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function escalateOwnershipChange(pool, { requestId, escalatedBy, reason }) {
  await pool.query("UPDATE gsf_ownership_change_requests SET status='ESCALATED' WHERE id=$1", [requestId]);
  await auditEvent(pool, { institutionId: null, actorId: escalatedBy, action: 'OWNERSHIP_CHANGE_ESCALATED', resourceType: 'ownership', resourceId: requestId, outcome: 'ESCALATED', details: { reason } });
  return { requestId, escalated: true, reason };
}

function createInstitutionService(pool) {
  return {
    createInstitution: (d) => createInstitution(pool, d),
    addOwner: (d) => addOwner(pool, d),
    revokeOwner: (d) => revokeOwner(pool, d),
    isVerifiedOwner: (iid, uid) => isVerifiedOwner(pool, iid, uid),
    grantPermission: (d) => grantPermission(pool, d),
    revokePermission: (d) => revokePermission(pool, d),
    hasPermission: (iid, uid, code) => hasPermission(pool, iid, uid, code),
    bindCampaign: (d) => bindCampaign(pool, d),
    authorizeCampaignAction: (d) => authorizeCampaignAction(pool, d),
    governedCampaignStatusChange: (d) => governedCampaignStatusChange(pool, d),
    requestOwnershipChange: (d) => requestOwnershipChange(pool, d),
    approveOwnershipChange: (d) => approveOwnershipChange(pool, d),
    reconcileLegacyCampaign: (d) => reconcileLegacyCampaign(pool, d),
    submitInstitutionEvidence: (d) => submitInstitutionEvidence(pool, d),
    reviewInstitution: (d) => reviewInstitution(pool, d),
    escalateOwnershipChange: (d) => escalateOwnershipChange(pool, d),
  };
}
