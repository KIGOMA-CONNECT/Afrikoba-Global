/**
 * Rewards/Cashback Service
 * Points, tiers, earn/redeem.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const TIERS = {
  BRONZE: { min: 0, multiplier: 1 },
  SILVER: { min: 1000, multiplier: 1.5 },
  GOLD: { min: 5000, multiplier: 2 },
  PLATINUM: { min: 20000, multiplier: 3 },
};

const EARN_RATES = {
  TRANSFER: 0.001,   // 0.1% of amount
  DEPOSIT: 0.0005,   // 0.05%
  REFERRAL: 500,     // Fixed 500 points
  VICOBA_CONTRIBUTION: 0.002, // 0.2%
  FIRST_TRANSACTION: 100,
};

async function getOrCreateRewards(userId) {
  let result = await pool.query(`SELECT * FROM rewards WHERE user_id = $1`, [userId]);
  if (result.rows.length === 0) {
    result = await pool.query(
      `INSERT INTO rewards (user_id) VALUES ($1) RETURNING *`,
      [userId]
    );
  }
  return result.rows[0];
}

async function earnPoints(userId, type, amount, referenceId = null) {
  const rewards = await getOrCreateRewards(userId);
  const rate = EARN_RATES[type] || 0;
  const tier = TIERS[rewards.tier] || TIERS.BRONZE;

  let points = 0;
  if (typeof rate === 'number' && rate < 1) {
    points = Math.floor(amount * rate * tier.multiplier);
  } else {
    points = Math.floor(rate * tier.multiplier);
  }

  if (points <= 0) return { points: 0, total: rewards.points };

  // Add points
  await pool.query(
    `UPDATE rewards SET points = points + $1, total_earned = total_earned + $1, updated_at = NOW() WHERE user_id = $2`,
    [points, userId]
  );

  // Record transaction
  await pool.query(
    `INSERT INTO reward_transactions (user_id, type, points, description, reference_type, reference_id, expires_at)
     VALUES ($1, 'EARN', $2, $3, $4, $5, NOW() + INTERVAL '1 year')`,
    [userId, points, `${type}: TSh ${amount.toLocaleString()}`, type, referenceId]
  );

  // Check tier upgrade
  const newRewards = await pool.query(`SELECT * FROM rewards WHERE user_id = $1`, [userId]);
  const newTotal = newRewards.rows[0].total_earned;
  let newTier = 'BRONZE';
  if (newTotal >= TIERS.PLATINUM.min) newTier = 'PLATINUM';
  else if (newTotal >= TIERS.GOLD.min) newTier = 'GOLD';
  else if (newTotal >= TIERS.SILVER.min) newTier = 'SILVER';

  if (newTier !== rewards.tier) {
    await pool.query(`UPDATE rewards SET tier = $1, updated_at = NOW() WHERE user_id = $2`, [newTier, userId]);
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'Uboreshaji wa Kiwango!', $3, 'REWARD')`,
      [userId, `Umefikia kiwango cha ${newTier}!`]
    );
  }

  return { points, total: newRewards.rows[0].points, tier: newTier };
}

async function redeemPoints(userId, points, description) {
  const rewards = await getOrCreateRewards(userId);
  if (rewards.points < points) throw new Error('Pointi hazitoshi.');

  // Convert points to TSh (100 points = TSh 100)
  const cashValue = Math.floor(points / 100);

  await pool.query(
    `UPDATE rewards SET points = points - $1, total_redeemed = total_redeemed + $1, updated_at = NOW() WHERE user_id = $2`,
    [points, userId]
  );

  await pool.query(
    `INSERT INTO reward_transactions (user_id, type, points, description, reference_type)
     VALUES ($1, 'REDEEM', $2, $3, 'CASHBACK')`,
    [userId, points, description || `Ukitumia ${points} pointi`]
  );

  // Credit wallet
  if (cashValue > 0) {
    await pool.query(
      `UPDATE wallets SET wallet_amount = wallet_amount + $1, updated_at = NOW() WHERE user_id = $2`,
      [cashValue, userId]
    );
    await pool.query(
      `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, meta)
       VALUES ($1, 'DEPOSIT', $2, 0, 'SUCCESS', $3, $4)`,
      [userId, cashValue, `REWARD-${Date.now()}`, JSON.stringify({ type: 'CASHBACK', points })]
    );
  }

  const updated = await pool.query(`SELECT * FROM rewards WHERE user_id = $1`, [userId]);
  return { redeemed: points, cashValue, remaining: updated.rows[0].points };
}

async function getRewardsSummary(userId) {
  const rewards = await getOrCreateRewards(userId);
  const recent = await pool.query(
    `SELECT * FROM reward_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );

  const tierInfo = TIERS[rewards.tier] || TIERS.BRONZE;
  const nextTier = Object.entries(TIERS).find(([_, v]) => v.min > rewards.total_earned);

  return {
    ...rewards,
    tierInfo,
    nextTier: nextTier ? { name: nextTier[0], min: nextTier[1].min, remaining: nextTier[1].min - rewards.total_earned } : null,
    recentTransactions: recent.rows,
    cashValue: Math.floor(rewards.points / 100),
  };
}

module.exports = { earnPoints, redeemPoints, getRewardsSummary, getOrCreateRewards };
