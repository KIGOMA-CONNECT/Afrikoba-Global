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
const cache = require('../utils/cache');
const { queryRead } = require('../config/replica');

const router = express.Router();

const listKey = (uid) => `vaults:list:${uid}`;
const summaryKey = (uid) => `vaults:summary:${uid}`;
const depositsKey = (uid) => `vaults:deposits:${uid}`;

async function bustVaults(uid) {
  await Promise.all([
    cache.del(listKey(uid)),
    cache.del(summaryKey(uid)),
    cache.del(depositsKey(uid)),
  ]);
}

// ===== VAULTS (goal savings) =====
router.get('/', authRequired, async (req, res, next) => {
  try {
    const key = listKey(req.user.id);
    const cached = await cache.get(key);
    if (cached) return res.json({ success: true, vaults: cached.source });
    const vaults = await sgoals.getGoals(req.user.id, queryRead);
    await cache.set(key, { source: vaults }, 15000);
    res.json({ success: true, vaults });
  } catch (e) { next(e); }
});

router.post('/', authRequired, async (req, res, next) => {
  try {
    res.json({ success: true, vault: await sgoals.createGoal(req.user.id, req.body) });
    await bustVaults(req.user.id);
  } catch (e) { next(e); }
});

router.patch('/:id', authRequired, async (req, res, next) => {
  try {
    res.json({ success: true, vault: await sgoals.updateGoal(req.user.id, req.params.id, req.body) });
    await bustVaults(req.user.id);
  } catch (e) { next(e); }
});

router.post('/:id/deposit', authRequired, async (req, res, next) => {
  try {
    res.json({ success: true, result: await sgoals.deposit(req.user.id, req.params.id, req.body.amount) });
    await bustVaults(req.user.id);
  } catch (e) { next(e); }
});

router.post('/:id/withdraw', authRequired, async (req, res, next) => {
  try {
    res.json({ success: true, vault: await sgoals.withdraw(req.user.id, req.params.id, req.body.amount) });
    await bustVaults(req.user.id);
  } catch (e) { next(e); }
});

// ===== FIXED DEPOSITS (locked Vaults) =====
router.get('/deposits', authRequired, async (req, res, next) => {
  try {
    const key = depositsKey(req.user.id);
    const cached = await cache.get(key);
    if (cached) return res.json({ success: true, deposits: cached.source });
    const deposits = await savings.listFixedDeposits(req.user.id, queryRead);
    await cache.set(key, { source: deposits }, 15000);
    res.json({ success: true, deposits });
  } catch (e) { next(e); }
});

router.post('/deposits', authRequired, async (req, res, next) => {
  try {
    res.json({ success: true, deposit: await savings.createFixedDeposit(req.user.id, req.body) });
    await bustVaults(req.user.id);
  } catch (e) { next(e); }
});

router.post('/deposits/:id/withdraw', authRequired, async (req, res, next) => {
  try {
    res.json({ success: true, result: await savings.withdrawFixedDeposit(req.user.id, req.params.id, req.body) });
    await bustVaults(req.user.id);
  } catch (e) { next(e); }
});

// ===== SUMMARY =====
router.get('/summary', authRequired, async (req, res, next) => {
  try {
    const key = summaryKey(req.user.id);
    const cached = await cache.get(key);
    if (cached) return res.json({ success: true, summary: cached.source });
    const summary = await savings.savingsSummary(req.user.id, queryRead);
    await cache.set(key, { source: summary }, 15000);
    res.json({ success: true, summary });
  } catch (e) { next(e); }
});

module.exports = router;
