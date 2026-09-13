const express = require('express');
const { authRequired, requireRoles, requireKycLevel } = require('../middleware/auth');
const circles = require('../services/lendingCircleService');

const router = express.Router();

// Partners
router.post('/partners', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, partner: await circles.createFieldPartner(req.body) }); }
  catch (e) { next(e); }
});

router.get('/partners', authRequired, async (req, res, next) => {
  try { res.json({ success: true, partners: await circles.listFieldPartners() }); }
  catch (e) { next(e); }
});

// Circles
router.post('/circles', authRequired, async (req, res, next) => {
  try { res.json({ success: true, circle: await circles.createCircle(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.post('/circles/:id/join', authRequired, async (req, res, next) => {
  try { res.json({ success: true, member: await circles.joinCircle(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

router.get('/circles', authRequired, async (req, res, next) => {
  try { res.json({ success: true, circles: await circles.listCircles() }); }
  catch (e) { next(e); }
});

// Campaigns & Contributions
router.post('/campaigns', authRequired, requireKycLevel(2), async (req, res, next) => {
  try { res.json({ success: true, campaign: await circles.createCampaign(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/campaigns', authRequired, async (req, res, next) => {
  try { res.json({ success: true, campaigns: await circles.listCampaigns(req.query.status) }); }
  catch (e) { next(e); }
});

router.post('/campaigns/:id/contribute', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    res.json({ success: true, result: await circles.contribute(req.user.id, parseInt(req.params.id), Number(amount)) });
  } catch (e) { next(e); }
});

router.post('/admin/campaigns/:id/disburse', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await circles.disburseCampaign(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// Campaign detail
router.get('/campaigns/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, campaign: await circles.listCampaign(parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// Repayments
router.post('/campaigns/:id/repay', authRequired, async (req, res, next) => {
  try {
    const { amount, interestAmount } = req.body;
    res.json({ success: true, result: await circles.repayLoan(req.user.id, parseInt(req.params.id), {
      amount: Number(amount),
      interestAmount: interestAmount ? Number(interestAmount) : 0,
    }) });
  } catch (e) { next(e); }
});

router.get('/campaigns/:id/repayments', authRequired, async (req, res, next) => {
  try { res.json({ success: true, repayments: await circles.listRepayments(parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

router.get('/campaigns/:id/payouts', authRequired, async (req, res, next) => {
  try { res.json({ success: true, payouts: await circles.listPayouts(parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// Cancellation (borrower/circle leader or admin)
router.post('/campaigns/:id/cancel', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await circles.cancelCampaign(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// Admin default
router.post('/admin/campaigns/:id/default', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await circles.markDefault(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

module.exports = router;
