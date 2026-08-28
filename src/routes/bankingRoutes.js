/**
 * Banking Features Routes
 * Transaction limits, beneficiaries, disputes, savings, analytics, devices, sessions, fraud.
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const limitService = require('../services/limitService');
const beneficiaryService = require('../services/beneficiaryService');
const disputeService = require('../services/disputeService');
const savingsGoalService = require('../services/savingsGoalService');
const deviceService = require('../services/deviceService');
const fraudDetectionService = require('../services/fraudDetectionService');
const spendingAnalyticsService = require('../services/spendingAnalyticsService');

const router = express.Router();

// ===== B1: TRANSACTION LIMITS =====

router.get('/limits', authRequired, async (req, res, next) => {
  try {
    const limits = await limitService.getUserLimits(req.user.id);
    res.json({ success: true, limits });
  } catch (error) {
    next(error);
  }
});

router.get('/limits/check', authRequired, async (req, res, next) => {
  try {
    const { amount, type } = req.query;
    if (!amount) {
      return res.status(400).json({ success: false, message: 'Kiasi kinahitajika.' });
    }
    const result = await limitService.checkLimits(req.user.id, parseFloat(amount), type || 'ALL');
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// ===== B2: BENEFICIARIES =====

router.get('/beneficiaries', authRequired, async (req, res, next) => {
  try {
    const favorites = req.query.favorites === 'true';
    const beneficiaries = await beneficiaryService.getBeneficiaries(req.user.id, favorites);
    res.json({ success: true, beneficiaries });
  } catch (error) {
    next(error);
  }
});

router.post('/beneficiaries', authRequired, async (req, res, next) => {
  try {
    const { phone, name, nickname } = req.body;
    if (!phone || !name) {
      return res.status(400).json({ success: false, message: 'Simu na jina vinahitajika.' });
    }
    const beneficiary = await beneficiaryService.addBeneficiary(req.user.id, phone, name, nickname);
    res.json({ success: true, beneficiary });
  } catch (error) {
    next(error);
  }
});

router.put('/beneficiaries/:id', authRequired, async (req, res, next) => {
  try {
    const beneficiary = await beneficiaryService.updateBeneficiary(req.user.id, parseInt(req.params.id), req.body);
    if (!beneficiary) {
      return res.status(404).json({ success: false, message: 'Mpokeaji haupatikani.' });
    }
    res.json({ success: true, beneficiary });
  } catch (error) {
    next(error);
  }
});

router.delete('/beneficiaries/:id', authRequired, async (req, res, next) => {
  try {
    const deleted = await beneficiaryService.deleteBeneficiary(req.user.id, parseInt(req.params.id));
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Mpokeaji haupatikani.' });
    }
    res.json({ success: true, message: 'Mpokeaji amefutwa.' });
  } catch (error) {
    next(error);
  }
});

// ===== B3: DISPUTES =====

router.get('/disputes', authRequired, async (req, res, next) => {
  try {
    const disputes = await disputeService.getUserDisputes(req.user.id, req.query.status);
    res.json({ success: true, disputes });
  } catch (error) {
    next(error);
  }
});

router.post('/disputes', authRequired, async (req, res, next) => {
  try {
    const { transaction_id, reason, description, amount } = req.body;
    if (!transaction_id || !reason || !description) {
      return res.status(400).json({ success: false, message: 'Taarifa zote zinahitajika.' });
    }
    const dispute = await disputeService.createDispute(req.user.id, transaction_id, reason, description, amount);
    res.json({ success: true, dispute });
  } catch (error) {
    next(error);
  }
});

// ===== B4: SAVINGS GOALS =====

router.get('/savings/goals', authRequired, async (req, res, next) => {
  try {
    const goals = await savingsGoalService.getGoals(req.user.id);
    res.json({ success: true, goals });
  } catch (error) {
    next(error);
  }
});

router.get('/savings/summary', authRequired, async (req, res, next) => {
  try {
    const summary = await savingsGoalService.getSummary(req.user.id);
    res.json({ success: true, summary });
  } catch (error) {
    next(error);
  }
});

router.post('/savings/goals', authRequired, async (req, res, next) => {
  try {
    const { name, target_amount, deadline, icon, color, auto_save_amount, auto_save_frequency } = req.body;
    if (!name || !target_amount) {
      return res.status(400).json({ success: false, message: 'Jina na kikomo vinahitajika.' });
    }
    const goal = await savingsGoalService.createGoal(req.user.id, req.body);
    res.json({ success: true, goal });
  } catch (error) {
    next(error);
  }
});

router.post('/savings/goals/:id/deposit', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Kiasi hakikishi.' });
    }
    const result = await savingsGoalService.deposit(req.user.id, parseInt(req.params.id), parseFloat(amount));
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post('/savings/goals/:id/withdraw', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Kiasi hakikishi.' });
    }
    const goal = await savingsGoalService.withdraw(req.user.id, parseInt(req.params.id), parseFloat(amount));
    res.json({ success: true, goal });
  } catch (error) {
    next(error);
  }
});

// ===== B7: DEVICE MANAGEMENT =====

router.get('/devices', authRequired, async (req, res, next) => {
  try {
    const devices = await deviceService.getTrustedDevices(req.user.id);
    res.json({ success: true, devices });
  } catch (error) {
    next(error);
  }
});

router.post('/devices/trust', authRequired, async (req, res, next) => {
  try {
    const device = await deviceService.registerDevice(req.user.id, req, req.body.name);
    res.json({ success: true, device });
  } catch (error) {
    next(error);
  }
});

router.delete('/devices/:id', authRequired, async (req, res, next) => {
  try {
    const removed = await deviceService.removeDevice(req.user.id, parseInt(req.params.id));
    if (!removed) {
      return res.status(404).json({ success: false, message: 'Kifaa haipatikani.' });
    }
    res.json({ success: true, message: 'Kifaa kimeondolewa.' });
  } catch (error) {
    next(error);
  }
});

// ===== B8: SESSION MANAGEMENT =====

router.get('/sessions', authRequired, async (req, res, next) => {
  try {
    const sessions = await deviceService.getActiveSessions(req.user.id);
    res.json({ success: true, sessions });
  } catch (error) {
    next(error);
  }
});

router.delete('/sessions/:id', authRequired, async (req, res, next) => {
  try {
    const terminated = await deviceService.terminateSession(req.user.id, parseInt(req.params.id));
    if (!terminated) {
      return res.status(404).json({ success: false, message: 'Session haipatikani.' });
    }
    res.json({ success: true, message: 'Session imekamilishwa.' });
  } catch (error) {
    next(error);
  }
});

router.delete('/sessions', authRequired, async (req, res, next) => {
  try {
    const count = await deviceService.terminateAllSessions(req.user.id);
    res.json({ success: true, message: `Sessions ${count} zimekamilishwa.` });
  } catch (error) {
    next(error);
  }
});

// ===== B9: FRAUD ALERTS =====

router.get('/fraud/alerts', authRequired, async (req, res, next) => {
  try {
    const alerts = await fraudDetectionService.getUserAlerts(req.user.id, req.query.resolved === 'true');
    res.json({ success: true, alerts });
  } catch (error) {
    next(error);
  }
});

// ===== B10: SPENDING ANALYTICS =====

router.get('/analytics/spending', authRequired, async (req, res, next) => {
  try {
    const byCategory = await spendingAnalyticsService.getByCategory(req.user.id, req.query.period);
    res.json({ success: true, byCategory });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics/trend', authRequired, async (req, res, next) => {
  try {
    const trend = await spendingAnalyticsService.getMonthlyTrend(req.user.id, parseInt(req.query.months) || 6);
    res.json({ success: true, trend });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics/daily', authRequired, async (req, res, next) => {
  try {
    const daily = await spendingAnalyticsService.getDailySpending(req.user.id);
    res.json({ success: true, daily });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics/top-recipients', authRequired, async (req, res, next) => {
  try {
    const recipients = await spendingAnalyticsService.getTopRecipients(req.user.id, parseInt(req.query.limit) || 5);
    res.json({ success: true, recipients });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics/health', authRequired, async (req, res, next) => {
  try {
    const health = await spendingAnalyticsService.getHealthSummary(req.user.id);
    res.json({ success: true, health });
  } catch (error) {
    next(error);
  }
});

router.get('/analytics/averages', authRequired, async (req, res, next) => {
  try {
    const averages = await spendingAnalyticsService.getAverageTransaction(req.user.id, req.query.period);
    res.json({ success: true, averages });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
