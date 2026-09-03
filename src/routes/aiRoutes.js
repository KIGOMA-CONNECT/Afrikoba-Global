const express = require('express');
const aiService = require('../services/aiInsightService');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

router.get('/insights', async (req, res, next) => {
  try {
    const data = await aiService.getInsights(req.user.id);
    return res.json({ success: true, ...data });
  } catch (e) { next(e); }
});

router.post('/insights/refresh', async (req, res, next) => {
  try {
    const data = await aiService.refreshInsights(req.user.id);
    return res.json({ success: true, ...data });
  } catch (e) { next(e); }
});

router.post('/insights/:id/dismiss', async (req, res, next) => {
  try {
    const row = await aiService.dismissInsight(req.user.id, parseInt(req.params.id, 10));
    return res.json({ success: true, dismissed: row });
  } catch (e) { next(e); }
});

router.get('/cashflow', async (req, res, next) => {
  try {
    const months = parseInt(req.query.months, 10) || 3;
    const data = await aiService.cashflowForecast(req.user.id, months);
    return res.json({ success: true, ...data });
  } catch (e) { next(e); }
});

module.exports = router;
