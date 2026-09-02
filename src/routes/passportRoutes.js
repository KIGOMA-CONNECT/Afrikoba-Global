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

module.exports = router;
