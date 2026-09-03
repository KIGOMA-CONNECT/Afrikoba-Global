const express = require('express');
const p = require('../services/procurementService');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// ---------------- Suppliers ----------------
router.post('/suppliers', async (req, res, next) => {
  try {
    const s = await p.registerSupplier(req.user.id, req.body);
    return res.json({ success: true, supplier: s });
  } catch (e) { next(e); }
});

router.get('/suppliers', async (req, res, next) => {
  try {
    return res.json({ success: true, suppliers: await p.listSuppliers() });
  } catch (e) { next(e); }
});

// ---------------- Requests (RFQ) ----------------
router.post('/requests', async (req, res, next) => {
  try {
    const r = await p.createRequest(req.user.id, req.body);
    return res.json({ success: true, request: r });
  } catch (e) { next(e); }
});

router.post('/requests/:id/publish', async (req, res, next) => {
  try {
    return res.json({ success: true, request: await p.publishRequest(req.user.id, parseInt(req.params.id, 10)) });
  } catch (e) { next(e); }
});

router.get('/requests', async (req, res, next) => {
  try {
    const mine = req.query.mine === 'true' || req.query.mine === '1';
    const requests = await p.listRequests({ status: req.query.status, mine }, req.user.id);
    return res.json({ success: true, requests });
  } catch (e) { next(e); }
});

router.get('/requests/:id', async (req, res, next) => {
  try {
    return res.json({ success: true, ...(await p.getRequest(parseInt(req.params.id, 10))) });
  } catch (e) { next(e); }
});

// ---------------- Bids ----------------
router.post('/requests/:id/bids', async (req, res, next) => {
  try {
    const bid = await p.submitBid(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.json({ success: true, bid });
  } catch (e) { next(e); }
});

router.post('/requests/:reqId/award/:bidId', async (req, res, next) => {
  try {
    const request = await p.awardRequest(req.user.id, parseInt(req.params.reqId, 10), parseInt(req.params.bidId, 10));
    return res.json({ success: true, request });
  } catch (e) { next(e); }
});

// ---------------- Supplier financing ----------------
router.post('/financing', async (req, res, next) => {
  try {
    return res.json({ success: true, ...(await p.createSupplierFinancing(req.user.id, parseInt(req.body.supplier_id, 10), req.body)) });
  } catch (e) { next(e); }
});

router.get('/financing', async (req, res, next) => {
  try {
    return res.json({ success: true, financing: await p.listSupplierFinancings(req.user.id) });
  } catch (e) { next(e); }
});

module.exports = router;
