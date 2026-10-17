const express = require('express');
const router = express.Router();
const { logAction } = require('../services/auditService');
const { authRequired } = require('../middleware/auth');
const { CAPABILITIES: CAP, requireGovernance } = require('../services/governanceAuthorizationService');
// Shared with saccosRoutes (G3): one definition of "the same route" for both
// governance surfaces. Requiring it here loads governanceResourceBindingService
// eagerly, which is safe — governanceAuthorizationService already pulls in
// ../config/db above.
const { matchRouteParams, patternMatches } = require('../services/governanceResourceBindingService');
const logger = require('../utils/logger');

const gov = () => require('../services/governanceEngineService');

// ============ G1 — AUTHENTICATION & AUTHORIZATION BOUNDARY ============
// Every request entering this router authenticates first, and then must be
// matched by the capability table below. The table IS the authorization
// matrix: a request that matches no entry is denied, so a route added later
// cannot ship group-open — it fails closed until its capability is declared.
//
// G1 authorizes only against the group context the request itself carries.
// Binding a resource id (meeting_id, proposal_id, resolution_id,
// execution_id, document_id, transcript_id, minutes_id, action_item_id,
// channel_id) to its group is a separate boundary enforced immediately below
// by the G2 layer.
//
// RESOLVED — G3 / Governance Consolidation: src/routes/saccosRoutes.js carries
// a second governance surface (/:id/governance/resolutions*, /:id/meetings*).
// Before G3 it did NOT go through this matrix: it was authorized inside
// saccosGovernanceService via requireActiveMember / assertActiveRole /
// assertMembershipCanAdminister, and it already bound a resource to its group
// in fetchResolution(saccosId, resolutionId). It therefore had authRequired
// and a working service-level authorization layer, and was not an open hole —
// but it was not fail-closed for future additions either, which is why it was
// deliberately left out of G1 rather than consolidated without security gain.
//
// G3 STATUS: DONE. That surface now runs the same architecture from
// src/routes/saccosRoutes.js (ROUTE_SACCOS_AUTHZ / ROUTE_SACCOS_RESOURCES +
// g3Authenticate / g3CapabilityLayer / g3BindingLayer), while its service-level
// assert*/requireActiveMember checks remain in place as defense in depth. The
// matrices live next to their routes; the shared matchers and the SACCOS
// resource resolvers live in governanceResourceBindingService.
//
// CAPABILITIES:
//   READ      any active member
//   WRITE     any active member (participate)
//   VOTE      any active member, never platform ADMIN
//   GOVERN    officer roles only (VICOBA: MWENYEKITI/MWEKAHAZINA/KATIBU,
//             SACCOS: OWNER/BOARD) + the one documented platform-admin
//             override
//   FINANCIAL officer/governing roles only, never platform ADMIN
const ROUTE_AUTHZ = [
  ['GET', '/meetings', CAP.READ],
  ['GET', '/meetings/:id', CAP.READ],
  ['POST', '/meetings', CAP.WRITE],
  ['POST', '/meetings/:id/status', CAP.GOVERN],
  ['POST', '/meetings/:id/rsvp', CAP.WRITE],
  ['POST', '/meetings/:id/attended', CAP.WRITE],
  ['POST', '/meetings/:id/agenda', CAP.WRITE],
  ['POST', '/meetings/:id/ai-minutes', CAP.WRITE],
  ['GET', '/channels', CAP.READ],
  ['GET', '/channels/:id/messages', CAP.READ],
  ['POST', '/channels/:id/messages', CAP.WRITE],
  ['GET', '/search', CAP.READ],
  ['GET', '/documents', CAP.READ],
  ['POST', '/documents', CAP.WRITE],
  ['PUT', '/documents/:id/access', CAP.GOVERN],
  ['PUT', '/transcripts/:id/access', CAP.GOVERN],
  ['GET', '/constitution', CAP.READ],
  ['POST', '/constitution', CAP.GOVERN],
  ['GET', '/proposals/:id/result', CAP.READ],
  ['POST', '/proposals', CAP.WRITE],
  ['POST', '/proposals/:id/vote', CAP.VOTE],
  ['GET', '/resolutions', CAP.READ],
  ['POST', '/resolutions', CAP.GOVERN],
  ['POST', '/resolutions/:id/amend', CAP.GOVERN],
  ['POST', '/resolutions/:id/trigger-loan', CAP.FINANCIAL],
  ['GET', '/action-items', CAP.READ],
  ['POST', '/action-items', CAP.WRITE],
  ['PUT', '/action-items/:id', CAP.WRITE],
  ['GET', '/minutes', CAP.READ],
  ['POST', '/minutes/:id/confirm', CAP.GOVERN],
  ['GET', '/financial-executions', CAP.READ],
  ['POST', '/financial-executions', CAP.FINANCIAL],
  ['POST', '/financial-executions/:id/executed', CAP.FINANCIAL],
  ['POST', '/financial-executions/:id/failed', CAP.FINANCIAL],
  ['GET', '/financial/audit-trail', CAP.READ],
  ['GET', '/access-grants', CAP.GOVERN],
  ['POST', '/access-grants', CAP.GOVERN],
  ['DELETE', '/access-grants/:id', CAP.GOVERN],
  ['GET', '/retention-policies', CAP.READ],
  ['POST', '/retention-policies', CAP.GOVERN],
  ['POST', '/can-view', CAP.READ],
  ['POST', '/analytics/compute', CAP.READ],
  ['GET', '/analytics', CAP.READ],
];

