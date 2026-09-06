const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const outbox = require('../services/outboxService');

const router = express.Router();

// ===== Transaction-aware outbox / event-bus admin =====

// Stats kwa status (PENDING / DELIVERED / FAILED / DEAD)
router.get('/stats', authRequired, requireRoles('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json({ success: true, stats: await outbox.getOutboxStats() });
  } catch (e) { next(e); }
});

// Chambua PENDING zilizofikia next_attempt_at
router.post('/dispatch', authRequired, requireRoles('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const batchSize = req.body && req.body.batchSize ? parseInt(req.body.batchSize, 10) : 20;
    res.json({ success: true, result: await outbox.dispatchOutbox({ batchSize }) });
  } catch (e) { next(e); }
});

// Orodhesha PENDING (debug / monitoring)
router.get('/pending', authRequired, requireRoles('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json({ success: true, events: await outbox.listPending(parseInt(req.query.limit || '50', 10), req.query.status || 'PENDING') });
  } catch (e) { next(e); }
});

// Re-queue DEAD events
router.post('/dead/requeue', authRequired, requireRoles('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    res.json({ success: true, result: await outbox.requeueDead() });
  } catch (e) { next(e); }
});

module.exports = router;