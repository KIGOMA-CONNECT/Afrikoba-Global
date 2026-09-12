const express = require('express');
const router = express.Router();
const { authRequired, requireRoles } = require('../middleware/auth');
const { requireFeature } = require('../services/featureFlagService');
const { logAction } = require('../services/auditService');
const fraudOps = require('../services/fraudOpsService');
const fraudService = require('../services/fraudDetectionService');
const gov = require('../services/governanceService');
const freezes = require('../services/walletFreezesService');
const sanctions = require('../services/sanctionsService');

// Fraud Operations Centre — every route here is bundled under the
// FRAUD_OPS_DASHBOARD feature flag (kill-switch + rollout) as a live demo
// of the feature-flag framework.
router.use(authRequired);
router.use(requireRoles('ADMIN', 'COMPLIANCE'));
router.use(requireFeature('FRAUD_OPS_DASHBOARD'));

router.get('/dashboard', async (req, res, next) => {
  try {
    res.json({ dashboard: await fraudOps.getDashboard() });
  } catch (e) {
    next(e);
  }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const alerts = await fraudOps.queryAlerts({
      severity: req.query.severity || null,
      openOnly: req.query.open === undefined ? null : req.query.open === 'true',
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ alerts });
  } catch (e) {
    next(e);
  }
});

router.get('/cases', async (req, res, next) => {
  try {
    const cases = await fraudOps.queryCases({
      status: req.query.status || null,
      disposition: req.query.disposition || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ cases });
  } catch (e) {
    next(e);
  }
});

router.get('/cases/:id', async (req, res, next) => {
  try {
    res.json({ case: await gov.getAmlCase(req.params.id) });
  } catch (e) {
    next(e);
  }
});

router.get('/risk-profiles', async (req, res, next) => {
  try {
    res.json({ profiles: await fraudOps.listRiskProfiles(req.query.limit) });
  } catch (e) {
    next(e);
  }
});

router.post('/alerts/:id/resolve', async (req, res, next) => {
  try {
    const alert = await fraudService.resolveAlert(req.params.id, req.user.id);
    await logAction(req.user.id, 'FRAUD_ALERT_RESOLVE', 'FRAUD_ALERT', req.params.id, { }, req);
    res.json({ alert });
  } catch (e) {
    next(e);
  }
});

router.post('/cases', async (req, res, next) => {
  try {
    const { alertId, userId, caseType, riskLevel, summary, assignedTo } = req.body;
    const c = await gov.openAmlCase({
      alertId: alertId ? Number(alertId) : null,
      userId: userId ? Number(userId) : null,
      caseType,
      riskLevel,
      summary,
      assignedTo: assignedTo ? Number(assignedTo) : null,
      authorId: req.user.id,
    });
    await logAction(req.user.id, 'FRAUD_CASE_OPEN', 'AML_CASE', c.id, { case_type: c.case_type }, req);
    res.status(201).json({ case: c });
  } catch (e) {
    next(e);
  }
});

router.put('/cases/:id', async (req, res, next) => {
  try {
    const { status, assignedTo, riskLevel, disposition } = req.body;
    const c = await gov.updateAmlCase(Number(req.params.id), req.user.id, {
      status,
      assignedTo: assignedTo !== undefined ? Number(assignedTo) : undefined,
      riskLevel,
      disposition,
    });
    await logAction(req.user.id, 'FRAUD_CASE_UPDATE', 'AML_CASE', c.id, { status: c.status }, req);
    res.json({ case: c });
  } catch (e) {
    next(e);
  }
});

router.post('/cases/:id/notes', async (req, res, next) => {
  try {
    const note = await gov.addAmlNote(Number(req.params.id), req.user.id, req.body.note);
    await logAction(req.user.id, 'FRAUD_CASE_NOTE', 'AML_CASE', req.params.id, { }, req);
    res.status(201).json({ note });
  } catch (e) {
    next(e);
  }
});

// ---------- Wallet Freezes (AML compliance) ----------

router.get('/freezes', async (req, res, next) => {
  try {
    const list = await freezes.listFreezes({
      status: req.query.status || null,
      userId: req.query.userId ? Number(req.query.userId) : null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ freezes: list });
  } catch (e) { next(e); }
});

