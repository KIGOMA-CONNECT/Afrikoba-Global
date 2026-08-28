/**
 * Network & Ecosystem Expansion Routes
 * F1: Agent network | F2: Bulk payments | F3: Scheduled payments
 * F4: Cross-border remittances | F5: Webhooks | F6: Merchant loyalty
 * F7: AI insights | F8: Enhanced referrals
 */

const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const networkService = require('../services/networkService');

const router = express.Router();

// ===== F1: AGENT NETWORK =====
router.post('/agents/apply', authRequired, async (req, res, next) => {
  try { res.json({ success: true, agent: await networkService.applyAgent(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/agents', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, agents: await networkService.listAgents(req.query) }); }
  catch (e) { next(e); }
});
router.get('/agents/nearby', authRequired, async (req, res, next) => {
  try {
    const { lat, lng, radius } = req.query;
    res.json({ success: true, agents: await networkService.getNearbyAgents(Number(lat), Number(lng), Number(radius) || 10) });
  } catch (e) { next(e); }
});
router.post('/agents/:id/verify', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, agent: await networkService.verifyAgent(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/agents/cash-in', authRequired, async (req, res, next) => {
  try {
    const agent = await networkService.getAgentByUser(req.user.id);
    if (!agent) throw Object.assign(new Error('Sio wakala.'), { statusCode: 403 });
    res.json({ success: true, result: await networkService.agentCashIn(agent.id, req.body.phone, req.body.amount) });
  } catch (e) { next(e); }
});
router.post('/agents/cash-out', authRequired, async (req, res, next) => {
  try {
    const agent = await networkService.getAgentByUser(req.user.id);
    if (!agent) throw Object.assign(new Error('Sio wakala.'), { statusCode: 403 });
    res.json({ success: true, result: await networkService.agentCashOut(agent.id, req.body.phone, req.body.amount) });
  } catch (e) { next(e); }
});
router.post('/agents/settlement', authRequired, async (req, res, next) => {
  try {
    const agent = await networkService.getAgentByUser(req.user.id);
    if (!agent) throw Object.assign(new Error('Sio wakala.'), { statusCode: 403 });
    res.json({ success: true, result: await networkService.agentSettlement(agent.id, req.body.amount, req.body.type) });
  } catch (e) { next(e); }
});
router.get('/agents/dashboard', authRequired, async (req, res, next) => {
  try {
    const agent = await networkService.getAgentByUser(req.user.id);
    if (!agent) throw Object.assign(new Error('Sio wakala.'), { statusCode: 403 });
    res.json({ success: true, dashboard: await networkService.agentDashboard(agent.id) });
  } catch (e) { next(e); }
});

// ===== F2: BULK PAYMENTS =====
router.post('/bulk', authRequired, async (req, res, next) => {
  try { res.json({ success: true, batch: await networkService.createBulkBatch(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/bulk/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, batch: await networkService.getBulkBatch(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/bulk/:id/process', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await networkService.processBulkBatch(req.params.id) }); }
  catch (e) { next(e); }
});
router.get('/bulk', authRequired, async (req, res, next) => {
  try { res.json({ success: true, batches: await networkService.listUserBatches(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== F3: SCHEDULED PAYMENTS =====
router.post('/scheduled', authRequired, async (req, res, next) => {
  try { res.json({ success: true, scheduled: await networkService.createScheduledPayment(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/scheduled', authRequired, async (req, res, next) => {
  try { res.json({ success: true, scheduled: await networkService.listScheduledPayments(req.user.id) }); }
  catch (e) { next(e); }
});
router.delete('/scheduled/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, scheduled: await networkService.cancelScheduledPayment(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/scheduled/process', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await networkService.processDueScheduledPayments() }); }
  catch (e) { next(e); }
});

// ===== F4: CROSS-BORDER REMITTANCES =====
router.get('/remittance/corridors', authRequired, async (req, res, next) => {
  try { res.json({ success: true, corridors: await networkService.listCorridors() }); }
  catch (e) { next(e); }
});
router.post('/remittance/send', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await networkService.sendRemittance(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.post('/remittance/pickup', async (req, res, next) => {
  try {
    const { pickup_code, recipient_phone, recipient_name } = req.body;
    res.json({ success: true, result: await networkService.pickupRemittance(pickup_code, recipient_phone, recipient_name) });
  } catch (e) { next(e); }
});
router.get('/remittance/history', authRequired, async (req, res, next) => {
  try { res.json({ success: true, transfers: await networkService.getRemittanceHistory(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== F5: WEBHOOKS =====
router.post('/webhooks', authRequired, async (req, res, next) => {
  try { res.json({ success: true, webhook: await networkService.createWebhook(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/webhooks', authRequired, async (req, res, next) => {
  try { res.json({ success: true, webhooks: await networkService.listWebhooks(req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/webhooks/:id/test', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await networkService.testWebhook(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.get('/webhooks/:id/deliveries', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deliveries: await networkService.getWebhookDeliveries(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});

// ===== F6: MERCHANT LOYALTY =====
router.post('/merchants/:id/loyalty', authRequired, async (req, res, next) => {
  try { res.json({ success: true, program: await networkService.createLoyaltyProgram(req.params.id, req.body) }); }
  catch (e) { next(e); }
});
router.post('/loyalty/:programId/join', authRequired, async (req, res, next) => {
  try { res.json({ success: true, account: await networkService.joinLoyaltyProgram(req.params.programId, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/loyalty/:programId/earn', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await networkService.earnLoyaltyPoints(req.params.programId, req.user.id, req.body.amount) }); }
  catch (e) { next(e); }
});
router.post('/loyalty/:programId/redeem', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await networkService.redeemLoyaltyPoints(req.params.programId, req.user.id, req.body.points) }); }
  catch (e) { next(e); }
});
router.get('/loyalty/:programId/balance', authRequired, async (req, res, next) => {
  try { res.json({ success: true, balance: await networkService.getLoyaltyBalance(req.params.programId, req.user.id) }); }
  catch (e) { next(e); }
});

// ===== F7: AI INSIGHTS =====
router.get('/insights', authRequired, async (req, res, next) => {
  try { res.json({ success: true, insights: await networkService.getInsights(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== F8: ENHANCED REFERRALS =====
router.get('/referrals/tiers', authRequired, async (req, res, next) => {
  try { res.json({ success: true, tiers: await networkService.getReferralTiers() }); }
  catch (e) { next(e); }
});
router.get('/referrals/code', authRequired, async (req, res, next) => {
  try { res.json({ success: true, code: await networkService.getUserReferralCode(req.user.id) }); }
  catch (e) { next(e); }
});
router.get('/referrals/stats', authRequired, async (req, res, next) => {
  try { res.json({ success: true, stats: await networkService.getReferralStats(req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/referrals/award', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await networkService.awardReferral(req.user.id, req.body.referred_id) }); }
  catch (e) { next(e); }
});

module.exports = router;
