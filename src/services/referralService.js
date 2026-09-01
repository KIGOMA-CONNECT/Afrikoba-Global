const pool = require('../config/db');
const { createNotification } = require('./notificationService');
const logger = require('../utils/logger');
const crypto = require('crypto');
const fin = require('../services/financialEngine');

/**
 * Referral system — users invite friends, earn rewards on first deposit.
 */

/**
 * Generate a referral code for a user.
 */
async function generateReferralCode(userId) {
  const existing = await pool.query(
    'SELECT code FROM referral_codes WHERE user_id = $1',
    [userId]
  );
  if (existing.rows.length > 0) return existing.rows[0].code;

  const code = `AFB${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  await pool.query(
    'INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)',
    [userId, code]
  );
  return code;
}

/**
 * Get referral code for a user.
 */
async function getReferralCode(userId) {
  const result = await pool.query(
    'SELECT * FROM referral_codes WHERE user_id = $1',
    [userId]
  );
  if (result.rows.length === 0) return await generateReferralCode(userId);
  return result.rows[0].code;
}

/**
 * Record a referral (when new user registers with code).
 */
async function recordReferral(referredUserId, referralCode) {
  const codeResult = await pool.query(
    'SELECT * FROM referral_codes WHERE code = $1 AND is_active = TRUE',
    [referralCode]
  );
  if (codeResult.rows.length === 0) return null;

  const referrerId = codeResult.rows[0].user_id;
  if (referrerId === referredUserId) return null;

  const existing = await pool.query(
    'SELECT id FROM referrals WHERE referred_user_id = $1',
    [referredUserId]
  );
  if (existing.rows.length > 0) return null;

  await pool.query(
    `INSERT INTO referrals (referrer_user_id, referred_user_id, referral_code, status)
     VALUES ($1, $2, $3, 'PENDING')`,
    [referrerId, referredUserId, referralCode]
  );

  return referrerId;
}

/**
 * Reward referral when referred user makes first qualifying deposit.
 */
async function rewardReferral(userId) {
  const result = await pool.query(
    `SELECT r.id, r.referrer_user_id, ss.setting_value AS reward_amount
     FROM referrals r
     JOIN system_settings ss ON ss.setting_key = 'referral_reward_amount'
     WHERE r.referred_user_id = $1 AND r.status = 'PENDING'`,
    [userId]
  );

  if (result.rows.length === 0) return null;

  const referral = result.rows[0];
  const rewardAmount = parseFloat(referral.reward_amount) || 5000;

  // Check if referred user meets minimum deposit
  const depositResult = await pool.query(
    `SELECT SUM(wallet_amount)::numeric AS total_deposited
     FROM transactions WHERE user_id = $1 AND type = 'DEPOSIT' AND status = 'SUCCESS'`,
    [userId]
  );

  const minDepositResult = await pool.query(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'referral_min_deposit'"
  );
  const minDeposit = parseFloat(minDepositResult.rows[0]?.setting_value) || 10000;

  const totalDeposited = parseFloat(depositResult.rows[0].total_deposited) || 0;
  if (totalDeposited < minDeposit) return null;

  // Credit referrer
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({
      client,
      userId: referral.referrer_user_id,
      amount: Number(rewardAmount),
      reference: `REF:${referral.id}:CR`,
      fromAccount: 'REFERRAL_REWARD',
      description: `Referral reward for referring user ${userId}`,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Create transaction
  await pool.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, type, status, meta)
     VALUES ($1, $2, $3, 0, $3, 'DEPOSIT', 'SUCCESS', $4)`,
    [`REF-${Date.now()}`, referral.referrer_user_id, rewardAmount, JSON.stringify({ source: 'referral', referred_user: userId })]
  );

  // Update referral
  await pool.query(
    `UPDATE referrals SET status = 'REWARDED', reward_amount = $1, rewarded_at = NOW() WHERE id = $2`,
    [rewardAmount, referral.id]
  );

  // Update referrer stats
  await pool.query(
    'UPDATE referral_codes SET total_referrals = total_referrals + 1, total_earned = total_earned + $1 WHERE user_id = $2',
    [rewardAmount, referral.referrer_user_id]
  );

  // Notify referrer
  await createNotification(referral.referrer_user_id, {
    title: 'Referral Reward!',
    body: `You earned TSh ${rewardAmount.toLocaleString()} for referring a friend!`,
    type: 'PROMO',
  });

  return { rewardAmount, referrerId: referral.referrer_user_id };
}

/**
 * Get referral stats for a user.
 */
async function getReferralStats(userId) {
  const codeResult = await pool.query(
    'SELECT * FROM referral_codes WHERE user_id = $1',
    [userId]
  );

  const referralsResult = await pool.query(
    `SELECT r.*, u.full_name AS referred_name
     FROM referrals r
     JOIN users u ON u.id = r.referred_user_id
     WHERE r.referrer_user_id = $1
     ORDER BY r.created_at DESC`,
    [userId]
  );

  const code = codeResult.rows[0] || { code: await generateReferralCode(userId), total_referrals: 0, total_earned: 0 };

  return {
    code: code.code,
    totalReferrals: code.total_referrals,
    totalEarned: parseFloat(code.total_earned),
    referrals: referralsResult.rows,
  };
}

/**
 * Get all referrals (admin).
 */
async function getAllReferrals({ page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM referrals');
  const result = await pool.query(
    `SELECT r.*, referrer.full_name AS referrer_name, referred.full_name AS referred_name
     FROM referrals r
     JOIN users referrer ON referrer.id = r.referrer_user_id
     JOIN users referred ON referred.id = r.referred_user_id
     ORDER BY r.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return {
    referrals: result.rows,
    total: countResult.rows[0].total,
    page,
    limit,
    totalPages: Math.ceil(countResult.rows[0].total / limit),
  };
}

module.exports = { generateReferralCode, getReferralCode, recordReferral, rewardReferral, getReferralStats, getAllReferrals };
