const express = require('express');
const router = express.Router();
const { authRequired, requireRoles } = require('../middleware/auth');
const { requireFeature } = require('../services/featureFlagService');
const { logAction } = require('../services/auditService');
const fraudOps = require('../services/fraudOpsService');
const fraudService = require('../services/fraudDetectionService');
const gov = require('../services/governanceService');

// Fraud Operations Centre — every route here is bundled under the
// FRAUD_OPS_DASHBOARD feature flag (kill-switch + rollout) as a live demo
// of the feature-flag framework.
router.use(authRequired);
router.use(requireRoles('ADMIN'));
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

module.exports = router;