/**
 * Public Stats API
 * Returns aggregate stats for landing page (no auth required).
 */

const express = require('express');
const pool = require('../config/db');
const { apiLimiter } = require('../middleware/rateLimiter');
const router = express.Router();

router.get('/public', apiLimiter, async (req, res, next) => {
  try {
    const [balanceRes, groupsRes, usersRes] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(wallet_balance), 0) AS total FROM users'),
      pool.query('SELECT COUNT(*)::int AS total FROM vicoba_groups'),
      pool.query('SELECT COUNT(*)::int AS total FROM users'),
    ]);

    const totalBalance = Number(balanceRes.rows[0].total) || 0;
    const vicobaGroups = groupsRes.rows[0].total || 0;
    const registeredUsers = usersRes.rows[0].total || 0;

    res.json({
      success: true,
      stats: {
        totalBalance,
        totalBalanceFormatted: `TZS ${totalBalance >= 1000000 ? (totalBalance / 1000000).toFixed(1) + 'M' : totalBalance.toLocaleString()}`,
        vicobaGroups,
        registeredUsers,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;