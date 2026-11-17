'use strict';

/**
 * OD-08 Phase 1 — Institutional domain foundation.
 *
 * This module establishes the institutional domain model, ownership, four-eyes
 * critical ownership changes, resource-to-institution binding, institution-scoped
 * authorization, explicit role/permission grants, and auditability — WITHOUT
 * executing Migration 155 or modifying OD-10.
 *
 * No database schema changes are made here. State is held in an injectable
 * store so the domain can be exercised and tested without touching the ledger.
 */

const crypto = require('crypto');

const LEGACY_STATUSES = Object.freeze(['VERIFIED', 'UNRESOLVED', 'INTENTIONALLY_UNBOUND', 'AMBIGUOUS']);

const INSTITUTION_STATUSES = Object.freeze(['PENDING', 'ACTIVE', 'SUSPENDED', 'RETIRED']);
const OWNER_STATUSES = Object.freeze(['UNVERIFIED', 'VERIFIED', 'REVOKED']);
const APPROVAL_STATUSES = Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']);

class InstitutionDomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstitutionDomainError';
    this.code = code;
  }
}

function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

class InstitutionStore {
  constructor() {
    this.institutions = new Map();
    this.owners = new Map();          // institutionId -> Map(ownerId, owner)
    this.resources = new Map();       // resourceId -> binding
    this.grants = new Map();          // `${institutionId}:${userId}` -> Set(permission)
    this.ownershipRequests = new Map();// requestId -> request
    this.approvals = new Map();      // requestId -> Map(approverId, decision)
    this.audit = [];
    this.legacyReconciliation = new Map(); // resourceId -> { candidateInstitutionId, status, evidence }
  }
}

class InstitutionDomain {
  constructor(store = new InstitutionStore()) {
    this.store = store;
  }

  // --- Institution lifecycle ---
  createInstitution({ id, name, createdBy }) {
    if (!id || !name) throw new InstitutionDomainError('INSTITUTION_INVALID', 'id and name are required');
    if (this.store.institutions.has(id)) throw new InstitutionDomainError('INSTITUTION_EXISTS', 'institution already exists');
    const inst = { id, name, status: 'ACTIVE', createdBy: createdBy || null, createdAt: nowIso(), updatedAt: nowIso() };
    this.store.institutions.set(id, inst);
    this.store.owners.set(id, new Map());
    this._audit('INSTITUTION_CREATED', { institutionId: id, actorId: createdBy, outcome: 'SUCCESS' });
    return inst;
  }

  getInstitution(id) { return this.store.institutions.get(id) || null; }

  // --- Ownership ---
  addOwner({ institutionId, ownerId, verifiedBy, verificationState = 'VERIFIED' }) {
    const inst = this.getInstitution(institutionId);
    if (!inst) throw new InstitutionDomainError('INSTITUTION_NOT_FOUND', 'institution not found');
    if (!ownerId) throw new InstitutionDomainError('OWNER_INVALID', 'ownerId required');
    if (!OWNER_STATUSES.includes(verificationState)) throw new InstitutionDomainError('OWNER_STATE_INVALID', 'invalid verification state');
    const owners = this.store.owners.get(institutionId);
    if (owners.has(ownerId)) throw new InstitutionDomainError('OWNER_EXISTS', 'owner already exists');
    const owner = { ownerId, institutionId, status: verificationState, verifiedBy: verifiedBy || null, addedAt: nowIso(), revokedAt: null };
    owners.set(ownerId, owner);
    this._audit('OWNER_ADDED', { institutionId, actorId: verifiedBy, resourceId: ownerId, outcome: 'SUCCESS' });
    if (verificationState === 'VERIFIED') {
      this._audit('OWNER_VERIFIED', { institutionId, actorId: verifiedBy, resourceId: ownerId, outcome: 'SUCCESS' });
    }
    return owner;
  }