// ============ G2 — RESOURCE-TO-GROUP BINDING ============
//
// G1 above authorizes the ACTOR against a GROUP. This table authorizes the
// RESOURCE against its OWNING GROUP, and it is the second half of the same
// fail-closed idea: a route (or a descriptor) missing from this table cannot
// reach its handler, so a future addition ships denied rather than unbound.
//
// The authoritative group for a resource comes from the resource row — see
// governanceResourceBindingService. Nothing in the request body or query is
// allowed to name a different one, and `req.governance` (the G1-validated
// context) is what every comparison is made against.
//
// Descriptors:
//   from   'path' | 'body' | 'query' — where the id is read from
//   keys   accepted wire spellings, first present value wins
//   type   resource kind handed to the resolver
//   via    a companion key that says WHICH kind the id is (RECORD dispatch)
//   optional  the id may legitimately be absent (parent refs on creates,
//             filters on list routes); when it is present it is still bound,
//             and a half-supplied pair (id without kind) is denied outright
//
// Path descriptors are always required — the route would not have matched
// otherwise.
const P = (type) => ({ from: 'path', keys: ['id'], type });
const B = (type, keys) => ({ from: 'body', keys, type, optional: true });
const Q = (type, keys) => ({ from: 'query', keys, type, optional: true });
const REC = (from) => ({
  from,
  keys: ['record_id', 'recordId'],
  via: ['record_type', 'recordType'],
  type: 'RECORD',
  optional: true,
});
const REC_BODY = REC('body');
const REC_QUERY = REC('query');

