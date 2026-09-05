/**
 * Trust-Score Driven Credit Limits
 *
 * Computes an explainable per-user revolving credit limit from the AFRIKOBA
 * trust score (users.trust_score) and the credit score, then enforces it at
 * loan application time so the combined outstanding principal never exceeds it.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

// Mapping of trust score (0-100) to a limit base multiplier and cap tier.
function tierForTrust(trust) {
  if (trust >= 85) return { label: 'PREMIUM', base: 0.25, cap: 20000000 };
  if (trust >= 70) return { label: 'TRUSTED', base: 0.15, cap: 10000000 };
  if (trust >= 55) return { label: 'STANDARD', base: 0.10, cap: 5000000 };
  return { label: 'MONITORED', base: 0.05, cap: 2000000 };
}

/**
 * Compute the current credit limit for a user.
 * limit = base(trust tier) * reference-activity + creditScore adjustment, capped.
 */
async function getCreditLimit(userId) {
  const user = (await pool.query(
    'SELECT trust_score, wallet_balance FROM users WHERE id=$1', [userId]
  )).rows[0];
  if (!user) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });

  const trust = Number(user.trust_score) || 0;
  const balance = Number(user.wallet_balance) || 0;
  const tier = tierForTrust(trust);

  // Credit score (best effort from cache/calc)
  const creditService = require('./creditScoreService');
  let score;
  try { score = (await creditService.getScore(userId)).score; } catch (e) { score = 400; }

  // Reference activity base: ~10x recent 90-day inflow
  const inflow = (await pool.query(
    `SELECT COALESCE(SUM(wallet_amount),0)::numeric AS a
       FROM transactions
      WHERE user_id=$1 AND wallet_amount > 0 AND created_at > NOW() - INTERVAL '90 days'`,
    [userId]
  )).rows[0]?.a || 0;

  // Score adjustment 0.5x..1.5x around a 600 mid-point
  const scoreFactor = Math.min(1.5, Math.max(0.5, score / 600));
  const activityBase = Number(inflow) * 0.15 || balance * 3;

  let limit = tier.base * activityBase * scoreFactor;
  limit = Math.min(limit, tier.cap);
  // sanity floor
  limit = Math.max(limit, balance > 0 ? balance : 50000);
  limit = Math.round(limit);

  return {
    userId,
    creditLimit: limit,
    tier: tier.label,
    trustScore: trust,
    creditScore: score,
    factors: {
      trustTierBase: tier.base,
      creditScoreFactor: +scoreFactor.toFixed(2),
      activityBase: Math.round(activityBase),
      cap: tier.cap,
    },
  };
}

/** Combined outstanding principal across micro-loans + vicooba loans. */
async function existingExposure(userId) {
  let ml = 0;
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(due_amount - paid_amount),0)::numeric AS a
         FROM micro_loans WHERE user_id=$1 AND status IN ('ACTIVE','DISBURSED','APPROVED')`,
      [userId]
    );
    ml = Number(r.rows[0]?.a || 0);
  } catch (e) { ml = 0; }

  let vl = 0;
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(outstanding_balance),0)::numeric AS a
         FROM vicoba_loan_requests
        WHERE applicant_user_id=$1 AND status IN ('ACTIVE','APPROVED','DISBURSED','PENDING')`,
      [userId]
    );
    vl = Number(r.rows[0]?.a || 0);
  } catch (e) { vl = 0; }

  return ml + vl;
}

/**
 * Enforce the credit limit against a requested amount.
 * Throws if the new combined exposure would exceed the limit (explainable reasons).
 * Returns { approved, limit, newExposure, available, reasons }.
 */
async function enforceCreditLimit(userId, amount) {
  const limitData = await getCreditLimit(userId);
  const currentExposure = await existingExposure(userId);
  const requested = Number(amount) || 0;
  const newExposure = currentExposure + requested;
  const available = Math.max(0, limitData.creditLimit - currentExposure);

  const reasons = [];
  let approved = requested > 0 && newExposure <= limitData.creditLimit;

  if (requested <= 0) reasons.push('Amount must be positive.');
  if (!approved) {
    reasons.push(`Requested ${Math.round(requested).toLocaleString()} plus existing exposure ${Math.round(currentExposure).toLocaleString()} (total ${Math.round(newExposure).toLocaleString()}) would exceed your credit limit of ${Math.round(limitData.creditLimit).toLocaleString()}. Available: ${Math.round(available).toLocaleString()}.`);
  }

  return {
    approved,
    requested,
    creditLimit: limitData.creditLimit,
    currentExposure: Math.round(currentExposure),
    newExposure: Math.round(newExposure),
    available: Math.round(available),
    tier: limitData.tier,
    trustScore: limitData.trustScore,
    reasons,
  };
}

module.exports = { getCreditLimit, enforceCreditLimit, existingExposure };
