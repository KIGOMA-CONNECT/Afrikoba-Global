const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const socialFund = require('../services/socialFundService');
const projectIntelligence = require('../services/projectIntelligenceService');

const router = express.Router();

router.use(authRequired);

// Social Fund / Msaada Cases
router.get('/cases', async (req, res, next) => {
  try {
    const cases = await socialFund.listCases(req.query.status || 'OPEN');
    res.json({ success: true, cases });
  } catch (err) { next(err); }
});

router.post('/cases', async (req, res, next) => {
  try {
    const c = await socialFund.createCase(req.user.id, req.body);
    res.json({ success: true, case: c });
  } catch (err) { next(err); }
});

router.get('/cases/:id', async (req, res, next) => {
  try {
    const details = await socialFund.getCaseDetails(parseInt(req.params.id, 10), req.user.id);
    res.json({ success: true, ...details });
  } catch (err) { next(err); }
});

router.post('/cases/:id/contribute', async (req, res, next) => {
  try {
    const { amount, is_anonymous } = req.body;
    const result = await socialFund.contribute(req.user.id, parseInt(req.params.id, 10), amount, is_anonymous);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/cases/:id/payout', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { recipient_phone, amount } = req.body;
    const payout = await socialFund.requestPayout(parseInt(req.params.id, 10), req.user.id, recipient_phone, amount);
    res.json({ success: true, payout });
  } catch (err) { next(err); }
});

// AI Project Decomposition & Waterfall
router.post('/projects/:id/decompose', async (req, res, next) => {
  try {
    const { project_name, total_budget } = req.body;
    const result = await projectIntelligence.decomposeProject(parseInt(req.params.id, 10), project_name, total_budget);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post('/projects/:id/waterfall', async (req, res, next) => {
  try {
    const { total_revenue, config } = req.body;
    const distribution = await projectIntelligence.calculateWaterfall(parseInt(req.params.id, 10), total_revenue, config);
    res.json({ success: true, distribution });
  } catch (err) { next(err); }
});

module.exports = router;