const ROUTE_RESOURCES = [
  ['GET', '/meetings', []],
  ['GET', '/meetings/:id', [P('MEETING')]],
  ['POST', '/meetings', []],
  ['POST', '/meetings/:id/status', [P('MEETING')]],
  ['POST', '/meetings/:id/rsvp', [P('MEETING')]],
  ['POST', '/meetings/:id/attended', [P('MEETING')]],
  ['POST', '/meetings/:id/agenda', [P('MEETING')]],
  ['POST', '/meetings/:id/ai-minutes', [P('MEETING')]],
  ['GET', '/channels', []],
  ['GET', '/channels/:id/messages', [P('CHANNEL')]],
  ['POST', '/channels/:id/messages', [P('CHANNEL')]],
  ['GET', '/search', []],
  ['GET', '/documents', []],
  ['POST', '/documents', []],
  ['PUT', '/documents/:id/access', [P('DOCUMENT')]],
  ['PUT', '/transcripts/:id/access', [P('TRANSCRIPT')]],
  ['GET', '/constitution', []],
  ['POST', '/constitution', []],
  ['GET', '/proposals/:id/result', [P('PROPOSAL')]],
  ['POST', '/proposals', [B('MEETING', ['meetingId', 'meeting_id'])]],
  ['POST', '/proposals/:id/vote', [P('PROPOSAL')]],
  ['GET', '/resolutions', []],
  ['POST', '/resolutions', [
    B('PROPOSAL', ['proposalId', 'proposal_id']),
    B('MEETING', ['meetingId', 'meeting_id']),
  ]],
  ['POST', '/resolutions/:id/amend', [P('RESOLUTION')]],
  ['POST', '/resolutions/:id/trigger-loan', [P('RESOLUTION')]],
  ['GET', '/action-items', []],
  ['POST', '/action-items', [
    B('RESOLUTION', ['resolutionId', 'resolution_id']),
    B('MEETING', ['meetingId', 'meeting_id']),
  ]],
  ['PUT', '/action-items/:id', [P('ACTION_ITEM')]],
  ['GET', '/minutes', []],
  ['POST', '/minutes/:id/confirm', [P('MINUTES')]],
  ['GET', '/financial-executions', [Q('RESOLUTION', ['resolution_id', 'resolutionId'])]],
  ['POST', '/financial-executions', [B('RESOLUTION', ['resolutionId', 'resolution_id'])]],
  ['POST', '/financial-executions/:id/executed', [P('EXECUTION')]],
  ['POST', '/financial-executions/:id/failed', [P('EXECUTION')]],
  ['GET', '/financial/audit-trail', []],
  ['GET', '/access-grants', [REC_QUERY]],
  ['POST', '/access-grants', [REC_BODY]],
  ['DELETE', '/access-grants/:id', [P('ACCESS_GRANT')]],
  ['GET', '/retention-policies', []],
  ['POST', '/retention-policies', []],
  ['POST', '/can-view', [REC_BODY]],
  ['POST', '/analytics/compute', []],
  ['GET', '/analytics', []],
];

const AUTHZ_MIDDLEWARE = Object.values(CAP).reduce((acc, capability) => {
  acc[capability] = requireGovernance(capability);
  return acc;
}, {});

router.use(authRequired);
router.use((req, res, next) => {
  const method = req.method.toUpperCase();
  const path = req.path || '/';
  const hit = ROUTE_AUTHZ.find(([m, p]) => m === method && patternMatches(p, path));
  if (!hit) {
    return res.status(403).json({
      success: false,
      code: 'GOV_AUTHZ_UNREGISTERED',
      message: 'Huna ruhusa ya hatua hii.',
    });
  }
  const guard = AUTHZ_MIDDLEWARE[hit[2]];
  if (!guard) {
    return res.status(403).json({
      success: false,
      code: 'GOV_AUTHZ_UNREGISTERED',
      message: 'Huna ruhusa ya hatua hii.',
    });
  }
  return guard(req, res, next);
});

// G2 — runs after G1 has produced `req.governance` and before any handler.
// Nothing below this line can execute against a resource the context does not
// own, so a denial can never leave a partial mutation behind.
const rb = () => require('../services/governanceResourceBindingService');

