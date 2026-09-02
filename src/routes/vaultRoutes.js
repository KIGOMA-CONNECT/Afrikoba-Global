/**
 * Vaults / Spaces Routes
 * Branded goal-savings + fixed-deposit experience (Monzo/Revolut "Vaults/Spaces"
 * parity) built on top of the existing savings engines.
 *
 * Mounted at /api/vaults and /api/v1/vaults
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const sgoals = require('../services/savingsGoalService');
const savings = require('../services/savingsCreditService');

const router = express.Router();

// ===== VAULTS (goal savings) =====
router.get('/', authRequired, async (req, res, next) => {
  try { res.json({ success: true, vaults: await sgoals.getGoals(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/', authRequired, async (req, res, next) => {
  try { res.json({ success: true, vault: await sgoals.createGoal(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.patch('/:id', authRequired, async (req, res, next) => {
  try { res.json({ success: true, vault: await sgoals.updateGoal(req.user.id, req.params.id, req.body) }); }
  catch (e) { next(e); }
});

router.post('/:id/deposit', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await sgoals.deposit(req.user.id, req.params.id, req.body.amount) }); }
  catch (e) { next(e); }
});

router.post('/:id/withdraw', authRequired, async (req, res, next) => {
  try { res.json({ success: true, vault: await sgoals.withdraw(req.user.id, req.params.id, req.body.amount) }); }
  catch (e) { next(e); }
});

// ===== FIXED DEPOSITS (locked Vaults) =====
router.get('/deposits', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deposits: await savings.listFixedDeposits(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/deposits', authRequired, async (req, res, next) => {
  try { res.json({ success: true, deposit: await savings.createFixedDeposit(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

router.post('/deposits/:id/withdraw', authRequired, async (req, res, next) => {
  try { res.json({ success: true, result: await savings.withdrawFixedDeposit(req.user.id, req.params.id, req.body) }); }
  catch (e) { next(e); }
});

// ===== SUMMARY =====
router.get('/summary', authRequired, async (req, res, next) => {
  try { res.json({ success: true, summary: await savings.savingsSummary(req.user.id) }); }
  catch (e) { next(e); }
});

module.exports = router;
