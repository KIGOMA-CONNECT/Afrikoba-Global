const express = require('express');
const router = express.Router();
const { authRequired, requireRoles } = require('../middleware/auth');
const { logAction } = require('../services/auditService');
const ff = require('../services/featureFlagService');

// Frontend gating: evaluate flags for the authenticated user.
router.get('/', authRequired, async (req, res, next) => {
  try {
    const keys = await ff.listKeys();
    const flags = [];
    for (const key of keys) {
      flags.push({ flagKey: key, enabled: await ff.isEnabled(key, req.user, { source: 'list' }) });
    }
    res.json({ flags });
  } catch (e) {
    next(e);
  }
});

router.post('/evaluate', authRequired, async (req, res, next) => {
  try {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
    const evaluations = {};
    for (const key of keys) {
      evaluations[key] = await ff.isEnabled(key, req.user, { source: 'evaluate' });
    }
    res.json({ evaluations });
  } catch (e) {
    next(e);
  }
});

const admin = express.Router();
admin.use(authRequired, requireRoles('ADMIN'));

admin.get('/', async (req, res, next) => {
  try {
    res.json({ flags: await ff.listFlags() });
  } catch (e) {
    next(e);
  }
});

admin.post('/', async (req, res, next) => {
  try {
    const flag = await ff.createFlag(req.body, req.user.id);
    await logAction(req.user.id, 'FEATURE_FLAG_CREATE', 'FEATURE_FLAG', flag.id, { flag_key: flag.flag_key }, req);
    res.status(201).json({ flag });
  } catch (e) {
    next(e);
  }
});

admin.put('/:flagKey', async (req, res, next) => {
  try {
    const flag = await ff.updateFlag(req.params.flagKey, req.body);
    await logAction(req.user.id, 'FEATURE_FLAG_UPDATE', 'FEATURE_FLAG', flag.id, { flag_key: flag.flag_key }, req);
    res.json({ flag });
  } catch (e) {
    next(e);
  }
});

admin.delete('/:flagKey', async (req, res, next) => {
  try {
    const flag = await ff.deleteFlag(req.params.flagKey);
    await logAction(req.user.id, 'FEATURE_FLAG_DELETE', 'FEATURE_FLAG', flag.id, { flag_key: flag.flag_key }, req);
    res.json({ flag });
  } catch (e) {
    next(e);
  }
});

admin.get('/:flagKey/analytics', async (req, res, next) => {
  try {
    res.json({ analytics: await ff.flagAnalytics(req.params.flagKey) });
  } catch (e) {
    next(e);
  }
});

admin.get('/:flagKey/evaluations', async (req, res, next) => {
  try {
    res.json({ evaluations: await ff.listEvaluations(req.params.flagKey, req.query.limit) });
  } catch (e) {
    next(e);
  }
});

router.use('/admin', admin);

module.exports = router;