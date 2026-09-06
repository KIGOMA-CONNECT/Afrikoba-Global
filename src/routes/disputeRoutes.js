const express = require('express');
const router = express.Router();
const { authRequired, requireRoles } = require('../middleware/auth');
const { logAction } = require('../services/auditService');
const ds = require('../services/disputeService');

// ===== Member workflows =====
router.get('/', authRequired, async (req, res, next) => {
  try {
    res.json({ disputes: await ds.getUserDisputes(req.user.id, req.query.status || null) });
  } catch (error) { next(error); }
});

router.post('/', authRequired, async (req, res, next) => {
  try {
    const { transaction_id, reason, description, amount_disputed: amount } = req.body;
    const dispute = await ds.createDispute(req.user.id, parseInt(transaction_id, 10), reason, description, amount);
    res.status(201).json({ success: true, dispute });
  } catch (error) { next(error); }
});

router.get('/:id', authRequired, async (req, res, next) => {
  try {
    const detail = await ds.getDisputeDetail(parseInt(req.params.id, 10));
    if (detail.user_id !== req.user.id) return res.status(403).json({ success: false, message: 'Huna mamlaka ya kufanya hili.' });
    res.json({ dispute: detail });
  } catch (error) { next(error); }
});

router.post('/:id/notes', authRequired, async (req, res, next) => {
  try {
    const detail = await ds.getDisputeDetail(parseInt(req.params.id, 10));
    if (detail.user_id !== req.user.id) return res.status(403).json({ success: false, message: 'Huna mamlaka ya kufanya hili.' });
    const dispute = await ds.addDisputeNote(detail.id, req.user.id, req.body.note);
    res.json({ dispute });
  } catch (error) { next(error); }
});

// ===== Reviewer (ADMIN / SUPPORT / COMPLIANCE) workbench =====
router.use('/admin', authRequired, requireRoles('ADMIN', 'SUPPORT', 'COMPLIANCE'));

router.get('/admin/all', async (req, res, next) => {
  try {
    const status = req.query.status || null;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    res.json({ disputes: await ds.getAllDisputes(status, limit, offset) });
  } catch (error) { next(error); }
});

router.get('/admin/stats', async (req, res, next) => {
  try {
    res.json(await ds.listDisputeStats());
  } catch (error) { next(error); }
});

router.get('/admin/:id', async (req, res, next) => {
  try {
    res.json({ dispute: await ds.getDisputeDetail(parseInt(req.params.id, 10)) });
  } catch (error) { next(error); }
});

router.post('/admin/:id/review', async (req, res, next) => {
  try {
    const dispute = await ds.startDisputeReview(parseInt(req.params.id, 10), req.user.id, req.body.note);
    await logAction(req.user.id, 'DISPUTE_REVIEW_STARTED', 'DISPUTE', dispute.id, {}, req);
    res.json({ dispute });
  } catch (error) { next(error); }
});

router.post('/admin/:id/escalate', async (req, res, next) => {
  try {
    const dispute = await ds.escalateDispute(parseInt(req.params.id, 10), req.user.id, req.body.note);
    await logAction(req.user.id, 'DISPUTE_ESCALATED', 'DISPUTE', dispute.id, {}, req);
    res.json({ dispute });
  } catch (error) { next(error); }
});

router.post('/admin/:id/decision', async (req, res, next) => {
  try {
    const dispute = await ds.decideDispute(parseInt(req.params.id, 10), req.user.id, { action: req.body.action, note: req.body.note, amount: req.body.amount });
    await logAction(req.user.id, 'DISPUTE_DECIDED', 'DISPUTE', dispute.id, { action: dispute.resolution_type }, req);
    res.json({ dispute });
  } catch (error) { next(error); }
});

router.post('/admin/:id/notes', async (req, res, next) => {
  try {
    const dispute = await ds.addDisputeNote(parseInt(req.params.id, 10), req.user.id, req.body.note);
    res.json({ dispute });
  } catch (error) { next(error); }
});

module.exports = router;