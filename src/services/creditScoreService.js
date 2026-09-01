/**
 * Credit Scoring Service
 * Calculate credit scores based on user activity.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

// Scoring factors and weights
const FACTORS = {
  ACCOUNT_AGE: { weight: 100, maxScore: 100 },
  KYC_LEVEL: { weight: 150, maxScore: 150 },
  TRANSACTION_VOLUME: { weight: 200, maxScore: 200 },
  TRANSACTION_REGULARITY: { weight: 150, maxScore: 150 },
  BALANCE_MAINTENANCE: { weight: 100, maxScore: 100 },
  LOAN_REPAYMENT: { weight: 200, maxScore: 200 },
  VICOBA_PARTICIPATION: { weight: 100, maxScore: 100 },
  DISPUTE_HISTORY: { weight: -100, maxScore: -100 },
  FRAUD_ALERTS: { weight: -200, maxScore: -200 },
};

/**
 * Calculate credit score for user.
 */
async function calculateScore(userId) {
  const factors = [];
  let totalScore = 0;

  // 1. Account age (0-100 points)
  const accountAge = await pool.query(
    `SELECT EXTRACT(DAY FROM NOW() - created_at)::int AS days FROM users WHERE id = $1`,
    [userId]
  );
  const days = accountAge.rows[0]?.days || 0;
  const ageScore = Math.min(100, Math.floor(days / 3)); // Max at 300 days (~10 months)
  factors.push({ factor: 'ACCOUNT_AGE', score: ageScore, detail: `${days} days` });
  totalScore += ageScore;

  // 2. KYC level (0-150 points)
  const kyc = await pool.query(`SELECT kyc_level FROM users WHERE id = $1`, [userId]);
  const kycLevel = kyc.rows[0]?.kyc_level || 0;
  const kycScore = kycLevel * 50;
  factors.push({ factor: 'KYC_LEVEL', score: kycScore, detail: `Level ${kycLevel}` });
  totalScore += kycScore;

  // 3. Transaction volume (0-200 points)
  const txVolume = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_charged), 0)::numeric AS total
     FROM transactions WHERE user_id = $1 AND status = 'SUCCESS'`,
    [userId]
  );
  const txCount = txVolume.rows[0]?.count || 0;
  const volumeScore = Math.min(200, Math.floor(txCount * 2));
  factors.push({ factor: 'TRANSACTION_VOLUME', score: volumeScore, detail: `${txCount} transactions` });
  totalScore += volumeScore;

  // 4. Transaction regularity (0-150 points)
  const regularity = await pool.query(
    `SELECT COUNT(DISTINCT DATE_TRUNC('week', created_at))::int AS weeks
     FROM transactions WHERE user_id = $1 AND status = 'SUCCESS'
     AND created_at > NOW() - INTERVAL '3 months'`,
    [userId]
  );
  const activeWeeks = regularity.rows[0]?.weeks || 0;
  const regularityScore = Math.min(150, activeWeeks * 15);
  factors.push({ factor: 'REGULARITY', score: regularityScore, detail: `${activeWeeks} active weeks` });
  totalScore += regularityScore;

  // 5. Balance maintenance (0-100 points)
  const wallet = await pool.query(
    `SELECT wallet_balance FROM users WHERE id = $1`,
    [userId]
  );
  const balance = parseFloat(wallet.rows[0]?.wallet_balance || 0);
  const balanceScore = Math.min(100, Math.floor(balance / 10000));
  factors.push({ factor: 'BALANCE', score: balanceScore, detail: `TSh ${balance.toLocaleString()}` });
  totalScore += balanceScore;

  // 6. Loan repayment (-200 to 200 points)
  const loans = await pool.query(
    `SELECT COUNT(*)::int AS total,
       COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END)::int AS repaid
     FROM vicoba_loans WHERE borrower_id = $1`,
    [userId]
  );
  const loanTotal = loans.rows[0]?.total || 0;
  const loanRepaid = loans.rows[0]?.repaid || 0;
  const loanScore = loanTotal > 0 ? Math.floor((loanRepaid / loanTotal) * 200) : 100;
  factors.push({ factor: 'LOAN_REPAYMENT', score: loanScore, detail: `${loanRepaid}/${loanTotal} repaid` });
  totalScore += loanScore;

  // 7. VICOBA participation (0-100 points)
  const vicoba = await pool.query(
    `SELECT COUNT(*)::int AS groups FROM vicoba_members WHERE user_id = $1`,
    [userId]
  );
  const groupCount = vicoba.rows[0]?.groups || 0;
  const vicobaScore = Math.min(100, groupCount * 20);
  factors.push({ factor: 'VICOBA', score: vicobaScore, detail: `${groupCount} groups` });
  totalScore += vicobaScore;

  // 8. Dispute history (negative)
  const disputes = await pool.query(
    `SELECT COUNT(*)::int AS count FROM disputes WHERE user_id = $1`,
    [userId]
  );
  const disputeCount = disputes.rows[0]?.count || 0;
  const disputePenalty = Math.min(100, disputeCount * 25);
  factors.push({ factor: 'DISPUTES', score: -disputePenalty, detail: `${disputeCount} disputes` });
  totalScore -= disputePenalty;

  // 9. Fraud alerts (negative)
  const fraud = await pool.query(
    `SELECT COUNT(*)::int AS count FROM fraud_alerts WHERE user_id = $1 AND is_resolved = FALSE`,
    [userId]
  );
  const fraudCount = fraud.rows[0]?.count || 0;
  const fraudPenalty = Math.min(200, fraudCount * 50);
  factors.push({ factor: 'FRAUD_ALERTS', score: -fraudPenalty, detail: `${fraudCount} alerts` });
  totalScore -= fraudPenalty;

  // Clamp score to 0-800
  totalScore = Math.max(0, Math.min(800, totalScore));

  // Save to DB
  await pool.query(
    `INSERT INTO credit_scores (user_id, score, factors, last_calculated)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       score = $2, factors = $3, last_calculated = NOW(), updated_at = NOW()`,
    [userId, totalScore, JSON.stringify(factors)]
  );

  return {
    score: totalScore,
    rating: getRating(totalScore),
    factors,
    calculatedAt: new Date().toISOString(),
  };
}

function getRating(score) {
  if (score >= 700) return { label: 'Excellent', labelSw: 'Bora', color: '#4CAF50' };
  if (score >= 600) return { label: 'Good', labelSw: 'Nzuri', color: '#8BC34A' };
  if (score >= 500) return { label: 'Fair', labelSw: 'Wastani', color: '#FFC107' };
  if (score >= 400) return { label: 'Below Average', labelSw: 'Chini ya Wastani', color: '#FF9800' };
  return { label: 'Poor', labelSw: 'Mbaya', color: '#F44336' };
}

/**
 * Get cached score or calculate.
 */
async function getScore(userId) {
  const cached = await pool.query(
    `SELECT * FROM credit_scores WHERE user_id = $1 AND last_calculated > NOW() - INTERVAL '7 days'`,
    [userId]
  );
  if (cached.rows.length > 0) {
    return {
      score: cached.rows[0].score,
      rating: getRating(cached.rows[0].score),
      factors: cached.rows[0].factors,
      calculatedAt: cached.rows[0].last_calculated,
    };
  }
  return calculateScore(userId);
}

/**
 * Check loan eligibility.
 */
async function checkEligibility(userId, amount, termMonths) {
  const scoreData = await getScore(userId);
  const products = await pool.query(
    `SELECT * FROM loan_products WHERE is_active = TRUE AND min_amount <= $1 AND max_amount >= $1 AND min_term_months <= $2 AND max_term_months >= $2`,
    [amount, termMonths]
  );

  const eligibleProducts = products.rows.filter((p) => scoreData.score >= p.eligibility_min_score);

  return {
    creditScore: scoreData.score,
    rating: scoreData.rating,
    eligible: eligibleProducts.length > 0,
    products: eligibleProducts.map((p) => ({
      ...p,
      monthlyPayment: calculateMonthlyPayment(amount, p.interest_rate, termMonths),
      totalPayable: calculateMonthlyPayment(amount, p.interest_rate, termMonths) * termMonths,
    })),
  };
}

function calculateMonthlyPayment(principal, annualRate, months) {
  const monthlyRate = annualRate / 100 / 12;
  if (monthlyRate === 0) return principal / months;
  return principal * (monthlyRate * Math.pow(1 + monthlyRate, months)) / (Math.pow(1 + monthlyRate, months) - 1);
}

module.exports = { calculateScore, getScore, checkEligibility, getRating };
