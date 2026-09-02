/**
 * Merchant QR + Payment Links Routes
 * Branded "Merchant" experience: register a merchant, generate scannable QR codes,
 * pay merchants/QRs, and view payment history. Wraps merchantService + qrCodeService.
 *
 * Mounted at /api/merchant and /api/v1/merchant
 */

const express = require('express');
const pool = require('../config/db');
const { authRequired } = require('../middleware/auth');
const merchantService = require('../services/merchantService');
const qrCodeService = require('../services/qrCodeService');

const router = express.Router();

// My merchant profile
router.get('/my', authRequired, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM merchants WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id]);
    res.json({ success: true, merchant: result.rows[0] || null });
  } catch (e) { next(e); }
});

// Register as a merchant
router.post('/register', authRequired, async (req, res, next) => {
  try {
    const merchant = await merchantService.registerMerchant(req.user.id, req.body);
    res.json({ success: true, merchant });
  } catch (e) { next(e); }
});

// My merchant's payment history
router.get('/payments', authRequired, async (req, res, next) => {
  try {
    const mine = await pool.query('SELECT * FROM merchants WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id]);
    if (!mine.rows.length) return res.json({ success: true, payments: [] });
    const payments = await merchantService.getMerchantPayments(mine.rows[0].id);
    res.json({ success: true, payments });
  } catch (e) { next(e); }
});

// Pay a merchant
router.post('/pay', authRequired, async (req, res, next) => {
  try {
    const { merchant_id, amount, description } = req.body;
    if (!merchant_id || !amount) return res.status(400).json({ success: false, message: 'Biashara na kiasi vinahitajika.' });
    const result = await merchantService.payMerchant(req.user.id, merchant_id, parseFloat(amount), description);
    res.json(result);
  } catch (e) { next(e); }
});

// My QR codes
router.get('/qr', authRequired, async (req, res, next) => {
  try { res.json({ success: true, codes: await qrCodeService.getQrCodes(req.user.id) }); }
  catch (e) { next(e); }
});

// Create QR code (returns record with `code` string for the frontend to render as a QR image)
router.post('/qr', authRequired, async (req, res, next) => {
  try { res.json({ success: true, code: await qrCodeService.createQrCode(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

// Disable a QR code
router.delete('/qr/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deleted: await qrCodeService.deactivateQrCode(req.user.id, parseInt(req.params.id, 10)) }); }
  catch (e) { next(e); }
});

// Pay a QR code
router.post('/qr/pay', authRequired, async (req, res, next) => {
  try {
    const { qr_code_id, amount } = req.body;
    if (!qr_code_id || !amount) return res.status(400).json({ success: false, message: 'Kodi na kiasi vinahitajika.' });
    const result = await qrCodeService.payQrCode(qr_code_id, req.user.id, parseFloat(amount));
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
