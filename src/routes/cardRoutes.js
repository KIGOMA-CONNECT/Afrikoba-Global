/**
 * Virtual Cards Routes (J1-J6)
 * Mounted at /api/v1/cards and /api/cards
 */

const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const cards = require('../services/cardService');

const router = express.Router();

// ===== J1-J2: ISSUE & MANAGE =====
router.post('/', authRequired, async (req, res, next) => {
  try { res.json({ success: true, ...await cards.issueCard(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/', authRequired, async (req, res, next) => {
  try { res.json({ success: true, cards: await cards.listCards(req.user.id) }); }
  catch (e) { next(e); }
});

router.get('/summary', authRequired, async (req, res, next) => {
  try { res.json({ success: true, summary: await cards.cardSummary(req.user.id) }); }
  catch (e) { next(e); }
});

router.get('/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, card: await cards.getCard(req.user.id, req.params.id) }); }
  catch (e) { next(e); }
});

router.post('/:id/limits', authRequired, async (req, res, next) => {
  try { res.json({ success: true, card: await cards.setCardLimits(req.user.id, req.params.id, req.body) }); }
  catch (e) { next(e); }
});

router.post('/:id/freeze', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await cards.freezeCard(req.user.id, req.params.id, req.body.freeze) }); }
  catch (e) { next(e); }
});

router.post('/:id/block', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await cards.blockCard(req.user.id, req.params.id) }); }
  catch (e) { next(e); }
});

// ===== J3: AUTHORIZATION =====
router.post('/:id/authorize', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await cards.authorizeCard(req.user.id, req.params.id, req.body) }); }
  catch (e) { next(e); }
});

// ===== J6: STATEMENT =====
router.get('/:id/transactions', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await cards.cardStatement(req.user.id, req.params.id) }); }
  catch (e) { next(e); }
});

// ===== J4-J5: MERCHANT SETTLEMENT / REFUND (admin) =====
router.post('/admin/settle', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await cards.settleCardAuth(req.user.id, req.body.auth_reference) }); }
  catch (e) { next(e); }
});

router.post('/admin/refund', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await cards.refundCardAuth(req.user.id, req.body.auth_reference) }); }
  catch (e) { next(e); }
});

module.exports = router;