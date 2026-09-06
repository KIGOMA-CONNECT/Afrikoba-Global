const express = require('express');
const { authRequired, requireRoles, requireKycLevel } = require('../middleware/auth');
const kilimo = require('../services/kilimoAgriService');

const router = express.Router();

// Farm Profiles
router.post('/farms', authRequired, async (req, res, next) => {
  try { res.json({ success: true, farm: await kilimo.createFarmProfile(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/farms', authRequired, async (req, res, next) => {
  try { res.json({ success: true, farms: await kilimo.listFarmProfiles(req.user.id) }); }
  catch (e) { next(e); }
});

// Input suppliers
router.get('/suppliers', authRequired, async (req, res, next) => {
  try { res.json({ success: true, suppliers: await kilimo.listAgriSuppliers() }); }
  catch (e) { next(e); }
});

// Agri Loans & Repayments
router.post('/loans', authRequired, requireKycLevel(2), async (req, res, next) => {
  try { res.json({ success: true, loan: await kilimo.applyAgriLoan(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/loans', authRequired, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'ADMIN';
    res.json({ success: true, loans: await kilimo.listAgriLoans(req.user.id, isAdmin) });
  } catch (e) { next(e); }
});

router.post('/loans/:id/repay', authRequired, async (req, res, next) => {
  try {
    const { amount } = req.body;
    res.json({ success: true, result: await kilimo.repayAgriLoan(req.user.id, parseInt(req.params.id), Number(amount)) });
  } catch (e) { next(e); }
});

// Admin loan disbursement
router.post('/admin/loans/:id/disburse', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await kilimo.disburseAgriLoan(req.user.id, parseInt(req.params.id)) }); }
  catch (e) { next(e); }
});

// Offtake Agreements
router.post('/offtakes', authRequired, async (req, res, next) => {
  try { res.json({ success: true, agreement: await kilimo.createOfftakeAgreement(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

// ===== Farm seasons + yield tracking =====
router.post('/farms/:farmId/seasons', authRequired, async (req, res, next) => {
  try { res.json({ success: true, season: await kilimo.createSeason(req.user.id, parseInt(req.params.farmId, 10), req.body) }); }
  catch (e) { next(e); }
});

router.get('/farms/:farmId/seasons', authRequired, async (req, res, next) => {
  try { res.json({ success: true, seasons: await kilimo.listSeasons(req.user.id, parseInt(req.params.farmId, 10)) }); }
  catch (e) { next(e); }
});

router.post('/seasons/:seasonId/harvest', authRequired, async (req, res, next) => {
  try { res.json({ success: true, season: await kilimo.completeHarvest(req.user.id, parseInt(req.params.seasonId, 10), req.body) }); }
  catch (e) { next(e); }
});

// ===== Agronomist advisories =====
router.post('/advisories', authRequired, requireRoles('ADMIN', 'AGRONOMIST'), async (req, res, next) => {
  try { res.json({ success: true, advisory: await kilimo.createAdvisory(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.get('/advisories', authRequired, async (req, res, next) => {
  try {
    const farmId = req.query.farmId || req.query.farm_id || null;
    res.json({ success: true, advisories: await kilimo.listAdvisories(req.user.id, req.user.role, farmId ? parseInt(farmId, 10) : null) });
  } catch (e) { next(e); }
});

router.post('/advisories/:advisoryId/action', authRequired, async (req, res, next) => {
  try { res.json({ success: true, advisory: await kilimo.actionAdvisory(req.user.id, req.user.role, parseInt(req.params.advisoryId, 10)) }); }
  catch (e) { next(e); }
});

module.exports = router;
