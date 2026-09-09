/**
 * Merchant QR + Payment Links Routes
 * Branded "Merchant" experience: register a merchant, generate scannable QR codes,
 * pay merchants/QRs, and view payment history. Wraps merchantService + qrCodeService.
 *
 * Mounted at /api/merchant and /api/v1/merchant
 */

const express = require('express');
const pool = require('../config/db');
const { authRequired, requireRoles } = require('../middleware/auth');
const merchantService = require('../services/merchantService');
const merchantPayoutService = require('../services/merchantPayoutService');
const qrCodeService = require('../services/qrCodeService');
const paymentLinkService = require('../services/paymentLinkService');
const invoiceService = require('../services/invoiceService');

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

// My payment links
router.get('/payment-links', authRequired, async (req, res, next) => {
  try { res.json({ success: true, links: await paymentLinkService.getPaymentLinks(req.user.id) }); }
  catch (e) { next(e); }
});

// Create a payment link
router.post('/payment-links', authRequired, async (req, res, next) => {
  try { res.json({ success: true, link: await paymentLinkService.createPaymentLink(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

// Resolve a payment link by code (public-resolvable, auth not required)
router.get('/payment-links/:code', async (req, res, next) => {
  try {
    const link = await paymentLinkService.getPaymentLinkByCode(req.params.code);
    if (!link) return res.status(404).json({ success: false, message: 'Kiungo cha malipo hakipatikani.' });
    res.json({ success: true, link });
  } catch (e) {
    if (e.message && e.message.includes('hakipatikani')) return res.status(404).json({ success: false, message: e.message });
    next(e);
  }
});

// Pay a payment link by code
router.post('/payment-links/:code/pay', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    const result = await paymentLinkService.payPaymentLink(req.params.code, req.user.id, amount ? parseFloat(amount) : null);
    res.json(result);
  } catch (e) {
    if (e.message && e.message.includes('hakipatikani')) return res.status(404).json({ success: false, message: e.message });
    next(e);
  }
});

// Deactivate a payment link
router.delete('/payment-links/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deleted: await paymentLinkService.deactivatePaymentLink(req.user.id, parseInt(req.params.id, 10)) }); }
  catch (e) { next(e); }
});

// ---- Invoices ----

// My invoices
router.get('/invoices', authRequired, async (req, res, next) => {
  try {
    const invoices = await invoiceService.listInvoices(req.user.id);
    res.json({ success: true, invoices });
  } catch (e) { next(e); }
});

// Issue an invoice
router.post('/invoices', authRequired, async (req, res, next) => {
  try {
    const invoice = await invoiceService.createInvoice(req.user.id, req.body);
    res.json({ success: true, invoice });
  } catch (e) { next(e); }
});

// Resolve an invoice by code (public, auth not required)
router.get('/invoices/:code', async (req, res, next) => {
  try {
    const invoice = await invoiceService.getInvoiceByCode(req.params.code);
    res.json({ success: true, invoice });
  } catch (e) {
    if (e.message && e.message.includes('haipatikani')) return res.status(404).json({ success: false, message: e.message });
    next(e);
  }
});

// Pay an invoice by code
router.post('/invoices/:code/pay', authRequired, async (req, res, next) => {
  try {
    const result = await invoiceService.payInvoice(req.user.id, req.params.code, req.body ? req.body.amount : null);
    res.json(result);
  } catch (e) {
    if (e.message && e.message.includes('haipatikani')) return res.status(404).json({ success: false, message: e.message });
    next(e);
  }
});

// Cancel an issued invoice
router.post('/invoices/:id/cancel', authRequired, async (req, res, next) => {
  try {
    const invoice = await invoiceService.cancelInvoice(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true, invoice });
  } catch (e) { next(e); }
});

// ---- Connected account + payouts (Stripe-Connect-style) ----

// My connected payout account + held balance
router.get('/connected', authRequired, async (req, res, next) => {
  try {
    const { merchant, account } = await merchantPayoutService.getConnectedAccount(req.user.id);
    res.json({ success: true, merchant, account });
  } catch (e) { next(e); }
});

// Create / update my connected payout account (resets to PENDING for re-KYC)
router.post('/connected', authRequired, async (req, res, next) => {
  try {
    const account = await merchantPayoutService.upsertConnectedAccount(req.user.id, req.body);
    res.json({ success: true, account });
  } catch (e) { next(e); }
});

// My payout history
router.get('/payouts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, payouts: await merchantPayoutService.listPayouts(req.user.id) }); }
  catch (e) { next(e); }
});

// Request a settlement against held proceeds
router.post('/payouts', authRequired, async (req, res, next) => {
  try {
    const payout = await merchantPayoutService.requestPayout(req.user.id, { amount: req.body?.amount });
    res.json({ success: true, payout });
  } catch (e) { next(e); }
});

// ---- Admin: connected accounts + settlement execution ----
router.use('/admin', authRequired, requireRoles('ADMIN', 'OPS', 'COMPLIANCE', 'SUPPORT'));

router.get('/admin/connected', async (req, res, next) => {
  try { res.json({ success: true, accounts: await merchantPayoutService.adminListConnected() }); }
  catch (e) { next(e); }
});

router.patch('/admin/connected/:id', async (req, res, next) => {
  try {
    const account = await merchantPayoutService.adminSetConnectedStatus(req.user.id, parseInt(req.params.id, 10), req.body?.status);
    res.json({ success: true, account });
  } catch (e) { next(e); }
});

router.get('/admin/payouts', async (req, res, next) => {
  try { res.json({ success: true, payouts: await merchantPayoutService.adminListPayouts(req.query.status || null) }); }
  catch (e) { next(e); }
});

router.post('/admin/payouts/:id/execute', async (req, res, next) => {
  try {
    const payout = await merchantPayoutService.adminExecutePayout(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true, payout });
  } catch (e) { next(e); }
});

module.exports = router;
