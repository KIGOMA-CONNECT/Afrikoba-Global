/**
 * Savings Routes (I1-I3)
 * Mounted at /api/v1/savings and /api/savings
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const savings = require('../services/savingsCreditService');

const router = express.Router();

// ===== I1: SAVINGS GOALS =====
router.post('/goals', authRequired, async (req, res, next) => {
  try { res.json({ success: true, goal: await savings.createSavingsGoal(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/goals', authRequired, async (req, res, next) => {
  try { res.json({ success: true, goals: await savings.listGoals(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/goals/:id/contribute', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await savings.contributeGoal(req.user.id, req.params.id, req.body.amount) }); }
  catch (e) { next(e); }
});

// ===== I2: AUTO-SAVE RULES =====
router.post('/goals/:id/auto-save', authRequired, async (req, res, next) => {
  try { res.json({ success: true, rule: await savings.createAutoSaveRule(req.user.id, req.params.id, req.body) }); }
  catch (e) { next(e); }
});

router.post('/auto-save/run', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await savings.runAutoSave(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== I3: FIXED DEPOSITS =====
router.post('/deposits', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deposit: await savings.createFixedDeposit(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/deposits', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deposits: await savings.listFixedDeposits(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/deposits/:id/withdraw', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await savings.withdrawFixedDeposit(req.user.id, req.params.id, req.body) }); }
  catch (e) { next(e); }
});

// ===== I-SUMMARY =====
router.get('/summary', authRequired, async (req, res, next) => {
  try { res.json({ success: true, summary: await savings.savingsSummary(req.user.id) }); }
  catch (e) { next(e); }
});

module.exports = router;