  revokeOwner({ institutionId, ownerId, revokedBy, reason }) {
    const owners = this.store.owners.get(institutionId);
    if (!owners || !owners.has(ownerId)) throw new InstitutionDomainError('OWNER_NOT_FOUND', 'owner not found');
    const owner = owners.get(ownerId);
    if (owner.status === 'REVOKED') throw new InstitutionDomainError('OWNER_ALREADY_REVOKED', 'owner already revoked');
    owner.status = 'REVOKED';
    owner.revokedAt = nowIso();
    owner.revokedBy = revokedBy || null;
    owner.revocationReason = reason || null;
    this._audit('OWNER_REVOKED', { institutionId, actorId: revokedBy, resourceId: ownerId, outcome: 'SUCCESS', reason });
    return owner;
  }

  getOwners(institutionId, { verifiedOnly = false } = {}) {
    const owners = this.store.owners.get(institutionId);
    if (!owners) return [];
    const list = [...owners.values()];
    return verifiedOnly ? list.filter((o) => o.status === 'VERIFIED') : list;
  }

  isVerifiedOwner(institutionId, ownerId) {
    const owners = this.store.owners.get(institutionId);
    if (!owners) return false;
    const o = owners.get(ownerId);
    return !!o && o.status === 'VERIFIED';
  }

  // --- Critical ownership change (four-eyes) ---
  requestOwnershipChange({ institutionId, targetOwnerId, changeType, requestedBy }) {
    const inst = this.getInstitution(institutionId);
    if (!inst) throw new InstitutionDomainError('INSTITUTION_NOT_FOUND', 'institution not found');
    if (!this.isVerifiedOwner(institutionId, requestedBy)) {
      throw new InstitutionDomainError('NOT_VERIFIED_OWNER', 'requester must be a verified owner');
    }
    const id = newId('ownreq');
    const req = { id, institutionId, targetOwnerId, changeType, requestedBy, status: 'PENDING', createdAt: nowIso(), approvals: new Map() };
    this.store.ownershipRequests.set(id, req);
    this._audit('OWNERSHIP_CHANGE_REQUESTED', { institutionId, actorId: requestedBy, resourceId: targetOwnerId, outcome: 'PENDING', ref: id });
    return req;
  }

  approveOwnershipChange({ requestId, approverId, decision }) {
    const req = this.store.ownershipRequests.get(requestId);
    if (!req) throw new InstitutionDomainError('REQUEST_NOT_FOUND', 'request not found');
    if (req.status !== 'PENDING') throw new InstitutionDomainError('REQUEST_NOT_PENDING', 'request is not pending');
    if (!this.isVerifiedOwner(req.institutionId, approverId)) {
      throw new InstitutionDomainError('NOT_VERIFIED_OWNER', 'approver must be a verified owner');
    }
    if (approverId === req.requestedBy) {
      throw new InstitutionDomainError('SELF_APPROVAL_FORBIDDEN', 'self-approval is forbidden for critical ownership changes');
    }
    // duplicate approval guard
    if (req.approvals.has(approverId)) {
      throw new InstitutionDomainError('DUPLICATE_APPROVAL', 'approver already decided');
    }
    const dec = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    req.approvals.set(approverId, { approverId, decision: dec, at: nowIso() });
    this._audit(dec === 'APPROVED' ? 'OWNERSHIP_CHANGE_APPROVED' : 'OWNERSHIP_CHANGE_REJECTED', {
      institutionId: req.institutionId, actorId: approverId, resourceId: req.targetOwnerId, outcome: dec, ref: requestId,
    });

    // Check if two distinct approvers approved
    const approvedCount = [...req.approvals.values()].filter((a) => a.decision === 'APPROVED').length;
    if (dec === 'REJECTED') {
      req.status = 'REJECTED';
    } else if (approvedCount >= 2) {
      req.status = 'APPROVED';
      // apply effect: revoke target owner if changeType is revoke
      if (req.changeType === 'REVOKE_OWNER') {
        try { this.revokeOwner({ institutionId: req.institutionId, ownerId: req.targetOwnerId, revokedBy: 'four-eyes', reason: `request ${requestId}` }); } catch (e) { /* already revoked */ }
      }
    }
    return req;
  }

  getOwnershipRequest(requestId) { return this.store.ownershipRequests.get(requestId) || null; }