router.use(async function resourceBindingLayer(req, res, next) {
  const method = req.method.toUpperCase();
  const path = req.path || '/';
  const hit = ROUTE_RESOURCES.find(([m, p]) => m === method && patternMatches(p, path));
  if (!hit) {
    return res.status(403).json({
      success: false,
      code: 'GOV_RESOURCE_UNREGISTERED',
      message: 'Huna ruhusa ya hatua hii.',
    });
  }

  const binding = rb();
  try {
    binding.assertRequestGroupConsistent(req.governance, req);

    const pathParams = matchRouteParams(hit[1], path) || {};
    for (const descriptor of hit[2]) {
      const source = descriptor.from === 'path'
        ? pathParams
        : descriptor.from === 'query' ? req.query : (req.body || {});

      let value = null;
      let present = false;
      for (const key of descriptor.keys) {
        const candidate = source[key];
        if (candidate !== undefined && candidate !== null && candidate !== '') {
          value = candidate;
          present = true;
          break;
        }
      }

      let recordType = null;
      let recordTypePresent = false;
      if (descriptor.via) {
        for (const key of descriptor.via) {
          const candidate = source[key];
          if (candidate !== undefined && candidate !== null && candidate !== '') {
            recordType = candidate;
            recordTypePresent = true;
            break;
          }
        }
      }

      // A half-supplied pair (an id without the kind that says what it is, or
      // the kind without an id) cannot be resolved, and treating it as absent
      // would silently skip the check it exists for. Deny it instead.
      if (descriptor.via && present !== recordTypePresent) {
        throw binding.denyMissingResourceParam(descriptor.type, `incomplete ${descriptor.from} pair`);
      }
      if (!present) {
        if (descriptor.optional) continue;
        throw binding.denyMissingResourceParam(descriptor.type, `${descriptor.from} required`);
      }

      // Deliberately sequential: each descriptor must be settled before the
      // next one is considered, and none of them may run after next().
      // eslint-disable-next-line no-await-in-loop
      await binding.assertResourceInContext(descriptor.type, value, req.governance, { recordType });
    }

    return next();
  } catch (err) {
    if (err && err.statusCode && err.code) {
      logger.warn('GOV_BIND_DENIED_HTTP', `method=${method} path=${path} code=${err.code} user=${req.user ? req.user.id : 'anon'}`);
      return res.status(err.statusCode).json({
        success: false,
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }
    return next(err);
  }
});

// ============ MEETINGS ============
router.get('/meetings', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id, status } = req.query;
    if (!group_id) return res.status(400).json({ success: false, error: 'group_id required' });
    const meetings = await gov().listMeetings(group_type, parseInt(group_id, 10), status);
    res.json({ success: true, meetings });
  } catch (error) { next(error); }
});

router.get('/meetings/:id', async (req, res, next) => {
  try {
    const details = await gov().getMeetingDetails(parseInt(req.params.id, 10));
    if (!details) return res.status(404).json({ success: false, error: 'Kikao hakipatikani' });
    res.json({ success: true, ...details });
  } catch (error) { next(error); }
});

router.post('/meetings', async (req, res, next) => {
  try {
    const result = await gov().createMeeting({ ...req.body, userId: req.user.id });
    await logAction(req.user.id, 'GOV_MEETING_CREATED', 'GOVERNANCE_MEETING', result.meeting.id, { group_id: req.body.group_id }, req);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/meetings/:id/status', async (req, res, next) => {
  try {
    const result = await gov().updateMeetingStatus(parseInt(req.params.id, 10), req.body.status);
    res.json({ success: true, meeting: result });
  } catch (error) { next(error); }
});

// ============ ATTENDANCE ============
router.post('/meetings/:id/rsvp', async (req, res, next) => {
  try {
    const result = await gov().respondAttendance(parseInt(req.params.id, 10), req.user.id, req.body.status);
    res.json({ success: true, attendee: result });
  } catch (error) { next(error); }
});

router.post('/meetings/:id/attended', async (req, res, next) => {
  try {
    const result = await gov().markAttended(parseInt(req.params.id, 10), req.user.id);
    res.json({ success: true, attendee: result });
  } catch (error) { next(error); }
});

// ============ AGENDA ============
router.post('/meetings/:id/agenda', async (req, res, next) => {
  try {
    const result = await gov().addAgendaItem(parseInt(req.params.id, 10), req.body);
    res.json({ success: true, item: result });
  } catch (error) { next(error); }
});

// ============ CHANNELS & CHAT ============
router.get('/channels', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id } = req.query;
    const channels = await gov().ensureDefaultChannels(group_type, parseInt(group_id, 10));
    res.json({ success: true, channels: channels.rows });
  } catch (error) { next(error); }
});

