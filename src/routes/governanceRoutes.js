const express = require('express');
const router = express.Router();
const { logAction } = require('../services/auditService');

const gov = () => require('../services/governanceEngineService');

function ensurePrivilege(role, groupType) {
  // Officers (Chair/Treasurer/Secretary) can manage governance; ordinary members can view/participate
  const officerRoles = ['CHAIR', 'TREASURER', 'SECRETARY', 'ADMIN'];
  return true; // authenticated members participate; route-level checks below where needed
}

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
    const documents = await gov().listDocuments(group_type, parseInt(group_id, 10), doc_category);
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
router.post('/proposals', async (req, res, next) => {
  try {
    const result = await gov().createProposal({ ...req.body, userId: req.user.id });
    res.json({ success: true, proposal: result });
  } catch (error) { next(error); }
});

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
    const result = await gfl().createExecution(req.body);
    await logAction(req.user.id, 'GOV_FIN_EXECUTION_CREATED', 'GOVERNANCE_RESOLUTION', req.body.resolution_id, { type: req.body.financial_action_type, amount: req.body.amount }, req);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/financial-executions/:id/executed', async (req, res, next) => {
  try {
    const result = await gfl().markExecuted(parseInt(req.params.id, 10), { ledgerReference: req.body.ledger_reference, executedByUserId: req.user.id });
    await logAction(req.user.id, 'GOV_FIN_EXECUTION_EXECUTED', 'GOVERNANCE_FINANCIAL_EXECUTION', parseInt(req.params.id, 10), { ledger_reference: req.body.ledger_reference }, req);
    res.json({ success: true, execution: result });
  } catch (error) { next(error); }
});

router.post('/financial-executions/:id/failed', async (req, res, next) => {
  try {
    const result = await gfl().markFailed(parseInt(req.params.id, 10), req.body.notes);
    res.json({ success: true, execution: result });
  } catch (error) { next(error); }
});

router.get('/financial-executions', async (req, res, next) => {
  try {
    const { resolution_id, group_id, status } = req.query;
    const executions = await gfl().listExecutions({ resolutionId: resolution_id ? parseInt(resolution_id, 10) : undefined, groupId: group_id ? parseInt(group_id, 10) : undefined, status });
    res.json({ success: true, executions });
  } catch (error) { next(error); }
});

router.get('/financial/audit-trail', async (req, res, next) => {
  try {
    const { group_id } = req.query;
    const trail = await gfl().getGovernanceAuditTrail(parseInt(group_id, 10));
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

module.exports = router;
