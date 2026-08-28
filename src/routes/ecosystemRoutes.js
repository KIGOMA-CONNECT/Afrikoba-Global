/**
 * Ecosystem Features Routes
 * QR, chat, bills, airtime, export, backup codes, challenges, insurance.
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const qrCodeService = require('../services/qrCodeService');
const chatService = require('../services/chatService');
const billPaymentService = require('../services/billPaymentService');
const airtimeService = require('../services/airtimeService');
const exportService = require('../services/exportService');
const backupCodeService = require('../services/backupCodeService');
const savingsChallengeService = require('../services/savingsChallengeService');
const insuranceService = require('../services/insuranceService');

const router = express.Router();

// ===== E1: QR CODES =====

router.get('/qr', authRequired, async (req, res, next) => {
  try { res.json({ success: true, codes: await qrCodeService.getQrCodes(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/qr', authRequired, async (req, res, next) => {
  try { res.json({ success: true, code: await qrCodeService.createQrCode(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.post('/qr/scan', authRequired, async (req, res, next) => {
  try {
    const { code } = req.body;
    res.json({ success: true, details: await qrCodeService.scanQrCode(code, req.user.id) });
  } catch (e) { next(e); }
});

router.post('/qr/pay', authRequired, async (req, res, next) => {
  try {
    const { qr_code_id, amount } = req.body;
    res.json(await qrCodeService.payQrCode(qr_code_id, req.user.id, parseFloat(amount)));
  } catch (e) { next(e); }
});

router.delete('/qr/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deleted: await qrCodeService.deactivateQrCode(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// ===== E2: CHAT =====

router.get('/chat', authRequired, async (req, res, next) => {
  try { res.json({ success: true, conversations: await chatService.getConversations(req.user.id) }); }
  catch (e) { next(e); }
});

router.get('/chat/unread', authRequired, async (req, res, next) => {
  try { res.json({ success: true, count: await chatService.getUnreadCount(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/chat/start', authRequired, async (req, res, next) => {
  try {
    const { phone } = req.body;
    const pool = require('../config/db');
    const user = await pool.query(`SELECT id FROM users WHERE phone = $1`, [phone]);
    if (user.rows.length === 0) return res.status(404).json({ success: false, message: 'Mtumiaji haupatikani.' });
    const convId = await chatService.getOrCreateConversation(req.user.id, user.rows[0].id);
    res.json({ success: true, conversationId: convId });
  } catch (e) { next(e); }
});

router.get('/chat/:convId', authRequired, async (req, res, next) => {
  try {
    const messages = await chatService.getMessages(parseInt(req.params.convId), req.user.id, parseInt(req.query.limit) || 50, parseInt(req.query.offset) || 0);
    res.json({ success: true, messages });
  } catch (e) { next(e); }
});

router.post('/chat/:convId/send', authRequired, async (req, res, next) => {
  try {
    const { content, message_type, metadata } = req.body;
    if (!content) return res.status(400).json({ success: false, message: 'Ujumbe unahitajika.' });
    const msg = await chatService.sendMessage(parseInt(req.params.convId), req.user.id, { content, message_type, metadata });
    res.json({ success: true, message: msg });
  } catch (e) { next(e); }
});

router.delete('/chat/messages/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deleted: await chatService.deleteMessage(parseInt(req.params.id), req.user.id) }); }
  catch (e) { next(e); }
});

// ===== E3: BILL PAYMENTS =====

router.get('/bills/billers', async (req, res, next) => {
  try { res.json({ success: true, billers: await billPaymentService.getBillers(req.query.category) }); }
  catch (e) { next(e); }
});

router.post('/bills/pay', authRequired, async (req, res, next) => {
  try { res.json(await billPaymentService.payBill(req.user.id, req.body)); }
  catch (e) { next(e); }
});

router.get('/bills/history', authRequired, async (req, res, next) => {
  try { res.json({ success: true, payments: await billPaymentService.getBillPayments(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== E4: AIRTIME =====

router.get('/airtime/products', async (req, res, next) => {
  try { res.json({ success: true, products: await airtimeService.getProducts(req.query.provider) }); }
  catch (e) { next(e); }
});

router.post('/airtime/purchase', authRequired, async (req, res, next) => {
  try { res.json(await airtimeService.purchaseAirtime(req.user.id, req.body)); }
  catch (e) { next(e); }
});

router.get('/airtime/history', authRequired, async (req, res, next) => {
  try { res.json({ success: true, history: await airtimeService.getPurchaseHistory(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== E5: DATA EXPORT =====

router.get('/export/transactions', authRequired, async (req, res, next) => {
  try {
    const data = await exportService.exportTransactions(req.user.id, req.query);
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
      return res.send(data);
    }
    res.json({ success: true, transactions: data });
  } catch (e) { next(e); }
});

router.get('/export/vicoba', authRequired, async (req, res, next) => {
  try { res.json({ success: true, summary: await exportService.exportVicobaSummary(req.user.id) }); }
  catch (e) { next(e); }
});

router.get('/export/rosca', authRequired, async (req, res, next) => {
  try { res.json({ success: true, summary: await exportService.exportRoscaSummary(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== E6: 2FA BACKUP CODES =====

router.post('/backup-codes/generate', authRequired, async (req, res, next) => {
  try {
    const codes = await backupCodeService.generateBackupCodes(req.user.id);
    res.json({ success: true, codes, message: 'Hifadhi nambari hizi kwa usalama. Kila nambari inatumika mara moja tu.' });
  } catch (e) { next(e); }
});

router.get('/backup-codes/count', authRequired, async (req, res, next) => {
  try { res.json({ success: true, remaining: await backupCodeService.getRemainingCodes(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/backup-codes/verify', async (req, res, next) => {
  try {
    const { userId, code } = req.body;
    const valid = await backupCodeService.verifyBackupCode(userId, code);
    res.json({ success: valid, message: valid ? 'Imekubalika.' : 'Nambari batili.' });
  } catch (e) { next(e); }
});

// ===== E7: SAVINGS CHALLENGES =====

router.get('/challenges', authRequired, async (req, res, next) => {
  try { res.json({ success: true, challenges: await savingsChallengeService.getChallenges(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/challenges', authRequired, async (req, res, next) => {
  try { res.json({ success: true, challenge: await savingsChallengeService.createChallenge(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.post('/challenges/:id/join', authRequired, async (req, res, next) => {
  try { res.json({ success: true, member: await savingsChallengeService.joinChallenge(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

router.post('/challenges/:id/contribute', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    res.json(await savingsChallengeService.contribute(parseInt(req.params.id), req.user.id, parseFloat(amount)));
  } catch (e) { next(e); }
});

router.get('/challenges/:id/leaderboard', authRequired, async (req, res, next) => {
  try { res.json({ success: true, leaderboard: await savingsChallengeService.getLeaderboard(parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// ===== E8: MICRO-INSURANCE =====

router.get('/insurance/products', async (req, res, next) => {
  try { res.json({ success: true, products: await insuranceService.getProducts(req.query.category) }); }
  catch (e) { next(e); }
});

router.post('/insurance/purchase', authRequired, async (req, res, next) => {
  try { res.json(await insuranceService.purchasePolicy(req.user.id, req.body)); }
  catch (e) { next(e); }
});

router.get('/insurance/policies', authRequired, async (req, res, next) => {
  try { res.json({ success: true, policies: await insuranceService.getPolicies(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/insurance/renew/:id', authRequired, async (req, res, next) => {
  try { res.json(await insuranceService.renewPolicy(req.user.id, parseInt(req.params.id))); }
  catch (e) { next(e); }
});

module.exports = router;
