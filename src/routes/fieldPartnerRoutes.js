const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const service = require('../services/fieldPartnerService');
const { logAction } = require('../services/auditService');
const { createAppError } = require('../utils/errorCodes');

const router = express.Router();

/**
 * Resolve which partner a request is allowed to act on.
 * ADMIN/OPERATOR may pass partnerId explicitly; otherwise the caller
 * must be the linked FIELD_PARTNER operator of an active partner.
 */
async function partnerContext(req, explicitPartnerId = null) {
  const staff = req.user.role === 'ADMIN' || req.user.role === 'OPERATOR';
  if (explicitPartnerId) {
    if (!staff) throw createAppError('FIELD_PARTNER_UNAUTHORIZED');
    return { partnerId: Number(explicitPartnerId), staff };
  }
  const partner = await service.getPartnerForUser(req.user.id);
  if (!partner) throw createAppError('FIELD_PARTNER_UNAUTHORIZED');
  return { partnerId: partner.id, staff };
}

// Public catalog: active partners (small, safe read).
router.get('/', authRequired, async (req, res, next) => {
  try {
    const partners = await service.listPartners(true);
    return res.json({
      success: true,
      partners: partners.map((p) => ({
        id: p.id,
        name: p.name,
        countryCode: p.country_code,
        region: p.region,
        riskRating: p.risk_rating,
        trustScore: p.trust_score,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// Admin: all partners incl. inactive + admin management surface.
router.get('/all', authRequired, requireRoles('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const partners = await service.listPartners(false);
    return res.json({ success: true, partners });
  } catch (error) {
    next(error);
  }
});

// Admin: register a new field partner organization.
router.post('/', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { name, countryCode, region, riskRating, phoneNumber, operatorName } = req.body;
    const partner = await service.createPartner({ name, countryCode, region, riskRating, phoneNumber, operatorName });
    logAction(req.user.id, 'FIELD_PARTNER_CREATED', 'field_partner', partner.id, { name }, req);
    return res.status(201).json({ success: true, partner });
  } catch (error) {
    next(error);
  }
});

// Admin: edit partner profile/status.
router.put('/:id', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const partner = await service.updatePartner(Number(req.params.id), req.body);
    logAction(req.user.id, 'FIELD_PARTNER_UPDATED', 'field_partner', partner.id, { fields: Object.keys(req.body) }, req);
    return res.json({ success: true, partner });
  } catch (error) {
    next(error);
  }
});

// Admin: bind a platform user as this partner's FIELD_PARTNER operator.
router.put('/:id/bind-user', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) throw createAppError('VALIDATION_ERROR', { field: 'userId' });
    const partner = await service.bindUser({ partnerId: Number(req.params.id), userId });
    logAction(req.user.id, 'FIELD_PARTNER_BOUND', 'field_partner', partner.id, { userId }, req);
    return res.json({ success: true, partner });
  } catch (error) {
    next(error);
  }
});

// Admin: fund a partner's lendable pool (credit PARTNER_BALANCE).
router.post('/:id/fund', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { amount, reference } = req.body;
    const result = await service.fundPartner({ partnerId: Number(req.params.id), amount, reference });
    logAction(req.user.id, 'PARTNER_FUNDING', 'field_partner', result.partnerId, { amount, reference }, req);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Partner summary (own book).
router.get('/my', authRequired, async (req, res, next) => {
  try {
    const { partnerId } = await partnerContext(req);
    const summary = await service.getSummary(partnerId);
    const meta = await service.getPartner(partnerId);
    return res.json({ success: true, partner: meta, summary });
  } catch (error) {
    next(error);
  }
});

// Admin: summary for any partner.
router.get('/:id/summary', authRequired, requireRoles('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const partner = await service.getPartner(Number(req.params.id));
    if (!partner) throw createAppError('FIELD_PARTNER_NOT_FOUND');
    const summary = await service.getSummary(partner.id);
    return res.json({ success: true, partner, summary });
  } catch (error) {
    next(error);
  }
});

// Partner: onboard a borrower loan into the book.
router.post('/loans', authRequired, async (req, res, next) => {
  try {
    const { partnerId } = await partnerContext(req, req.body.partnerId);
    const { borrowerUserId, amount, interestRate, termMonths, purpose } = req.body;
    const loan = await service.createLoan({ partnerId, borrowerUserId, amount, interestRate, termMonths, purpose });
    logAction(req.user.id, 'FIELD_PARTNER_LOAN_CREATED', 'field_partner_loan', loan.id, { amount, borrowerUserId }, req);
    return res.status(201).json({ success: true, loan });
  } catch (error) {
    next(error);
  }
});

// Partner: list book (optional ?status=).
router.get('/loans', authRequired, async (req, res, next) => {
  try {
    const { partnerId } = await partnerContext(req, req.query.partnerId);
    const loans = await service.listLoans({ partnerId, status: req.query.status || null });
    return res.json({ success: true, loans });
  } catch (error) {
    next(error);
  }
});

// Partner: disburse a loan from the pool to the borrower's wallet.
router.post('/loans/:id/disburse', authRequired, async (req, res, next) => {
  try {
    const { partnerId } = await partnerContext(req, req.body.partnerId);
    const result = await service.disburseLoan({ loanId: Number(req.params.id), partnerId });
    logAction(req.user.id, 'FIELD_PARTNER_LOAN_DISBURSED', 'field_partner_loan', result.loanId, { amount: result.disbursed }, req);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Partner: record a repayment on behalf of a borrower (field cash collection).
router.post('/loans/:id/repay', authRequired, async (req, res, next) => {
  try {
    const { partnerId } = await partnerContext(req, req.body.partnerId);
    const { amount, note } = req.body;
    const result = await service.recordRepayment({ loanId: Number(req.params.id), partnerId, amount, note });
    logAction(req.user.id, 'FIELD_PARTNER_REPAYMENT', 'field_partner_loan', result.loanId, { amount }, req);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Borrower: my field-partner loans.
router.get('/my-loans', authRequired, async (req, res, next) => {
  try {
    const loans = await service.getBorrowerLoans(req.user.id);
    return res.json({ success: true, loans });
  } catch (error) {
    next(error);
  }
});

// Borrower: self-serve repayment from their own wallet.
router.post('/my-loans/:id/repay', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    const result = await service.selfRepay({ loanId: Number(req.params.id), userId: req.user.id, amount });
    logAction(req.user.id, 'FIELD_PARTNER_REPAYMENT_SELF', 'field_partner_loan', result.loanId, { amount }, req);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;