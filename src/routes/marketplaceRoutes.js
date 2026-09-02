/**
 * AFRIKOBA MARKETPLACE ROUTES
 * Mounted at /api/v1/marketplace and /api/marketplace
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const mkt = require('../services/marketplaceService');

const router = express.Router();

// ===== DISCOVER / COMPARE =====
router.get('/price-guide', async (req, res, next) => {
  try {
    const guide = await mkt.priceGuide(req.query.category, req.query.item);
    res.json({ success: true, guide });
  } catch (e) { next(e); }
});

router.get('/listings', async (req, res, next) => {
  try {
    const listings = await mkt.listListings({
      category: req.query.category,
      q: req.query.q,
      min: req.query.min,
      max: req.query.max,
      sort: req.query.sort,
      limit: req.query.limit,
    });
    res.json({ success: true, count: listings.length, listings });
  } catch (e) { next(e); }
});

router.get('/listings/:id', async (req, res, next) => {
  try {
    res.json({ success: true, listing: await mkt.getListing(req.params.id) });
  } catch (e) { next(e); }
});

// ===== LISTING CREATION =====
router.post('/listings', authRequired, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, listing: await mkt.createListing(req.user.id, req.body) });
  } catch (e) { next(e); }
});

// ===== PURCHASE / PAY / ESCROW =====
router.post('/orders', authRequired, async (req, res, next) => {
  try {
    const { listing_id, quantity } = req.body;
    const result = await mkt.buyListing(req.user.id, listing_id, quantity);
    res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.get('/orders', authRequired, async (req, res, next) => {
  try {
    const orders = await mkt.listOrders(req.user.id, { role: req.query.role });
    res.json({ success: true, orders });
  } catch (e) { next(e); }
});

router.post('/orders/:id/confirm', authRequired, async (req, res, next) => {
  try {
    const result = await mkt.confirmDelivery(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.post('/orders/:id/cancel', authRequired, async (req, res, next) => {
  try {
    const result = await mkt.cancelOrder(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

// ===== REVIEW =====
router.post('/orders/:id/review', authRequired, async (req, res, next) => {
  try {
    const review = await mkt.reviewOrder(req.user.id, parseInt(req.params.id, 10), req.body);
    res.status(201).json({ success: true, review });
  } catch (e) { next(e); }
});

module.exports = router;