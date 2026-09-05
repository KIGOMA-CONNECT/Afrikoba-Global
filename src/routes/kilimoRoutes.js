const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
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

// Agri Loans & Repayments
router.post('/loans', authRequired, async (req, res, next) => {
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

module.exports = router;
