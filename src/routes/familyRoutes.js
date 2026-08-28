/**
 * Family & Next-Gen Features Routes
 * G1: Family wallets | G2: Multi-currency | G3: Biometric/device
 * G4: Offline queue | G5: Round-up savings
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const familyService = require('../services/familyService');

const router = express.Router();

// ===== G1: FAMILY WALLETS =====
router.post('/family', authRequired, async (req, res, next) => {
  try { res.json({ success: true, wallet: await familyService.createFamilyWallet(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.post('/family/:id/invite', authRequired, async (req, res, next) => {
  try { res.json({ success: true, member: await familyService.inviteMember(req.params.id, req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.post('/family/:id/join', authRequired, async (req, res, next) => {
  try { res.json({ success: true, member: await familyService.joinFamilyWallet(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.get('/family', authRequired, async (req, res, next) => {
  try { res.json({ success: true, wallets: await familyService.listFamilyWallets(req.user.id) }); }
  catch (e) { next(e); }
});
router.get('/family/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, details: await familyService.getFamilyWallet(req.params.id, req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/family/:id/contribute', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.familyContribute(req.params.id, req.user.id, req.body.amount) }); }
  catch (e) { next(e); }
});
router.post('/family/:id/spend', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.familySpend(req.params.id, req.user.id, req.body.amount, req.body.description) }); }
  catch (e) { next(e); }
});
router.post('/family/:id/transfer', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.familyTransfer(req.params.id, req.user.id, req.body.phone, req.body.amount) }); }
  catch (e) { next(e); }
});
router.delete('/family/:id/members/:userId', authRequired, async (req, res, next) => {
  try { res.json({ success: true, member: await familyService.removeMember(req.params.id, req.user.id, req.params.userId) }); }
  catch (e) { next(e); }
});

// ===== G2: MULTI-CURRENCY =====
router.get('/balances', authRequired, async (req, res, next) => {
  try { res.json({ success: true, balances: await familyService.getBalances(req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/currency/topup', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.topUpCurrency(req.user.id, req.body.currency, req.body.amount) }); }
  catch (e) { next(e); }
});
router.post('/currency/convert', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.convertCurrency(req.user.id, req.body.from, req.body.to, req.body.amount) }); }
  catch (e) { next(e); }
});
router.post('/currency/transfer', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.transferForeign(req.user.id, req.body.phone, req.body.currency, req.body.amount) }); }
  catch (e) { next(e); }
});

// ===== G3: BIOMETRIC / DEVICE =====
router.post('/devices', authRequired, async (req, res, next) => {
  try { res.json({ success: true, device: await familyService.registerDevice(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/devices', authRequired, async (req, res, next) => {
  try { res.json({ success: true, devices: await familyService.listDevices(req.user.id) }); }
  catch (e) { next(e); }
});
router.delete('/devices/:deviceId', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.removeDevice(req.user.id, req.params.deviceId) }); }
  catch (e) { next(e); }
});
router.post('/devices/challenge', authRequired, async (req, res, next) => {
  try { res.json({ success: true, challenge: await familyService.generateChallenge(req.user.id, req.body.device_id) }); }
  catch (e) { next(e); }
});
router.post('/devices/verify', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.verifyChallenge(req.user.id, req.body.device_id, req.body.response) }); }
  catch (e) { next(e); }
});
router.post('/biometric/login', async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.biometricLogin(req.body.phone, req.body.device_id, req.body.biometric_token) }); }
  catch (e) { next(e); }
});

// ===== G4: OFFLINE QUEUE =====
router.post('/offline/queue', authRequired, async (req, res, next) => {
  try { res.json({ success: true, op: await familyService.queueOfflineOp(req.user.id, req.body.op_type, req.body.payload) }); }
  catch (e) { next(e); }
});
router.get('/offline/ops', authRequired, async (req, res, next) => {
  try { res.json({ success: true, ops: await familyService.getOfflineOps(req.user.id, req.query.status) }); }
  catch (e) { next(e); }
});
router.post('/offline/sync', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.syncOfflineOps(req.user.id) }); }
  catch (e) { next(e); }
});

// ===== G5: ROUND-UP SAVINGS =====
router.post('/roundup', authRequired, async (req, res, next) => {
  try { res.json({ success: true, rule: await familyService.createRoundupRule(req.user.id, req.body) }); }
  catch (e) { next(e); }
});
router.get('/roundup', authRequired, async (req, res, next) => {
  try { res.json({ success: true, summary: await familyService.getRoundupSummary(req.user.id) }); }
  catch (e) { next(e); }
});
router.post('/roundup/process', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await familyService.processRoundUps(req.user.id) }); }
  catch (e) { next(e); }
});

module.exports = router;
