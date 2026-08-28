/**
 * Smart Features Routes
 * Alerts, debts, rewards, subscriptions, calendar, business, tips.
 */

const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const smartAlertService = require('../services/smartAlertService');
const debtService = require('../services/debtService');
const rewardService = require('../services/rewardService');
const subscriptionService = require('../services/subscriptionService');
const calendarService = require('../services/calendarService');
const businessService = require('../services/businessService');
const tipsService = require('../services/tipsService');

const router = express.Router();

// ===== D1: SMART ALERTS =====

router.get('/alerts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, alerts: await smartAlertService.getAlerts(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/alerts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, alert: await smartAlertService.createAlert(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.put('/alerts/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, alert: await smartAlertService.updateAlert(req.user.id, parseInt(req.params.id), req.body) }); }
  catch (e) { next(e); }
});

router.delete('/alerts/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deleted: await smartAlertService.deleteAlert(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// ===== D2: DEBT TRACKER =====

router.get('/debts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, debts: await debtService.getDebts(req.user.id, req.query.direction, req.query.status) }); }
  catch (e) { next(e); }
});

router.get('/debts/summary', authRequired, async (req, res, next) => {
  try { res.json({ success: true, summary: await debtService.getDebtSummary(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/debts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, debt: await debtService.createDebt(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.post('/debts/:id/pay', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    res.json({ success: true, debt: await debtService.recordPayment(parseInt(req.params.id), req.user.id, parseFloat(amount)) });
  } catch (e) { next(e); }
});

router.post('/debts/:id/write-off', authRequired, async (req, res, next) => {
  try { res.json({ success: true, debt: await debtService.writeOff(parseInt(req.params.id), req.user.id) }); }
  catch (e) { next(e); }
});

router.delete('/debts/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deleted: await debtService.deleteDebt(parseInt(req.params.id), req.user.id) }); }
  catch (e) { next(e); }
});

// ===== D3: REWARDS =====

router.get('/rewards', authRequired, async (req, res, next) => {
  try { res.json({ success: true, rewards: await rewardService.getRewardsSummary(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/rewards/redeem', authRequired, async (req, res, next) => {
  try {
    const { points, description } = req.body;
    res.json({ success: true, result: await rewardService.redeemPoints(req.user.id, parseInt(points), description) });
  } catch (e) { next(e); }
});

// ===== D4: SUBSCRIPTIONS =====

router.get('/subscriptions', authRequired, async (req, res, next) => {
  try { res.json({ success: true, subscriptions: await subscriptionService.getSubscriptions(req.user.id) }); }
  catch (e) { next(e); }
});

router.get('/subscriptions/summary', authRequired, async (req, res, next) => {
  try { res.json({ success: true, summary: await subscriptionService.getSubscriptionSummary(req.user.id) }); }
  catch (e) { next(e); }
});

router.get('/subscriptions/due-soon', authRequired, async (req, res, next) => {
  try { res.json({ success: true, due: await subscriptionService.getDueSoon(req.user.id, parseInt(req.query.days) || 7) }); }
  catch (e) { next(e); }
});

router.post('/subscriptions', authRequired, async (req, res, next) => {
  try { res.json({ success: true, subscription: await subscriptionService.createSubscription(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.put('/subscriptions/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, subscription: await subscriptionService.updateSubscription(req.user.id, parseInt(req.params.id), req.body) }); }
  catch (e) { next(e); }
});

router.delete('/subscriptions/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deleted: await subscriptionService.deleteSubscription(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// ===== D5: FINANCIAL CALENDAR =====

router.get('/calendar', authRequired, async (req, res, next) => {
  try { res.json({ success: true, events: await calendarService.getEvents(req.user.id, parseInt(req.query.month), parseInt(req.query.year)) }); }
  catch (e) { next(e); }
});

router.get('/calendar/upcoming', authRequired, async (req, res, next) => {
  try { res.json({ success: true, events: await calendarService.getUpcoming(req.user.id, parseInt(req.query.days) || 30) }); }
  catch (e) { next(e); }
});

router.post('/calendar', authRequired, async (req, res, next) => {
  try { res.json({ success: true, event: await calendarService.createEvent(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.put('/calendar/:id/complete', authRequired, async (req, res, next) => {
  try { res.json({ success: true, event: await calendarService.completeEvent(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

router.delete('/calendar/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deleted: await calendarService.deleteEvent(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// ===== D8: BUSINESS ACCOUNTS =====

router.get('/business', authRequired, async (req, res, next) => {
  try { res.json({ success: true, businesses: await businessService.getBusinesses(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/business', authRequired, async (req, res, next) => {
  try { res.json({ success: true, business: await businessService.createBusiness(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/business/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, business: await businessService.getBusinessDetail(parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

router.get('/business/:id/members', authRequired, async (req, res, next) => {
  try { res.json({ success: true, members: await businessService.getMembers(parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

router.post('/business/:id/members', authRequired, async (req, res, next) => {
  try { res.json({ success: true, member: await businessService.inviteMember(parseInt(req.params.id), req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.delete('/business/:id/members/:userId', authRequired, async (req, res, next) => {
  try { res.json({ success: true, removed: await businessService.removeMember(parseInt(req.params.id), req.user.id, parseInt(req.params.userId)) }); }
  catch (e) { next(e); }
});

router.get('/business/:id/audit', authRequired, async (req, res, next) => {
  try { res.json({ success: true, log: await businessService.getAuditLog(parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// ===== D10: FINANCIAL TIPS =====

router.get('/tips', async (req, res, next) => {
  try {
    const tips = await tipsService.getTips(req.query.category, req.query.lang || 'sw', parseInt(req.query.limit) || 5);
    res.json({ success: true, tips });
  } catch (e) { next(e); }
});

router.get('/tips/categories', async (req, res, next) => {
  try { res.json({ success: true, categories: await tipsService.getTipCategories() }); }
  catch (e) { next(e); }
});

router.post('/tips/:id/view', async (req, res, next) => {
  try { await tipsService.trackDisplay(parseInt(req.params.id)); res.json({ success: true }); }
  catch (e) { next(e); }
});

module.exports = router;
