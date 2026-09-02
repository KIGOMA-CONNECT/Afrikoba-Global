/**
 * AFRIKOBA FINANCIAL AUTOPILOT
 * Advisory financial-planning layer built on the Financial Passport.
 *
 * Converts a user's profile + objectives into a controlled, explainable plan:
 *   income -> essential expenses -> existing commitments -> savings allocation
 *          -> emergency reserve -> growth/investment allocation.
 *
 * Design principles:
 *   * ADVISORY ONLY in this slice: it RECOMMENDS and PLANS; it never auto-moves
 *     money. (Auto-execution would touch the ledger and belongs behind an
 *     explicit opt-in with its own journaled flows.)
 *   * EXPLAINABLE: every recommendation carries a reason and the maths behind it.
 *   * DETERMINISTIC and ledger-consistent (read-only on projections).
 */

const pool = require('../config/db');
const { getPassport } = require('./financialPassportService');

// Configurable guardrails (sensible defaults, overridable later)
const DEFAULTS = {
  emergencyReserveMonths: 3,      // months of essential expenses to hold
  monthlySavingsFraction: 0.30,   // share of disposable capacity to save
  growthFraction: 0.20,           // share of disposable capacity for growth
  maxObligationToCashflow: 0.40,  // obligations should stay <= 40% of cashflow
};

/** Essential monthly expenses = non-DEPOSIT outflows (3-month average). */
async function essentialExpenses(userId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type <> 'DEPOSIT' THEN total_charged END),0)::numeric AS spend
       FROM transactions
      WHERE user_id=$1 AND status='SUCCESS' AND created_at > NOW() - INTERVAL '3 months'`, [userId]
  );
  return Math.round(parseFloat(r.rows[0]?.spend || 0) / 3);
}

/**
 * Build a user's financial plan.
 * @param {object} opts
 * @param opts.userId
 * @param opts.targetAmount - optional savings objective (TZS) for horizon calc
 * @param opts.emergencyMonths - override reserve horizon (default 3)
 * @returns {object} explainable plan
 */
async function buildPlan({ userId, targetAmount, emergencyMonths }) {
  const passport = await getPassport(userId);
  const expense = await essentialExpenses(userId);

  const cap = passport.capacity;
  const income = cap.monthlyIncome || 0;
  const cashflow = cap.cashflow || 0;
  const obligations = cap.obligations || 0;
  const disposable = cap.disposable ?? Math.max(0, cashflow - obligations);

  // Financial position
  let position, positionReason;
  if (cashflow < 0) {
    position = 'AT_RISK';
    positionReason = 'Outflows exceed inflows; expenses are above income.';
  } else if (obligations / Math.max(1, cashflow) > DEFAULTS.maxObligationToCashflow) {
    position = 'WATCHING';
    positionReason = `Obligations are ${Math.round((obligations / Math.max(1, cashflow)) * 100)}% of cashflow (over the ${Math.round(DEFAULTS.maxObligationToCashflow * 100)}% threshold).`;
  } else if (disposable <= 0) {
    position = 'AT_RISK';
    positionReason = 'No disposable capacity remains after obligations.';
  } else {
    position = 'STABLE';
    positionReason = 'Inflows exceed outflows with capacity left after obligations.';
  }

  // Emergency reserve (months of essential expenses)
  const reserveMonths = emergencyMonths || DEFAULTS.emergencyReserveMonths;
  const emergencyReserve = expense * reserveMonths;
  const currentBalance = await currentWalletBalance(userId);
  const reserveGap = Math.max(0, emergencyReserve - currentBalance);

  // Savings allocation (bounded by disposable and by a floor that leaves room)
  const monthlySavings = Math.max(0, Math.min(disposable, Math.round(disposable * DEFAULTS.monthlySavingsFraction)));
  const growthAllocation = Math.max(0, Math.min(disposable - monthlySavings, Math.round(disposable * DEFAULTS.growthFraction)));

  // Target horizon
  let targetMonths = null;
  let targetAmountEffective = null;
  if (targetAmount && Number(targetAmount) > 0) {
    targetAmountEffective = Number(targetAmount);
    targetMonths = monthlySavings > 0 ? Math.ceil(targetAmountEffective / monthlySavings) : null;
  }

  // Projected emergency-reserve timeline
  const reserveMonthsToBuild = monthlySavings > 0 ? Math.ceil(reserveGap / monthlySavings) : null;

  const recommendations = [];
  const reasons = [];
  if (position === 'AT_RISK') {
    recommendations.push('Reduce essential outflows or increase income before building savings.');
  }
  if (reserveGap > 0) {
    recommendations.push(`Build an emergency reserve of TZS ${emergencyReserve.toLocaleString()} (${reserveMonths} months of essentials).`);
    reasons.push(`Current reserve covers ~${expense > 0 ? Math.round((currentBalance / expense) * 100) : 0}% of ${reserveMonths} months of expenses.`);
  } else {
    recommendations.push(`Emergency reserve adequately funded at TZS ${emergencyReserve.toLocaleString()}.`);
    reasons.push('Current balance meets the recommended reserve.');
  }
  if (monthlySavings > 0) {
    recommendations.push(`Save about TZS ${monthlySavings.toLocaleString()} monthly.`);
    reasons.push(`${Math.round(DEFAULTS.monthlySavingsFraction * 100)}% of disposable capacity of TZS ${disposable.toLocaleString()}.`);
  } else {
    recommendations.push('No savings allocation yet; build disposable capacity first.');
  }
  if (targetMonths !== null) {
    recommendations.push(`Reach TZS ${targetAmountEffective.toLocaleString()} in approximately ${targetMonths} months.`);
    reasons.push(`TZS ${targetAmountEffective.toLocaleString()} / TZS ${monthlySavings.toLocaleString()} monthly.`);
  }
  if (growthAllocation > 0 && position === 'STABLE') {
    recommendations.push(`Consider allocating up to TZS ${growthAllocation.toLocaleString()} monthly to growth/investment.`);
    reasons.push(`${Math.round(DEFAULTS.growthFraction * 100)}% of disposable capacity, kept within plan guardrails.`);
  }

  return {
    userId,
    position,
    positionReason,
    summary: `Current financial position: ${position}. Recommended emergency reserve: TZS ${emergencyReserve.toLocaleString()}. Recommended monthly savings: TZS ${monthlySavings.toLocaleString()}.` +
      (targetMonths !== null ? ` Target achievement: approximately ${targetMonths} months.` : '') +
      ` Current obligations: TZS ${obligations.toLocaleString()}/month. Available discretionary capacity: TZS ${disposable.toLocaleString()}/month.`,
    numbers: {
      monthlyIncome: income,
      essentialExpenses: expense,
      monthlyCashflow: cashflow,
      committedObligations: obligations,
      disposableCapacity: disposable,
      monthlySavings,
      growthAllocation,
      emergencyReserve,
      emergencyReserveMonths: reserveMonths,
      emergencyReserveGap: reserveGap,
      currentBalance,
    },
    target: targetAmountEffective ? {
      amount: targetAmountEffective,
      monthlyAllocation: monthlySavings,
      months: targetMonths,
    } : null,
    recommendations,
    reasons,
    basedOnPassportVersion: passport.version,
    planDate: new Date().toISOString(),
  };
}

async function currentWalletBalance(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [userId]);
  return parseFloat(r.rows[0]?.wallet_balance || 0);
}

async function buildPlanForUser(userId, opts = {}) {
  return buildPlan({ userId, ...opts });
}

module.exports = { buildPlan, buildPlanForUser, DEFAULTS };
