/**
 * Budgeting Routes
 * Mounted at /api/budget and /api/v1/budget
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const budget = require('../services/budgetService');

const router = express.Router();

router.get('/categories', authRequired, async (req, res, next) => {
  try { res.json({ success: true, categories: await budget.getCategories() }); }
  catch (e) { next(e); }
});

router.get('/overview', authRequired, async (req, res, next) => {
  try {
    res.json({ success: true, overview: await budget.getOverview(req.user.id, req.query.period) });
  } catch (e) { next(e); }
});

router.get('/', authRequired, async (req, res, next) => {
  try { res.json({ success: true, budgets: await budget.getBudgets(req.user.id, req.query.period) }); }
  catch (e) { next(e); }
});

router.post('/', authRequired, async (req, res, next) => {
  try { res.json({ success: true, budgets: await budget.setBudget(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.delete('/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, ...(await budget.deleteBudget(req.user.id, req.params.id)) }); }
  catch (e) { next(e); }
});

router.get('/alerts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, alerts: await budget.getAlerts(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/alerts/:id/ack', authRequired, async (req, res, next) => {
  try { res.json({ success: true, alert: await budget.ackAlert(req.user.id, req.params.id) }); }
  catch (e) { next(e); }
});

module.exports = router;
