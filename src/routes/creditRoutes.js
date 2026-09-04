/**
 * Credit Routes (I4-I10)
 * Mounted at /api/v1/credit and /api/credit
 */

const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const credit = require('../services/savingsCreditService');
const governanceService = require('../services/governanceService');

const router = express.Router();

// Register executor for four-eyes micro loan disbursement.
governanceService.registerExecutor('CREDIT_LOAN_DISBURSE', async (payload) => {
  return await credit.adminDisburseMicroLoan(payload.loanId, payload.requesterId);
});

// Helper for high-value threshold
async function getHighValueThreshold() {
  const stored = await governanceService.getSetting('HIGH_VALUE_TRANSFER_THRESHOLD');
  const parsed = parseFloat(stored);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000000;
}

// ===== I6: CREDIT SCORE =====
router.get('/score', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await credit.getScore(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/score/recompute', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await credit.recomputeScore(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== TRUST-SCORE DRIVEN CREDIT LIMIT =====
router.get('/limit', authRequired, async (req, res, next) => {
  try {
    const { getCreditLimit, existingExposure } = require('../services/creditLimitService');
    const [limit, exposure] = await Promise.all([getCreditLimit(req.user.id), existingExposure(req.user.id)]);
    res.json({ success: true, ...limit, existingExposure: exposure, available: Math.max(0, limit.creditLimit - exposure) });
  } catch (e) { next(e); }
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
  try {
    const loanId = parseInt(req.params.id, 10);
    const pool = require('../config/db');
    const loan = await pool.query("SELECT amount FROM micro_loans WHERE id = $1", [loanId]);
    if (!loan.rows.length) return res.status(404).json({ success: false, message: 'Mkopo haupatikani.' });

    const amount = parseFloat(loan.rows[0].amount);
    const threshold = await getHighValueThreshold();

    if (amount >= threshold) {
      const flow = await governanceService.createApprovalFlow({
        requesterId: req.user.id,
        actionType: 'CREDIT_LOAN_DISBURSE',
        refType: 'MICRO_LOAN',
        refId: loanId,
        data: { loanId, requesterId: req.user.id, amount },
      });
      return res.json({
        success: true,
        requiresApproval: true,
        approvalFlowId: flow.id,
        status: 'PENDING_APPROVAL',
        message: 'Utoaji wa mkopo wa kiasi kikubwa unahitaji idhini ya msimamizi wa pili (four-eyes).',
      });
    }

    res.json({ success: true, result: await credit.adminDisburseMicroLoan(loanId, req.user.id) });
  }
  catch (e) { next(e); }
});

module.exports = router;