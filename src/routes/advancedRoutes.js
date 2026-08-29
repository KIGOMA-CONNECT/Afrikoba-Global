/**
 * Advanced Features Routes
 * PIN reset, receipts, credit scoring, loans, bill splits, support, KYC, merchants, push.
 */

const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const { pinReqLimiter, pinVerifyLimiter } = require('../middleware/rateLimiter');
const pinResetService = require('../services/pinResetService');
const receiptService = require('../services/receiptService');
const creditScoreService = require('../services/creditScoreService');
const billSplitService = require('../services/billSplitService');
const supportService = require('../services/supportService');
const kycDocumentService = require('../services/kycDocumentService');
const merchantService = require('../services/merchantService');
const pushService = require('../services/pushService');

const router = express.Router();

// ===== C1: PIN RESET =====

router.post('/pin-reset/request', pinReqLimiter, async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Simu inahitajika.' });
    const result = await pinResetService.requestPinReset(phone);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/pin-reset/verify', pinVerifyLimiter, async (req, res, next) => {
  try {
    const { phone, token } = req.body;
    if (!phone || !token) return res.status(400).json({ success: false, message: 'Simu na OTP zinahitajika.' });
    const result = await pinResetService.verifyPinReset(phone, token);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/pin-reset/complete', pinVerifyLimiter, async (req, res, next) => {
  try {
    const { userId, resetKey, newPin } = req.body;
    if (!userId || !resetKey || !newPin) return res.status(400).json({ success: false, message: 'Taarifa zote zinahitajika.' });
    const result = await pinResetService.completePinReset(userId, resetKey, newPin);
    res.json(result);
  } catch (error) { next(error); }
});

// ===== C2: RECEIPTS =====

router.get('/receipts/:transactionId', authRequired, async (req, res, next) => {
  try {
    const receipt = await receiptService.getReceipt(parseInt(req.params.transactionId), req.user.id);
    res.json({ success: true, receipt });
  } catch (error) { next(error); }
});

// ===== C3: CREDIT SCORING =====

router.get('/credit-score', authRequired, async (req, res, next) => {
  try {
    const score = await creditScoreService.getScore(req.user.id);
    res.json({ success: true, ...score });
  } catch (error) { next(error); }
});

router.get('/credit-score/recalculate', authRequired, async (req, res, next) => {
  try {
    const score = await creditScoreService.calculateScore(req.user.id);
    res.json({ success: true, ...score });
  } catch (error) { next(error); }
});

router.get('/loan-eligibility', authRequired, async (req, res, next) => {
  try {
    const { amount, term } = req.query;
    if (!amount || !term) return res.status(400).json({ success: false, message: 'Kiasi na muda vinahitajika.' });
    const result = await creditScoreService.checkEligibility(req.user.id, parseFloat(amount), parseInt(term));
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

// ===== C5: BILL SPLITS =====

router.get('/bill-splits', authRequired, async (req, res, next) => {
  try {
    const splits = await billSplitService.getSplits(req.user.id);
    res.json({ success: true, splits });
  } catch (error) { next(error); }
});

router.post('/bill-splits', authRequired, async (req, res, next) => {
  try {
    const split = await billSplitService.createSplit(req.user.id, req.body);
    res.json({ success: true, split });
  } catch (error) { next(error); }
});

router.get('/bill-splits/:id', authRequired, async (req, res, next) => {
  try {
    const detail = await billSplitService.getSplitDetail(parseInt(req.params.id));
    res.json({ success: true, ...detail });
  } catch (error) { next(error); }
});

router.post('/bill-splits/:id/pay', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ success: false, message: 'Kiasi kinahitajika.' });
    const result = await billSplitService.paySplit(parseInt(req.params.id), req.user.id, parseFloat(amount));
    res.json(result);
  } catch (error) { next(error); }
});

// ===== C6: SUPPORT TICKETS =====

router.get('/support/tickets', authRequired, async (req, res, next) => {
  try {
    const tickets = await supportService.getTickets(req.user.id, req.query.status);
    res.json({ success: true, tickets });
  } catch (error) { next(error); }
});

