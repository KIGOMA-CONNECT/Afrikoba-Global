const express = require('express');
const { authRequired } = require('../middleware/auth');
const mkt = require('../services/p2pMarketplaceService');

const router = express.Router();

// P2P secondary market listings
router.post('/listings', authRequired, async (req, res, next) => {
  try { res.status(201).json({ success: true, listing: await mkt.createListing(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/listings', authRequired, async (req, res, next) => {
  try { res.json({ success: true, listings: await mkt.listListings(req.query) }); }
  catch (e) { next(e); }
});

router.post('/listings/:id/buy', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await mkt.buyListing(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// auto-invest rules
router.get('/auto-invest', authRequired, async (req, res, next) => {
  try { res.json({ success: true, rule: await mkt.getAutoInvestRule(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/auto-invest', authRequired, async (req, res, next) => {
  try { res.json({ success: true, rule: await mkt.upsertAutoInvestRule(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

module.exports = router;