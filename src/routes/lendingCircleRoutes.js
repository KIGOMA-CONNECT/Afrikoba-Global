const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
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

// Campaigns & Contributions
router.post('/campaigns', authRequired, async (req, res, next) => {
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

module.exports = router;