router.get('/channels/:id/messages', async (req, res, next) => {
  try {
    const messages = await gov().getChannelMessages(parseInt(req.params.id, 10));
    res.json({ success: true, messages });
  } catch (error) { next(error); }
});

router.post('/channels/:id/messages', async (req, res, next) => {
  try {
    const result = await gov().postChatMessage(parseInt(req.params.id, 10), req.user.id, req.body.body);
    res.json({ success: true, message: result });
  } catch (error) { next(error); }
});

router.get('/search', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id, q } = req.query;
    const results = await gov().searchKnowledge(group_type, parseInt(group_id, 10), q);
    res.json({ success: true, ...results });
  } catch (error) { next(error); }
});

// ============ DOCUMENTS (Knowledge Vault) ============
router.get('/documents', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id, doc_category } = req.query;
    const documents = await ac().listDocumentsForUser(group_type, parseInt(group_id, 10), req.user.id, doc_category);
    res.json({ success: true, documents });
  } catch (error) { next(error); }
});

router.post('/documents', async (req, res, next) => {
  try {
    const result = await gov().addDocument({ ...req.body, userId: req.user.id });
    res.json({ success: true, document: result });
  } catch (error) { next(error); }
});

// ============ CONSTITUTION ============
router.get('/constitution', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id } = req.query;
    const constitution = await gov().getConstitution(group_type, parseInt(group_id, 10));
    res.json({ success: true, constitution });
  } catch (error) { next(error); }
});

router.post('/constitution', async (req, res, next) => {
  try {
    const result = await gov().setConstitution(req.body.group_type || 'VICOBA', req.body.group_id, req.body.rules);
    res.json({ success: true, constitution: result });
  } catch (error) { next(error); }
});

// ============ PROPOSALS & VOTING ============
router.get('/proposals/:id/result', async (req, res, next) => {
  try {
    const result = await gov().getProposalResult(parseInt(req.params.id, 10));
    res.json({ success: true, result });
  } catch (error) { next(error); }
});

router.post('/proposals/:id/vote', async (req, res, next) => {
  try {
    const result = await gov().castVote(parseInt(req.params.id, 10), req.user.id, req.body.choice);
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

// ============ RESOLUTIONS ============
router.post('/resolutions', async (req, res, next) => {
  try {
    const result = await gov().passResolution(req.body);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/resolutions/:id/amend', async (req, res, next) => {
  try {
    const result = await gov().amendResolution(parseInt(req.params.id, 10), req.body);
    res.json({ success: true, resolution: result });
  } catch (error) { next(error); }
});

router.get('/resolutions', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id, category } = req.query;
    const resolutions = await gov().listResolutions(group_type, parseInt(group_id, 10), { category });
    res.json({ success: true, resolutions });
  } catch (error) { next(error); }
});

// ============ ACTION ITEMS ============
router.post('/action-items', async (req, res, next) => {
  try {
    const result = await gov().createActionItem(req.body);
    res.json({ success: true, actionItem: result });
  } catch (error) { next(error); }
});

router.put('/action-items/:id', async (req, res, next) => {
  try {
    const result = await gov().updateActionItem(parseInt(req.params.id, 10), req.body);
    res.json({ success: true, actionItem: result });
  } catch (error) { next(error); }
});

router.get('/action-items', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id, status } = req.query;
    const items = await gov().listActionItems(group_type, parseInt(group_id, 10), { status });
    res.json({ success: true, actionItems: items });
  } catch (error) { next(error); }
});