  // --- Resource-to-institution binding ---
  bindResource({ resourceId, institutionId, boundBy, evidence }) {
    const inst = this.getInstitution(institutionId);
    if (!inst) throw new InstitutionDomainError('INSTITUTION_NOT_FOUND', 'institution not found');
    if (!resourceId) throw new InstitutionDomainError('RESOURCE_INVALID', 'resourceId required');
    const binding = { resourceId, institutionId, boundBy: boundBy || null, evidence: evidence || null, boundAt: nowIso() };
    this.store.resources.set(resourceId, binding);
    this._audit('RESOURCE_BOUND', { institutionId, actorId: boundBy, resourceId, outcome: 'SUCCESS' });
    return binding;
  }

  getResourceInstitution(resourceId) {
    const b = this.store.resources.get(resourceId);
    return b ? b.institutionId : null;
  }

  // --- Roles / permissions (institution-scoped) ---
  grantPermission({ institutionId, userId, permission, grantedBy }) {
    const inst = this.getInstitution(institutionId);
    if (!inst) throw new InstitutionDomainError('INSTITUTION_NOT_FOUND', 'institution not found');
    if (!userId || !permission) throw new InstitutionDomainError('GRANT_INVALID', 'userId and permission required');
    const key = `${institutionId}:${userId}`;
    if (!this.store.grants.has(key)) this.store.grants.set(key, new Set());
    this.store.grants.get(key).add(permission);
    this._audit('ROLE_GRANTED', { institutionId, actorId: grantedBy, resourceId: userId, permission, outcome: 'SUCCESS' });
    return { institutionId, userId, permission };
  }

  revokePermission({ institutionId, userId, permission, revokedBy }) {
    const key = `${institutionId}:${userId}`;
    const set = this.store.grants.get(key);
    if (set) set.delete(permission);
    this._audit('ROLE_REVOKED', { institutionId, actorId: revokedBy, resourceId: userId, permission, outcome: 'SUCCESS' });
    return { institutionId, userId, permission };
  }

  hasPermission({ institutionId, userId, permission, isGlobalAdmin = false }) {
    // global ADMIN is NOT a universal substitute for institution-scoped permission
    if (!institutionId || !userId || !permission) return false;
    const key = `${institutionId}:${userId}`;
    const set = this.store.grants.get(key);
    if (set && set.has(permission)) return true;
    return false;
  }

  // --- Actor-to-institution authorization (A: permission, B: resource binding) ---
  authorizeActorResource({ actorId, institutionId, permission, resourceId, isGlobalAdmin = false }) {
    if (!this.hasPermission({ institutionId, userId: actorId, permission, isGlobalAdmin })) {
      return { allowed: false, reason: 'MISSING_PERMISSION' };
    }
    const boundInst = this.getResourceInstitution(resourceId);
    if (boundInst === null) {
      return { allowed: false, reason: 'RESOURCE_UNBOUND' };
    }
    if (boundInst !== institutionId) {
      return { allowed: false, reason: 'CROSS_INSTITUTION' };
    }
    return { allowed: true, reason: 'OK' };
  }

  // --- Legacy campaign reconciliation ---
  // placeholder removed
  reconcileLegacyResource({ resourceId, candidateInstitutionId, evidence, status }) {
    const resolvedStatus = LEGACY_STATUSES.includes(status) ? status : 'UNRESOLVED';
    this.store.legacyReconciliation.set(resourceId, { resourceId, candidateInstitutionId: candidateInstitutionId || null, evidence: evidence || null, status: resolvedStatus });
    this._audit('LEGACY_RECONCILIATION', { institutionId: candidateInstitutionId, resourceId, outcome: resolvedStatus, evidence });
    return this.store.legacyReconciliation.get(resourceId);
  }

  getLegacyReconciliation(resourceId) { return this.store.legacyReconciliation.get(resourceId) || null; }

  // --- Audit ---
  _audit(event, data) {
    this.store.audit.push({ event, at: nowIso(), ...data });
  }

  getAuditTrail() { return this.store.audit.slice(); }
}

module.exports = {
  InstitutionDomain,
  InstitutionStore,
  InstitutionDomainError,
  INSTITUTION_STATUSES,
  OWNER_STATUSES,
  APPROVAL_STATUSES,
  LEGACY_STATUSES,
};
