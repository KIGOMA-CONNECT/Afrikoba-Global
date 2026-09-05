const express = require('express');
const router = express.Router();
const { authRequired, requireRoles } = require('../middleware/auth');
const { logAction } = require('../services/auditService');
const exp = require('../services/experimentService');
const { requireFeature } = require('../services/featureFlagService');

// ===== Consumer API (works for any authenticated user) =====
router.post('/assign', authRequired, async (req, res, next) => {
  try {
    const result = await exp.assignVariant(req.user.id, req.body.experimentKey);
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

router.post('/track', authRequired, async (req, res, next) => {
  try {
    const result = await exp.trackEvent({
      userId: req.user.id,
      keyOrId: req.body.experimentKey,
      eventName: req.body.eventName,
      value: req.body.value,
      sessionId: req.body.sessionId || null,
    });
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

// ===== Admin API =====
const admin = express.Router();
admin.use(authRequired, requireRoles('ADMIN'));
admin.use(requireFeature('EXPERIMENTS'));

admin.get('/', async (req, res, next) => {
  try {
    res.json({ experiments: await exp.listExperiments(req.query.status || null, req.query.limit || 100) });
  } catch (error) { next(error); }
});

admin.post('/', async (req, res, next) => {
  try {
    const experiment = await exp.createExperiment(req.body, req.user.id);
    await logAction(req.user.id, 'EXPERIMENT_CREATED', 'EXPERIMENT', experiment.id, { key: experiment.key }, req);
    res.status(201).json({ experiment });
  } catch (error) { next(error); }
});

admin.get('/:key', async (req, res, next) => {
  try {
    res.json({ experiment: await exp.findExperiment(req.params.key) });
  } catch (error) { next(error); }
});

admin.put('/:key', async (req, res, next) => {
  try {
    const experiment = await exp.updateExperiment(req.params.key, req.body, req.user.id);
    await logAction(req.user.id, 'EXPERIMENT_UPDATED', 'EXPERIMENT', experiment.id, { key: experiment.key }, req);
    res.json({ experiment });
  } catch (error) { next(error); }
});

admin.post('/:key/start', async (req, res, next) => {
  try {
    const experiment = await exp.transition(req.params.key, 'RUNNING', req.user.id);
    await logAction(req.user.id, 'EXPERIMENT_STARTED', 'EXPERIMENT', experiment.id, {}, req);
    res.json({ experiment });
  } catch (error) { next(error); }
});

admin.post('/:key/pause', async (req, res, next) => {
  try {
    const experiment = await exp.transition(req.params.key, 'PAUSED', req.user.id);
    await logAction(req.user.id, 'EXPERIMENT_PAUSED', 'EXPERIMENT', experiment.id, {}, req);
    res.json({ experiment });
  } catch (error) { next(error); }
});

admin.post('/:key/stop', async (req, res, next) => {
  try {
    const experiment = await exp.transition(req.params.key, 'STOPPED', req.user.id);
    await logAction(req.user.id, 'EXPERIMENT_STOPPED', 'EXPERIMENT', experiment.id, {}, req);
    res.json({ experiment });
  } catch (error) { next(error); }
});

admin.get('/:key/report', async (req, res, next) => {
  try {
    res.json({ report: await exp.experimentReport(req.params.key) });
  } catch (error) { next(error); }
});

admin.get('/:key/assignments', async (req, res, next) => {
  try {
    res.json({ assignments: await exp.listAssignments(req.params.key, req.query.limit) });
  } catch (error) { next(error); }
});

admin.get('/:key/events', async (req, res, next) => {
  try {
    res.json({ events: await exp.listEvents(req.params.key, req.query.eventName || null, req.query.limit) });
  } catch (error) { next(error); }
});

router.use('/admin', admin);

module.exports = router;