// ============ AI SECRETARY ============
router.post('/meetings/:id/ai-minutes', async (req, res, next) => {
  try {
    const result = await gov().generateDraftMinutes(parseInt(req.params.id, 10), req.body.transcript);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/minutes/:id/confirm', async (req, res, next) => {
  try {
    const result = await gov().confirmMinutes(parseInt(req.params.id, 10), req.body.official, req.user.id);
    res.json({ success: true, minutes: result });
  } catch (error) { next(error); }
});

router.get('/minutes', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id } = req.query;
    const minutes = await gov().listMinutesByGroup(group_type, parseInt(group_id, 10));
    res.json({ success: true, minutes });
  } catch (error) { next(error); }
});

// ============ GOVERNANCE → FINANCIAL LINKAGE ============
const gfl = () => require('../services/governanceFinancialLinkageService');

router.post('/financial-executions', async (req, res, next) => {
  try {
    const result = await gfl().createExecution({ ...req.body, governance: req.governance });
    await logAction(req.user.id, 'GOV_FIN_EXECUTION_CREATED', 'GOVERNANCE_RESOLUTION', req.body.resolution_id, { type: req.body.financial_action_type, amount: req.body.amount }, req);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/financial-executions/:id/executed', async (req, res, next) => {
  try {
    const result = await gfl().markExecuted(parseInt(req.params.id, 10), { ledgerReference: req.body.ledger_reference, executedByUserId: req.user.id, governance: req.governance });
    await logAction(req.user.id, 'GOV_FIN_EXECUTION_EXECUTED', 'GOVERNANCE_FINANCIAL_EXECUTION', parseInt(req.params.id, 10), { ledger_reference: req.body.ledger_reference }, req);
    res.json({ success: true, execution: result });
  } catch (error) { next(error); }
});

router.post('/financial-executions/:id/failed', async (req, res, next) => {
  try {
    const result = await gfl().markFailed(parseInt(req.params.id, 10), req.body.notes, req.governance);
    res.json({ success: true, execution: result });
  } catch (error) { next(error); }
});

router.get('/financial-executions', async (req, res, next) => {
  try {
    const { resolution_id, status } = req.query;
    const executions = await gfl().listExecutions({
      resolutionId: resolution_id ? parseInt(resolution_id, 10) : undefined,
      status,
      governance: req.governance,
    });
    res.json({ success: true, executions });
  } catch (error) { next(error); }
});

router.get('/financial/audit-trail', async (req, res, next) => {
  try {
    const trail = await gfl().getGovernanceAuditTrail(req.governance);
    res.json({ success: true, auditTrail: trail });
  } catch (error) { next(error); }
});

// ============ GOVERNANCE ACCESS CONTROL & RETENTION ============
const ac = () => require('../services/governanceAccessControlService');

// Document / transcript confidentiality + retention
router.put('/documents/:id/access', async (req, res, next) => {
  try {
    const result = await ac().updateDocumentAccess(parseInt(req.params.id, 10), req.body);
    await logAction(req.user.id, 'GOV_DOC_ACCESS_UPDATED', 'GOVERNANCE_DOCUMENT', parseInt(req.params.id, 10), { confidential: req.body.confidential }, req);
    res.json({ success: true, document: result });
  } catch (error) { next(error); }
});

router.put('/transcripts/:id/access', async (req, res, next) => {
  try {
    const result = await ac().updateTranscriptAccess(parseInt(req.params.id, 10), req.body);
    res.json({ success: true, transcript: result });
  } catch (error) { next(error); }
});

// Access grants (GRANT / DENY specific members or roles)
router.get('/access-grants', async (req, res, next) => {
  try {
    const { record_type, record_id } = req.query;
    const grants = await ac().listAccessGrants(record_type, parseInt(record_id, 10));
    res.json({ success: true, grants });
  } catch (error) { next(error); }
});

router.post('/access-grants', async (req, res, next) => {
  try {
    const result = await ac().addAccessGrant({ ...req.body, creatorUserId: req.user.id });
    await logAction(req.user.id, 'GOV_ACCESS_GRANT', req.body.record_type, req.body.record_id, { grant_type: req.body.grant_type, user_id: req.body.user_id, role: req.body.role }, req);
    res.json({ success: true, grant: result });
  } catch (error) { next(error); }
});

router.delete('/access-grants/:id', async (req, res, next) => {
  try {
    const result = await ac().removeAccessGrant(parseInt(req.params.id, 10));
    res.json(result);
  } catch (error) { next(error); }
});

// Retention policies
router.get('/retention-policies', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id } = req.query;
    const policies = await ac().listRetentionPolicies(group_type, parseInt(group_id, 10));
    res.json({ success: true, policies });
  } catch (error) { next(error); }
});

