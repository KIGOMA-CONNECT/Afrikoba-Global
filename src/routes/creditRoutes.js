/**
 * Credit Routes (I4-I10)
 * Mounted at /api/v1/credit and /api/credit
 */

const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const credit = require('../services/savingsCreditService');

const router = express.Router();

// ===== I6: CREDIT SCORE =====
router.get('/score', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await credit.getScore(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/score/recompute', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await credit.recomputeScore(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== I4: MICRO LOANS (user) =====
router.post('/loans', authRequired, async (req, res, next) => {
  try { res.json({ success: true, loan: await credit.applyMicroLoan(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/loans', authRequired, async (req, res, next) => {
  try { res.json({ success: true, loans: await credit.listMicroLoans(req.user.id, false) }); }
  catch (e) { next(e); }
});

router.get('/loans/:id/schedule', authRequired, async (req, res, next) => {
  try { res.json({ success: true, schedule: await credit.loanSchedule(req.user.id, req.params.id) }); }
  catch (e) { next(e); }
});

// ===== I9: GUARANTORS =====
router.post('/loans/:id/guarantors', authRequired, async (req, res, next) => {
  try { res.json({ success: true, guarantor: await credit.addGuarantor(req.user.id, req.params.id, req.body.phone) }); }
  catch (e) { next(e); }
});

router.post('/loans/:id/guarantors/respond', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await credit.respondGuarantor(req.user.id, req.params.id, req.body.accept) }); }
  catch (e) { next(e); }
});

// ===== I5: INSTALLMENT PAYMENTS =====
router.post('/loans/:id/installments/:iid/pay', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await credit.payInstallment(req.user.id, req.params.id, req.params.iid) }); }
  catch (e) { next(e); }
});

router.post('/loans/:id/payoff', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await credit.payoffLoan(req.user.id, req.params.id) }); }
  catch (e) { next(e); }
});

// ===== I10: CREDIT REPORT =====
router.get('/report', authRequired, async (req, res, next) => {
  try { res.json({ success: true, report: await credit.creditReport(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== ADMIN =====
router.get('/admin/loans', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, loans: await credit.listMicroLoans(null, true) }); }
  catch (e) { next(e); }
});

router.post('/admin/loans/:id/approve', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, loan: await credit.adminApproveMicroLoan(req.params.id, req.user.id, req.body.note) }); }
  catch (e) { next(e); }
});

router.post('/admin/loans/:id/disburse', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await credit.adminDisburseMicroLoan(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});

module.exports = router;