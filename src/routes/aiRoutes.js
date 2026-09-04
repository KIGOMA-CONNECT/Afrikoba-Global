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

// ===== AI RISK ENGINE =====
router.post('/risk/evaluate', async (req, res, next) => {
  try {
    const riskService = require('../services/aiRiskRecommendationService');
    const result = await riskService.evaluateRisk(req.user.id);
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/risk', async (req, res, next) => {
  try {
    const riskService = require('../services/aiRiskRecommendationService');
    const assessment = await riskService.getLatestRisk(req.user.id);
    res.json({ success: true, assessment });
  } catch (error) { next(error); }
});

// ===== AI RECOMMENDATION ENGINE =====
router.get('/recommendations', async (req, res, next) => {
  try {
    const riskService = require('../services/aiRiskRecommendationService');
    const recommendations = await riskService.getActiveRecommendations(req.user.id);
    res.json({ success: true, recommendations });
  } catch (error) { next(error); }
});

router.post('/recommendations/:id/dismiss', async (req, res, next) => {
  try {
    const riskService = require('../services/aiRiskRecommendationService');
    const result = await riskService.dismissRecommendation(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true, recommendation: result });
  } catch (error) { next(error); }
});

// ===== AI CONFIDENCE / EXPLAINABILITY =====
router.get('/explanations', async (req, res, next) => {
  try {
    const riskService = require('../services/aiRiskRecommendationService');
    const explanations = await riskService.getExplanations(req.user.id, req.query.decision_type);
    res.json({ success: true, explanations });
  } catch (error) { next(error); }
});

module.exports = router;
