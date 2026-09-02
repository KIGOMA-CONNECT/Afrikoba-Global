/**
 * FINANCIAL PASSPORT & AUTOPILOT ROUTES
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const passportService = require('../services/financialPassportService');
const autopilotService = require('../services/financialAutopilotService');

const router = express.Router();

/**
 * GET /passport
 * Retrieve the current Financial Passport snapshot.
 */
router.get('/', authRequired, async (req, res, next) => {
  try {
    const passport = await passportService.getPassport(req.user.id);
    res.json({ success: true, passport });
  } catch (error) { next(error); }
});

/**
 * POST /passport/recalculate
 * Force a recalculation and version bump of the Financial Passport.
 */
router.post('/recalculate', authRequired, async (req, res, next) => {
  try {
    const passport = await passportService.calculatePassport(req.user.id, 'passport:user_request');
    res.json({ success: true, passport });
  } catch (error) { next(error); }
});

/**
 * GET /passport/autopilot
 * Retrieve a financial plan/autopilot recommendation.
 */
router.get('/autopilot', authRequired, async (req, res, next) => {
  try {
    const { target_amount, emergency_months } = req.query;
    const plan = await autopilotService.buildPlanForUser(req.user.id, {
      targetAmount: target_amount ? parseFloat(target_amount) : null,
      emergencyMonths: emergency_months ? parseInt(emergency_months) : null
    });
    res.json({ success: true, plan });
  } catch (error) { next(error); }
});

/**
 * POST /passport/autopilot/plans  - activate an auto-executed savings plan
 * Body: { target_amount, goal_id?, frequency? }
 */
router.post('/autopilot/plans', authRequired, async (req, res, next) => {
  try {
    const result = await autopilotService.activatePlan(req.user.id, req.body);
    res.status(201).json({ success: true, ...result });
  } catch (error) { next(error); }
});

/** GET /passport/autopilot/plans  - list user's plans */
router.get('/autopilot/plans', authRequired, async (req, res, next) => {
  try {
    const plans = await autopilotService.listPlans(req.user.id);
    res.json({ success: true, plans });
  } catch (error) { next(error); }
});

/** PATCH /passport/autopilot/plans/:id  - { status: ACTIVE|PAUSED|COMPLETED } */
router.patch('/autopilot/plans/:id', authRequired, async (req, res, next) => {
  try {
    const result = await autopilotService.setPlanStatus(req.user.id, parseInt(req.params.id, 10), req.body?.status);
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

/** DELETE /passport/autopilot/plans/:id */
router.delete('/autopilot/plans/:id', authRequired, async (req, res, next) => {
  try {
    const result = await autopilotService.deletePlan(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

module.exports = router;