router.get('/freezes/:id', async (req, res, next) => {
  try {
    const freeze = await freezes.getFreeze(Number(req.params.id));
    res.json({ freeze });
  } catch (e) { next(e); }
});

router.post('/freezes', async (req, res, next) => {
  try {
    const { userId, reason, caseId } = req.body;
    const freeze = await freezes.freezeWallet(req.user.id, Number(userId), { reason, caseId: caseId ? Number(caseId) : null });
    res.status(201).json({ freeze });
  } catch (e) { next(e); }
});

router.post('/freezes/:id/lift', async (req, res, next) => {
  try {
    const freeze = await freezes.liftFreeze(req.user.id, Number(req.params.id), { comment: req.body.comment });
    res.json({ freeze });
  } catch (e) { next(e); }
});

// ---------- Sanctions / watchlist screening ----------

router.get('/sanctions', async (req, res, next) => {
  try {
    const list = await sanctions.listEntries({
      source: req.query.source || null,
      status: req.query.status || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ entries: list });
  } catch (e) { next(e); }
});

router.get('/sanctions/stats', async (req, res, next) => {
  try {
    res.json({ stats: await sanctions.getStats() });
  } catch (e) { next(e); }
});

router.get('/sanctions/hits', async (req, res, next) => {
  try {
    const list = await sanctions.listHits({
      disposition: req.query.disposition || null,
      subjectType: req.query.subjectType || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ hits: list });
  } catch (e) { next(e); }
});

router.get('/sanctions/:id', async (req, res, next) => {
  try {
    const entry = await sanctions.getEntry(Number(req.params.id));
    if (!entry) return res.status(404).json({ success: false, message: 'Ingizo halijapatikana.', code: 'SANCTIONS_ENTRY_NOT_FOUND' });
    res.json({ entry });
  } catch (e) { next(e); }
});

router.post('/sanctions', async (req, res, next) => {
  try {
    const { source, category, full_name, phone_number, document_type, document_number, country_code, birth_date, reference, notes } = req.body;
    if (!source || !full_name) return res.status(400).json({ success: false, message: 'Lazima uweke source na jina kamili.', code: 'SANCTIONS_SOURCE_REQUIRED' });
    const entry = await sanctions.addEntry({ source, category, full_name, phone_number, document_type, document_number, country_code, birth_date, reference, notes, createdBy: req.user.id });
    await logAction(req.user.id, 'SANCTIONS_ENTRY_CREATED', 'SANCTIONS_ENTRY', entry.id, { source, full_name }, req);
    res.status(201).json({ entry });
  } catch (e) { next(e); }
});

router.patch('/sanctions/:id', async (req, res, next) => {
  try {
    const entry = await sanctions.updateEntry(Number(req.params.id), req.body);
    await logAction(req.user.id, 'SANCTIONS_ENTRY_UPDATED', 'SANCTIONS_ENTRY', entry.id, {}, req);
    res.json({ entry });
  } catch (e) { next(e); }
});

router.post('/sanctions/:id/remove', async (req, res, next) => {
  try {
    const entry = await sanctions.updateEntry(Number(req.params.id), { status: 'REMOVED' });
    await logAction(req.user.id, 'SANCTIONS_ENTRY_REMOVED', 'SANCTIONS_ENTRY', entry.id, {}, req);
    res.json({ entry });
  } catch (e) { next(e); }
});

router.post('/sanctions/screen', async (req, res, next) => {
  try {
    const { name, phone, documentType, documentNumber } = req.body;
    const hits = await sanctions.screenSubject({ type: 'MANUAL', name, phone, documentType, documentNumber });
    res.json({ hits });
  } catch (e) { next(e); }
});

router.post('/sanctions/hits/:id', async (req, res, next) => {
  try {
    const { disposition, comment } = req.body;
    const hit = await sanctions.dispositionHit(Number(req.params.id), req.user.id, disposition, comment);
    res.json({ hit });
  } catch (e) { next(e); }
});

module.exports = router;