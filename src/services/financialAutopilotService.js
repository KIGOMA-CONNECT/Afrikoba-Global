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
const fin = require('./financialEngine');
const { logAction } = require('./auditService');
const logger = require('../utils/logger');

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

// ====================================================================
// AUTO-EXECUTION (Phase 13) - opted-in, journaled savings automation.
// The ADVISORY buildPlan above becomes EXPLICIT, governed automation here.
// ====================================================================

function badge(err, statusCode) {
  return Object.assign(new Error(err), { statusCode });
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function periodKey(d) {
  const date = d || new Date();
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`; // e.g. 202609 (monthly period)
}

/**
 * Activate an autopilot plan.
 * Derives the recommended MONTHLY allocation from the user's current passport
 * plan (governance: snapshotted at activation so it never silently changes),
 * then persists the opt-in objective.
 */
async function activatePlan(userId, data) {
  const { target_amount, goal_id, frequency } = data || {};
  const target = Number(target_amount);
  if (!target || target <= 0) throw badge('Target (lengo) ni lazima kiwe chanya.', 400);

  const plan = await buildPlan({ userId, targetAmount: target });
  const monthly = Math.max(0, Math.round(plan.numbers.monthlySavings));
  if (monthly <= 0) {
    throw badge('Hakuna uwezo wa kuweka akiba kila mwezi (disposable capacity ni 0). Rekebisha mapato au gharama.', 400);
  }

  if (goal_id) {
    const g = await pool.query("SELECT id FROM savings_goals WHERE id=$1 AND user_id=$2 AND status='ACTIVE'", [goal_id, userId]);
    if (!g.rows.length) throw badge('Lengo (goal) halipatikani.', 404);
  }

  const freq = ['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency) ? frequency : 'MONTHLY';
  const res = await pool.query(
    `INSERT INTO autopilot_plans (user_id, goal_id, target_amount, monthly_allocation, frequency, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE') RETURNING *`,
    [userId, goal_id || null, target, monthly, freq]
  );
  await logAction(userId, 'AUTOPILOT_ACTIVATED', 'AUTOPILOT_PLAN', res.rows[0].id,
    `Autopilot: TZS ${monthly}/month toward TZS ${target}`);
  logger.info('AUTOPILOT', `User ${userId} activated plan #${res.rows[0].id} at ${monthly}/mo`);
  return { plan: res.rows[0], monthlyAllocationSnapshot: monthly, basedOnPassportVersion: plan.basedOnPassportVersion };
}

/** List a user's plans. */
async function listPlans(userId) {
  const res = await pool.query(
    `SELECT id, goal_id, target_amount, monthly_allocation, frequency, status,
            last_executed_at, total_saved, skip_count, created_at
       FROM autopilot_plans
      WHERE user_id=$1 ORDER BY created_at DESC`, [userId]
  );
  return res.rows;
}

/** Pause / activate / complete a plan. */
async function setPlanStatus(userId, planId, status) {
  if (!['PAUSED', 'ACTIVE', 'COMPLETED'].includes(status)) throw badge('status si sahihi.', 400);
  const res = await pool.query(
    `UPDATE autopilot_plans SET status=$1, updated_at=NOW()
      WHERE id=$2 AND user_id=$3 RETURNING *`,
    [status, planId, userId]
  );
  if (!res.rows.length) throw badge('Mpango haupatikani.', 404);
  await logAction(userId, `AUTOPILOT_${status}`, 'AUTOPILOT_PLAN', planId, `Status -> ${status}`);
  return { plan: res.rows[0] };
}

/** Remove a plan. */
async function deletePlan(userId, planId) {
  const res = await pool.query('DELETE FROM autopilot_plans WHERE id=$1 AND user_id=$2 RETURNING id', [planId, userId]);
  if (!res.rows.length) throw badge('Mpango haupatikani.', 404);
  return { success: true, deleted: planId };
}

/**
 * CRON: execute due autopilot savings for all ACTIVE plans.
 * Safety:
 *   * Idempotent per PERIOD - unique reference AUTOPILOT:<plan>:<YYYYMM> so a
 *     retry can never double-move money (ledger-level uniqueness on reference).
 *   * SKIPS (never fails) if wallet lacks funds OR current passport disposable
 *     capacity has dropped below the snapshotted allocation.
 *   * Journals DR wallet -> CR SUSPENSE via financialEngine, then credits the
 *     goal, mirroring the existing auto-save mechanic.
 */
async function runAutopilotPayouts() {
  const client = await pool.connect();
  let executed = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT p.*, g.name AS goal_name, g.target_amount AS goal_target, g.current_amount AS goal_current
         FROM autopilot_plans p
         LEFT JOIN savings_goals g ON g.id = p.goal_id
        WHERE p.status='ACTIVE' AND p.frequency='MONTHLY'
          AND (p.last_executed_at IS NULL
               OR p.last_executed_at < date_trunc('month', NOW()))`
    );
    for (const plan of due.rows) {
      const alloc = Number(plan.monthly_allocation);
      if (!alloc || alloc <= 0) { skipped += 1; continue; }

      // Current passport affordability check - skip if capacity dropped below allocation.
      let disposable;
      try {
        const up = await getPassport(plan.user_id);
        disposable = Number(up.capacity?.disposable ?? 0);
      } catch (e) {
        disposable = Infinity; // passport failure shouldn't block a funded plan
      }
      if (disposable !== Infinity && disposable < alloc) {
        await client.query(`UPDATE autopilot_plans SET skip_count=skip_count+1, updated_at=NOW() WHERE id=$1`, [plan.id]);
        skipped += 1;
        continue;
      }

      // Wallet funds check.
      const w = await client.query('SELECT wallet_balance FROM users WHERE id=$1 FOR UPDATE', [plan.user_id]);
      if (Number(w.rows[0].wallet_balance) < alloc) {
        await client.query(`UPDATE autopilot_plans SET skip_count=skip_count+1, updated_at=NOW() WHERE id=$1`, [plan.id]);
        skipped += 1;
        continue;
      }

      const reference = `AUTOPILOT:${plan.id}:${periodKey()}`;
      const debit = await fin.debitWallet({ client, userId: plan.user_id, amount: alloc, reference, toAccount: 'SUSPENSE', description: 'Autopilot savings contribution' });
      if (debit.dedup) continue; // this period already executed - never double-move

      // Credit the goal if one is attached.
      if (plan.goal_id) {
        const g = await client.query('SELECT current_amount FROM savings_goals WHERE id=$1 AND status=$2', [plan.goal_id, 'ACTIVE']);
        if (g.rows.length) {
          const newAmount = round2(Number(g.rows[0].current_amount) + alloc);
          const completed = Number(plan.goal_target) > 0 && newAmount >= Number(plan.goal_target);
          await client.query(
            `UPDATE savings_goals
                SET current_amount=$1, status=CASE WHEN $2 THEN 'COMPLETED' ELSE status END,
                    is_completed=$2, completed_at=CASE WHEN $2 THEN NOW() ELSE completed_at END,
                    updated_at=NOW()
              WHERE id=$3`,
            [newAmount, completed, plan.goal_id]
          );
          if (completed) {
            await client.query(`UPDATE autopilot_plans SET status='COMPLETED', updated_at=NOW() WHERE id=$1`, [plan.id]);
          }
        }
      }

      await client.query(
        `UPDATE autopilot_plans
            SET total_saved=total_saved+$1, last_executed_at=NOW(), updated_at=NOW()
          WHERE id=$2`,
        [alloc, plan.id]
      );
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1,$2,$3,0,$3,'SUCCESS','SAVINGS_DEPOSIT',$4)`,
        [generateAutopilotRef(), plan.user_id, alloc, JSON.stringify({ feature: 'autopilot', plan_id: plan.id, goal_id: plan.goal_id || null })]
      );
      executed += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  return { processed: executed, skipped, executed };
}

function generateAutopilotRef() {
  const crypto = require('crypto');
  return `APTX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

module.exports = { buildPlan, buildPlanForUser, DEFAULTS, activatePlan, listPlans, setPlanStatus, deletePlan, runAutopilotPayouts };
