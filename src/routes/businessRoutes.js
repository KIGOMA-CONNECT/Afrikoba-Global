/**
 * Business & Commerce OS Routes (H1-H10)
 * Mounted at /api/v1/business and /api/business
 */

const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const business = require('../services/businessService');
const governanceService = require('../services/governanceService');

const router = express.Router();

// Register executor for four-eyes loan disbursement.
governanceService.registerExecutor('BUSINESS_LOAN_DISBURSE', async (payload) => {
  return await business.adminDisburseLoan(payload.loanId, payload.requesterId);
});

// Helper for high-value threshold
async function getHighValueThreshold() {
  const stored = await governanceService.getSetting('HIGH_VALUE_TRANSFER_THRESHOLD');
  const parsed = parseFloat(stored);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000000;
}

// ===== H1: BUSINESS ACCOUNTS =====
router.post('/accounts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, business: await business.registerBusiness(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/accounts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, businesses: await business.listBusinesses(req.user.id) }); }
  catch (e) { next(e); }
});
router.get('/accounts/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, business: await business.getBusiness(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/accounts/:id/fund', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await business.fundBusiness(req.params.id, req.user.id, req.body.amount) }); }
  catch (e) { next(e); }
});
router.post('/accounts/:id/withdraw', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await business.businessToWallet(req.params.id, req.user.id, req.body.amount) }); }
  catch (e) { next(e); }
});

// ===== H2: PAYMENT LINKS =====
router.post('/accounts/:id/payment-links', authRequired, async (req, res, next) => {
  try { res.json({ success: true, link: await business.createPaymentLink(req.params.id, req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/accounts/:id/payment-links', authRequired, async (req, res, next) => {
  try { res.json({ success: true, links: await business.listPaymentLinks(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/payment-links/:reference/pay', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await business.payPaymentLink(req.params.reference, req.user.id) }); }
  catch (e) { next(e); }
});

// ===== H3: INVOICES =====
router.post('/accounts/:id/invoices', authRequired, async (req, res, next) => {
  try { res.json({ success: true, invoice: await business.createInvoice(req.params.id, req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/accounts/:id/invoices', authRequired, async (req, res, next) => {
  try { res.json({ success: true, invoices: await business.listInvoices(req.params.id, req.user.id, req.query.status) }); }
  catch (e) { next(e); }
});
router.post('/invoices/:id/pay', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await business.payInvoice(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});

// ===== H4: INVENTORY =====
router.post('/accounts/:id/products', authRequired, async (req, res, next) => {
  try { res.json({ success: true, product: await business.addProduct(req.params.id, req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/accounts/:id/products', authRequired, async (req, res, next) => {
  try { res.json({ success: true, products: await business.listProducts(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.get('/accounts/:id/products/low-stock', authRequired, async (req, res, next) => {
  try { res.json({ success: true, products: await business.lowStockProducts(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.patch('/products/:id/stock', authRequired, async (req, res, next) => {
  try { res.json({ success: true, product: await business.updateStock(req.params.id, req.user.id, req.body.delta) }); }
  catch (e) { next(e); }
});

// ===== H5: PAYROLL =====
router.post('/accounts/:id/payroll', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await business.runPayroll(req.params.id, req.user.id, req.body.period, req.body.employees) }); }
  catch (e) { next(e); }
});
router.get('/accounts/:id/payroll', authRequired, async (req, res, next) => {
  try { res.json({ success: true, runs: await business.listPayroll(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});

// ===== H6: SUPPLIERS =====
router.post('/accounts/:id/suppliers', authRequired, async (req, res, next) => {
  try { res.json({ success: true, supplier: await business.addSupplier(req.params.id, req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/accounts/:id/suppliers', authRequired, async (req, res, next) => {
  try { res.json({ success: true, suppliers: await business.listSuppliers(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/accounts/:id/suppliers/:supplierId/pay', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await business.paySupplier(req.params.id, req.user.id, req.params.supplierId, req.body.amount) }); }
  catch (e) { next(e); }
});

// ===== H7: SALES ANALYTICS =====
router.get('/accounts/:id/analytics', authRequired, async (req, res, next) => {
  try { res.json({ success: true, analytics: await business.salesAnalytics(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});

// ===== H8: BUSINESS LOANS =====
router.post('/accounts/:id/loans', authRequired, async (req, res, next) => {
  try { res.json({ success: true, loan: await business.applyBusinessLoan(req.user.id, req.params.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/loans', authRequired, async (req, res, next) => {
  try { res.json({ success: true, loans: await business.listBusinessLoans(req.user.id, false) }); }
  catch (e) { next(e); }
});
router.get('/admin/loans', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, loans: await business.listBusinessLoans(null, true) }); }
  catch (e) { next(e); }
});
router.post('/admin/loans/:id/approve', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, loan: await business.adminApproveLoan(req.params.id, req.user.id, req.body.note) }); }
  catch (e) { next(e); }
});
router.post('/admin/loans/:id/disburse', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const loanId = parseInt(req.params.id, 10);
    const pool = require('../config/db');
    const loan = await pool.query("SELECT amount FROM business_loans WHERE id = $1", [loanId]);
    if (!loan.rows.length) return res.status(404).json({ success: false, message: 'Mkopo haupatikani.' });
    
    const amount = parseFloat(loan.rows[0].amount);
    const threshold = await getHighValueThreshold();

    if (amount >= threshold) {
      const flow = await governanceService.createApprovalFlow({
        requesterId: req.user.id,
        actionType: 'BUSINESS_LOAN_DISBURSE',
        refType: 'BUSINESS_LOAN',
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

    res.json({ success: true, result: await business.adminDisburseLoan(loanId, req.user.id) });
  }
  catch (e) { next(e); }
});
router.post('/loans/:id/repay', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await business.repayLoan(req.user.id, req.params.id, req.body.amount) }); }
  catch (e) { next(e); }
});

// ===== H9: TAX & COMPLIANCE =====
router.get('/accounts/:id/tax', authRequired, async (req, res, next) => {
  try { res.json({ success: true, ...await business.taxSummary(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});

// ===== H10: STAFF ROLES + POS =====
router.post('/accounts/:id/staff', authRequired, async (req, res, next) => {
  try { res.json({ success: true, staff: await business.addStaff(req.params.id, req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/accounts/:id/staff', authRequired, async (req, res, next) => {
  try { res.json({ success: true, staff: await business.listStaff(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/accounts/:id/pos/open', authRequired, async (req, res, next) => {
  try { res.json({ success: true, session: await business.openPosSession(req.params.id, req.user.id, req.body.opening_cash) }); }
  catch (e) { next(e); }
});
router.post('/pos/:id/close', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await business.closePosSession(req.params.id, req.user.id, req.body.closing_cash, req.body.sales_total) }); }
  catch (e) { next(e); }
});

module.exports = router;