router.post('/retention-policies', async (req, res, next) => {
  try {
    const result = await ac().setRetentionPolicy(req.body);
    res.json({ success: true, policy: result });
  } catch (error) { next(error); }
});

// Permission check helper (for a member viewing a confidential record)
router.post('/can-view', async (req, res, next) => {
  try {
    const { record_type, record_id, confidential } = req.body;
    const { group_id } = req.body;
    const result = await ac().canView({ groupId: parseInt(group_id, 10), userId: req.user.id, recordType: record_type, recordId: parseInt(record_id, 10), recordConfidential: !!confidential });
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

// ============ SECRET BALLOT / ZERO-KNOWLEDGE VOTING ============
router.post('/proposals', async (req, res, next) => {
  try {
    const result = await gov().createProposal({ ...req.body, userId: req.user.id });
    res.json({ success: true, proposal: result, secretBallot: result.secret_ballot });
  } catch (error) { next(error); }
});

// ============ AUTO-TRIGGER VICOBA LOAN FROM RESOLUTION ============
router.post('/resolutions/:id/trigger-loan', async (req, res, next) => {
  try {
    const result = await gfl().triggerVicobaLoan({
      actorUserId: req.user.id,
      resolutionId: parseInt(req.params.id, 10),
      groupId: req.body.group_id,
      applicantUserId: req.body.applicant_user_id,
      amount: req.body.amount,
      interestRate: req.body.interest_rate,
      repaymentMonths: req.body.repayment_months,
      governance: req.governance,
    });
    await logAction(req.user.id, 'GOV_RESOLUTION_TRIGGERED_LOAN', 'GOVERNANCE_RESOLUTION', parseInt(req.params.id, 10), { ...req.body, ledger: result.ledgerReference }, req);
    res.json(result);
  } catch (error) { next(error); }
});

// ============ GOVERNANCE ANALYTICS ============
router.post('/analytics/compute', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id } = req.body;
    const analytics = await gov().computeGovernanceAnalytics(group_type, parseInt(group_id, 10));
    res.json({ success: true, analytics });
  } catch (error) { next(error); }
});

router.get('/analytics', async (req, res, next) => {
  try {
    const { group_type = 'VICOBA', group_id, days } = req.query;
    const analytics = await gov().computeGovernanceAnalytics(group_type, parseInt(group_id, 10));
    const trend = await gov().getAnalyticsTrend(group_type, parseInt(group_id, 10), days ? parseInt(days, 10) : 30);
    res.json({ success: true, analytics, trend });
  } catch (error) { next(error); }
});

// Exposed for tests: the capability matrix must stay in exact 1:1 correspondence
// with the routes defined above (a route with no entry is unreachable, an entry
// with no route is dead). The resource matrix is held to the same standard —
// it is exported alongside so a test can prove the two never drift apart.
router.ROUTE_AUTHZ = ROUTE_AUTHZ;
router.ROUTE_RESOURCES = ROUTE_RESOURCES;

module.exports = router;