router.post('/support/tickets', authRequired, async (req, res, next) => {
  try {
    const ticket = await supportService.createTicket(req.user.id, req.body);
    res.json({ success: true, ticket });
  } catch (error) { next(error); }
});

router.get('/support/tickets/:id', authRequired, async (req, res, next) => {
  try {
    const detail = await supportService.getTicketDetail(parseInt(req.params.id), req.user.id);
    res.json({ success: true, ...detail });
  } catch (error) { next(error); }
});

router.post('/support/tickets/:id/messages', authRequired, async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Ujumbe unahitajika.' });
    const msg = await supportService.addMessage(parseInt(req.params.id), req.user.id, message);
    res.json({ success: true, message: msg });
  } catch (error) { next(error); }
});

// Admin support routes
router.get('/admin/support/tickets', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const tickets = await supportService.getAllTickets(req.query.status);
    res.json({ success: true, tickets });
  } catch (error) { next(error); }
});

router.get('/admin/support/stats', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const stats = await supportService.getTicketStats();
    res.json({ success: true, stats });
  } catch (error) { next(error); }
});

router.put('/admin/support/tickets/:id/status', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { status, resolution } = req.body;
    const ticket = await supportService.updateStatus(parseInt(req.params.id), status, resolution);
    res.json({ success: true, ticket });
  } catch (error) { next(error); }
});

router.post('/admin/support/tickets/:id/messages', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { message } = req.body;
    const msg = await supportService.addMessage(parseInt(req.params.id), req.user.id, message);
    res.json({ success: true, message: msg });
  } catch (error) { next(error); }
});

// ===== C8: PUSH NOTIFICATIONS =====

router.post('/push/register', authRequired, async (req, res, next) => {
  try {
    const { token, platform } = req.body;
    if (!token || !platform) return res.status(400).json({ success: false, message: 'Token na jukwaa vinahitajika.' });
    const result = await pushService.registerToken(req.user.id, token, platform);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/push/remove', authRequired, async (req, res, next) => {
  try {
    const { token } = req.body;
    const result = await pushService.removeToken(req.user.id, token);
    res.json(result);
  } catch (error) { next(error); }
});

// ===== C9: KYC DOCUMENTS =====

router.get('/kyc/documents', authRequired, async (req, res, next) => {
  try {
    const docs = await kycDocumentService.getDocuments(req.user.id);
    res.json({ success: true, documents: docs });
  } catch (error) { next(error); }
});

router.post('/kyc/documents', authRequired, async (req, res, next) => {
  try {
    const doc = await kycDocumentService.uploadDocument(req.user.id, req.body);
    res.json({ success: true, document: doc });
  } catch (error) { next(error); }
});

router.get('/admin/kyc/pending', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const docs = await kycDocumentService.getPendingDocuments();
    res.json({ success: true, documents: docs });
  } catch (error) { next(error); }
});

router.put('/admin/kyc/:id/verify', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { status, rejection_reason } = req.body;
    const doc = await kycDocumentService.verifyDocument(parseInt(req.params.id), req.user.id, status, rejection_reason);
    res.json({ success: true, document: doc });
  } catch (error) { next(error); }
});

router.get('/admin/kyc/stats', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const stats = await kycDocumentService.getDocumentStats();
    res.json({ success: true, stats });
  } catch (error) { next(error); }
});

// ===== C10: MERCHANTS =====

router.get('/merchants', async (req, res, next) => {
  try {
    const merchants = await merchantService.getMerchants(req.query.search);
    res.json({ success: true, merchants });
  } catch (error) { next(error); }
});

router.post('/merchants', authRequired, async (req, res, next) => {
  try {
    const merchant = await merchantService.registerMerchant(req.user.id, req.body);
    res.json({ success: true, merchant });
  } catch (error) { next(error); }
});

router.post('/merchants/pay', authRequired, async (req, res, next) => {
  try {
    const { merchant_id, amount, description } = req.body;
    if (!merchant_id || !amount) return res.status(400).json({ success: false, message: 'Biashara na kiasi vinahitajika.' });
    const result = await merchantService.payMerchant(req.user.id, merchant_id, parseFloat(amount), description);
    res.json(result);
  } catch (error) { next(error); }
});

module.exports = router;
