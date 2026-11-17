'use strict';
const assert = require('assert');
const { InstitutionDomain, InstitutionDomainError } = require('../src/services/institutionService');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('✓ ' + name); passed++; }
  catch (e) { console.log('✗ ' + name + ' — ' + (e && e.message)); failed++; }
}

const d = new InstitutionDomain();
d.createInstitution({ id: 'inst-A', name: 'Institution A', createdBy: 1 });
d.createInstitution({ id: 'inst-B', name: 'Institution B', createdBy: 2 });
d.addOwner({ institutionId: 'inst-A', ownerId: 1, verifiedBy: 1, verificationState: 'VERIFIED' });

// institution creation
test('OD08-01 institution creation', () => {
  const i = d.getInstitution('inst-A');
  assert.ok(i && i.id === 'inst-A');
});

// owner verification + multiple owners
test('OD08-02 add verified owner', () => {
  const o = d.addOwner({ institutionId: 'inst-A', ownerId: 10, verifiedBy: 1, verificationState: 'VERIFIED' });
  assert.strictEqual(o.status, 'VERIFIED');
});
test('OD08-03 multiple owners supported', () => {
  d.addOwner({ institutionId: 'inst-A', ownerId: 11, verifiedBy: 1, verificationState: 'VERIFIED' });
  assert.ok(d.getOwners('inst-A', { verifiedOnly: true }).length >= 2);
});
test('OD08-04 owner revocation', () => {
  const o = d.revokeOwner({ institutionId: 'inst-A', ownerId: 11, revokedBy: 1, reason: 'test' });
  assert.strictEqual(o.status, 'REVOKED');
  assert.strictEqual(d.isVerifiedOwner('inst-A', 11), false);
});

// four-eyes critical ownership change
test('OD08-05 four-eyes request + two distinct approvers', () => {
  const req = d.requestOwnershipChange({ institutionId: 'inst-A', targetOwnerId: 10, changeType: 'REVOKE_OWNER', requestedBy: 1 });
  // need two distinct verified owners; add another
  d.addOwner({ institutionId: 'inst-A', ownerId: 12, verifiedBy: 1, verificationState: 'VERIFIED' });
  d.approveOwnershipChange({ requestId: req.id, approverId: 12, decision: 'APPROVE' });
  const r2 = d.approveOwnershipChange({ requestId: req.id, approverId: 10, decision: 'APPROVE' });
  // approver 10 is target owner but still verified owner; distinct from requester 1
  assert.strictEqual(r2.status, 'APPROVED');
});
test('OD08-06 self-approval rejected', () => {
  const req = d.requestOwnershipChange({ institutionId: 'inst-A', targetOwnerId: 10, changeType: 'REVOKE_OWNER', requestedBy: 1 });
  d.addOwner({ institutionId: 'inst-A', ownerId: 13, verifiedBy: 1, verificationState: 'VERIFIED' });
  assert.throws(() => d.approveOwnershipChange({ requestId: req.id, approverId: 1, decision: 'APPROVE' }), (e) => e.code === 'SELF_APPROVAL_FORBIDDEN');
});
test('OD08-07 duplicate approval rejected', () => {
  const req = d.requestOwnershipChange({ institutionId: 'inst-A', targetOwnerId: 10, changeType: 'REVOKE_OWNER', requestedBy: 1 });
  d.approveOwnershipChange({ requestId: req.id, approverId: 12, decision: 'APPROVE' });
  assert.throws(() => d.approveOwnershipChange({ requestId: req.id, approverId: 12, decision: 'APPROVE' }), (e) => e.code === 'DUPLICATE_APPROVAL');
});
test('OD08-08 rejected approval does not mutate', () => {
  const before = d.isVerifiedOwner('inst-A', 10);
  const req = d.requestOwnershipChange({ institutionId: 'inst-A', targetOwnerId: 10, changeType: 'REVOKE_OWNER', requestedBy: 1 });
  d.approveOwnershipChange({ requestId: req.id, approverId: 12, decision: 'REJECT' });
  assert.strictEqual(req.status, 'REJECTED');
  assert.strictEqual(d.isVerifiedOwner('inst-A', 10), before);
});

// role grants
test('OD08-09 explicit grant and revoke', () => {
  d.grantPermission({ institutionId: 'inst-A', userId: 5, permission: 'READ', grantedBy: 1 });
  assert.strictEqual(d.hasPermission({ institutionId: 'inst-A', userId: 5, permission: 'READ' }), true);
  d.revokePermission({ institutionId: 'inst-A', userId: 5, permission: 'READ', revokedBy: 1 });
  assert.strictEqual(d.hasPermission({ institutionId: 'inst-A', userId: 5, permission: 'READ' }), false);
});

// cross-institution denial
test('OD08-10 cross-institution access denied', () => {
  d.grantPermission({ institutionId: 'inst-A', userId: 5, permission: 'READ', grantedBy: 1 });
  const res = d.authorizeActorResource({ actorId: 5, institutionId: 'inst-B', permission: 'READ', resourceId: 'r1' });
  // resource unbound or cross-institution
  assert.strictEqual(res.allowed, false);
});
test('OD08-11 global ADMIN not substitute', () => {
  assert.strictEqual(d.hasPermission({ institutionId: 'inst-A', userId: 999, permission: 'READ', isGlobalAdmin: true }), false);
});
test('OD08-12 initiator without permission denied', () => {
  const r = d.authorizeActorResource({ actorId: 7, institutionId: 'inst-A', permission: 'READ', resourceId: 'r1' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'MISSING_PERMISSION');
});

// resource binding
test('OD08-13 resource bound to inst A inaccessible via inst B', () => {
  d.bindResource({ resourceId: 'res-1', institutionId: 'inst-A', boundBy: 1 });
  const r = d.authorizeActorResource({ actorId: 5, institutionId: 'inst-B', permission: 'READ', resourceId: 'res-1' });
  assert.strictEqual(r.allowed, false);
});
test('OD08-14 authorized actor permitted in correct institution', () => {
  d.bindResource({ resourceId: 'res-2', institutionId: 'inst-A', boundBy: 1 });
  d.grantPermission({ institutionId: 'inst-A', userId: 5, permission: 'READ', grantedBy: 1 });
  const r = d.authorizeActorResource({ actorId: 5, institutionId: 'inst-A', permission: 'READ', resourceId: 'res-2' });
  assert.strictEqual(r.allowed, true);
});

// legacy reconciliation unresolved preserved
test('OD08-15 legacy unresolved preserved', () => {
  const rec = d.reconcileLegacyResource({ resourceId: 'legacy-1', candidateInstitutionId: 'inst-A', evidence: 'none', resolved: false });
  assert.strictEqual(rec.status, 'UNRESOLVED');
  assert.strictEqual(d.getLegacyReconciliation('legacy-1').status, 'UNRESOLVED');
});

// audit trail
test('OD08-16 audit records critical events', () => {
  const trail = d.getAuditTrail();
  assert.ok(trail.some((e) => e.event === 'INSTITUTION_CREATED'));
  assert.ok(trail.some((e) => e.event === 'OWNER_ADDED'));
  assert.ok(trail.some((e) => e.event === 'ROLE_GRANTED'));
});

console.log('\\nOD-08 INSTITUTION DOMAIN TESTS: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
