/**
 * Budgeting Service
 * Category-level monthly budgets with spend tracking and over-budget alerts.
 *
 * Actual spend is derived from the transactions ledger (debit movements:
 * TRANSFER / WITHDRAWAL) attributed to spending categories, mirroring the
 * existing spending-analytics model so budgets reconcile with what the user
 * actually paid out of their wallet.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

/** Current month key, e.g. '2026-09'. */
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Spend per category for a user in a given period. */
async function spendByCategory(userId, periodKey) {
  const from = `${periodKey}-01 00:00:00`;
  const to = `${periodKey}-31 23:59:59`;
  const result = await pool.query(
    `SELECT sc.id AS category_id, sc.name, sc.icon, sc.color,
            COALESCE(SUM(t.total_charged), 0)::numeric AS spent,
            COUNT(t.id)::int AS tx_count
     FROM spending_categories sc
     LEFT JOIN transactions t
       ON t.category_id = sc.id
       AND t.user_id = $1
       AND t.type IN ('TRANSFER', 'WITHDRAWAL')
       AND t.status = 'SUCCESS'
       AND t.created_at >= $2::timestamptz
       AND t.created_at <  $3::timestamptz
     GROUP BY sc.id, sc.name, sc.icon, sc.color
     ORDER BY spent DESC`,
    [userId, from, to]
  );
  return result.rows;
}

/** Income (deposits) for a period - used by overview. */
async function incomeForPeriod(userId, periodKey) {
  const from = `${periodKey}-01 00:00:00`;
  const to = `${periodKey}-31 23:59:59`;
  const result = await pool.query(
    `SELECT COALESCE(SUM(total_charged), 0)::numeric AS income
     FROM transactions
     WHERE user_id = $1 AND type = 'DEPOSIT' AND status = 'SUCCESS'
       AND created_at >= $2::timestamptz
       AND created_at <  $3::timestamptz`,
    [userId, from, to]
  );
  return Number(result.rows[0].income);
}

/** All budgets for a user in a period, enriched with spend + progress. */
async function getBudgets(userId, periodKey = monthKey()) {
  const [budgets, spendRows] = await Promise.all([
    pool.query(
      `SELECT b.*, sc.name AS category_name, sc.icon AS category_icon, sc.color AS category_color
       FROM budgets b
       JOIN spending_categories sc ON sc.id = b.category_id
       WHERE b.user_id = $1 AND b.period_key = $2
       ORDER BY b.amount DESC`,
      [userId, periodKey]
    ),
    spendByCategory(userId, periodKey),
  ]);

  const spendMap = new Map(spendRows.map((s) => [s.category_id, s]));

  return budgets.rows.map((b) => {
    const spendRow = spendMap.get(b.category_id) || { spent: 0, tx_count: 0 };
    const spent = Number(spendRow.spent);
    const amount = Number(b.amount);
    const pct = amount > 0 ? Math.round((spent / amount) * 1000) / 10 : 0;
    return {
      ...b,
      amount,
      spent,
      tx_count: Number(spendRow.tx_count || 0),
      progress_pct: pct,
      remaining: Math.max(0, amount - spent),
      over: spendRow.spent && spent > amount,
    };
  });
}

/** Upsert (set) a monthly budget for a category. Returns the row + progress. */
async function setBudget(userId, { category_id, period_key, amount, notes }) {
  if (!category_id) throw Object.assign(new Error('Chagua kategoria.'), { statusCode: 400 });
  const amt = Number(amount);
  if (!(amt >= 0)) throw Object.assign(new Error('Kiasi cha bajeti lazima kiwe kizuri.'), { statusCode: 400 });
  const pkey = period_key || monthKey();

  const existing = await pool.query(
    `SELECT id FROM budgets WHERE user_id = $1 AND category_id = $2 AND period_key = $3`,
    [userId, category_id, pkey]
  );

  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE budgets SET amount = $1, notes = $2, updated_at = NOW()
       WHERE id = $3`,
      [amt, notes || null, existing.rows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO budgets (user_id, category_id, period_key, amount, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, category_id, pkey, amt, notes || null]
    );
  }

  const [budgets] = await Promise.all([getBudgets(userId, pkey)]);
  // refresh alerts for the period
  await generateAlerts(userId, pkey);
  return (budgets.find((b) => b.category_id === category_id)) || budgets;
}

/** Remove a budget for a period. */
async function deleteBudget(userId, budgetId) {
  const result = await pool.query(
    `DELETE FROM budgets WHERE id = $1 AND user_id = $2`, [budgetId, userId]
  );
  return { deleted: result.rowCount > 0 };
}

/** Recompute + persist over-threshold alerts for a user+period. */
async function generateAlerts(userId, periodKey = monthKey()) {
  try {
    const budgets = await getBudgets(userId, periodKey);
    for (const b of budgets) {
      if (b.amount > 0 && b.spent >= b.amount) {
        await pool.query(
          `INSERT INTO budget_alerts (user_id, budget_id, period_key, category_id, threshold_pct, spent, budget_amount, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
           ON CONFLICT DO NOTHING`,
          [userId, b.id, periodKey, b.category_id, 100, b.spent, b.amount]
        );
      }
    }
  } catch (e) {
    logger.error('BUDGET_ALERT', e.message, { userId, periodKey });
  }
}

/** Active/budget-follow alerts. */
async function getAlerts(userId) {
  const result = await pool.query(
    `SELECT a.*, sc.name AS category_name, sc.icon AS category_icon
     FROM budget_alerts a
     LEFT JOIN spending_categories sc ON sc.id = a.category_id
     WHERE a.user_id = $1 AND a.status = 'ACTIVE'
     ORDER BY a.created_at DESC`,
    [userId]
  );
  return result.rows;
}

/** Acknowledge/dismiss an alert. */
async function ackAlert(userId, alertId) {
  const result = await pool.query(
    `UPDATE budget_alerts SET status = 'ACKNOWLEDGED'
     WHERE id = $1 AND user_id = $2 RETURNING *`, [alertId, userId]
  );
  return result.rows[0];
}

/**
 * Overview: total budget vs total spent, income, savings rate and number of
 * categories over budget for the period. Feeds the Financial Health engine.
 */
async function getOverview(userId, periodKey = monthKey()) {
  const [budgets, income] = await Promise.all([
    getBudgets(userId, periodKey),
    incomeForPeriod(userId, periodKey),
  ]);

  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
  const totalSpent = budgets.reduce((s, b) => s + b.spent, 0);
  const overCount = budgets.filter((b) => b.over).length;
  const savingsRate = income > 0 ? Math.round(((income - totalSpent) / income) * 1000) / 10 : 0;

  return {
    period_key: periodKey,
    income,
    total_budget: totalBudget,
    total_spent: totalSpent,
    over_count: overCount,
    budgeted_categories: budgets.length,
    savings_rate: Math.max(0, savingsRate),
  };
}

/** Full category list for the budgeting UI. */
async function getCategories() {
  const result = await pool.query(
    `SELECT id, name, icon, color FROM spending_categories ORDER BY name`
  );
  return result.rows;
}

module.exports = {
  getBudgets,
  setBudget,
  deleteBudget,
  getAlerts,
  ackAlert,
  getOverview,
  getCategories,
  generateAlerts,
  monthKey,
};
