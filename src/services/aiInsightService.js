/**
 * AI Financial Intelligence Service (Phase 8)
 *
 * Self-hosted, statistical/heuristic "bank-grade" financial intelligence. No
 * personal data is sent to any third-party model; every insight is computed
 * from the user's own transaction and behavioural history and persisted to
 * `ai_insights` for auditability.
 *
 * Generators: spending concentration, cashflow forecast, savings rate, budget
 * health, anomaly detection, credit readiness, loan relief, monthly digest.
 * Each generator returns { insight_type, severity, title, body, metric } and a
 * contribution to an aggregate 0-100 financial health score.
 */

const pool = require('../config/db');

const MODEL = 'afri-ai-1.0';
const MODEL_KEY = 'ai-financial-intelligence';

const IN_TYPES = ['DEPOSIT', 'CASH_IN', 'REFERRAL_REWARD', 'CASHBACK', 'INVESTMENT_PAYOUT',
  'ROSCA_PAYOUT', 'VICOBA_PROFIT_PAYOUT', 'REMITTANCE', 'VICOBA_SOCIAL_FUND_DISBURSEMENT',
  'PROJECT_DISTRIBUTION', 'PROJECT_PAYROLL'];
const OUT_TYPES = ['WITHDRAWAL', 'TRANSFER', 'CASH_OUT', 'ROSCA_CONTRIBUTION', 'ROSCA_LOCK',
  'INVESTMENT', 'PROJECT_INVEST', 'VICOBA_SHARE', 'VICOBA_MAINTENANCE_FEE', 'VICOBA_LOAN_REPAYMENT',
  'SUBSCRIPTION', 'BILL_PAYMENT', 'AIRTIME', 'BAP_PAYMENT', 'MERCHANT_PAYMENT', 'FEE', 'SPLIT_PAYMENT',
  'FAMILY_TRANSFER', 'REWARD_REDEEM'];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function txTotals(userId, days) {
  const r = await pool.query(
    `SELECT type,
            SUM(wallet_amount)::numeric AS amount,
            COUNT(*)::int AS cnt
     FROM transactions
     WHERE user_id = $1 AND status = 'SUCCESS' AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
     GROUP BY type`,
    [userId, days]
  );
  return r.rows;
}

async function currentBalanceAndTrust(userId) {
  const r = await pool.query(
    'SELECT wallet_balance, trust_score FROM users WHERE id = $1',
    [userId]
  );
  return r.rows[0] || { wallet_balance: 0, trust_score: 100 };
}

async function budgetHealth(userId) {
  const monthKey = new Date().toISOString().slice(0, 7);
  const r = await pool.query(
    `SELECT COALESCE(SUM(b.amount), 0)::numeric AS total_budget,
            (SELECT COALESCE(SUM(CASE WHEN t.total_charged < 0 THEN 0 ELSE t.total_charged END), 0)::numeric
             FROM transactions t
             WHERE t.user_id = $1 AND t.status='SUCCESS'
               AND TO_CHAR(t.created_at,'YYYY-MM') = $2) AS spent
     FROM budgets b
     WHERE b.user_id = $1 AND b.period_key = $2`,
    [userId, monthKey]
  );
  const row = r.rows[0] || { total_budget: 0, spent: 0 };
  return { budget: Number(row.total_budget || 0), spent: Number(row.spent || 0) };
}

async function savingsPosition(userId) {
  const goals = await pool.query(
    'SELECT COALESCE(SUM(current_amount),0)::numeric AS cur, COALESCE(SUM(target_amount),0)::numeric AS tgt FROM savings_goals WHERE user_id=$1 AND is_completed=FALSE',
    [userId]
  );
  const deposits = await pool.query(
    'SELECT COALESCE(SUM(amount),0)::numeric AS amt FROM fixed_deposits WHERE user_id=$1 AND status = $2',
    [userId, 'ACTIVE']
  );
  return {
    saved: Number(goals.rows[0].cur || 0) + Number(deposits.rows[0].amt || 0),
    goalTarget: Number(goals.rows[0].tgt || 0),
  };
}

async function creditScore(userId) {
  const r = await pool.query('SELECT score FROM credit_scores WHERE user_id = $1', [userId]);
  return r.rows[0] ? Number(r.rows[0].score) : null;
}

// ---------------------------------------------------------------------------
// GENERATORS -> { insight, health_contribution (0-1) }
// ---------------------------------------------------------------------------

async function genSpendConcentration(rows) {
  const spend = rows.filter((t) => OUT_TYPES.includes(t.type));
  const total = spend.reduce((s, t) => s + Number(t.amount), 0);
  if (total <= 0) return [];
  const top = spend.reduce((a, b) => (Number(b.amount) > Number(a.amount) ? b : a), { amount: 0 });
  const share = (Number(top.amount) / total) * 100;
  const arr = [];
  if (share >= 65) {
    arr.push({
      insight_type: 'SPEND_CONCENTRATION', severity: 'warning', metric: round2(share),
      title: 'Spending concentrated in one category',
      body: `${top.type} represents ${round2(share)}% of your spending in the last 30 days. Diversifying reduces risk and frees room to save.`,
      health: 0.55,
    });
  } else if (share >= 40) {
    arr.push({
      insight_type: 'SPEND_CONCENTRATION', severity: 'info', metric: round2(share),
      title: 'Watch spending concentration',
      body: `${top.type} is ${round2(share)}% of recent spend. A diversified mix is healthier.`,
      health: 0.75,
    });
  } else {
    arr.push({
      insight_type: 'SPEND_CONCENTRATION', severity: 'good', metric: round2(share),
      title: 'Balanced spending',
      body: 'Your spending is well diversified — a strong sign of financial discipline.',
      health: 1,
    });
  }
  return arr;
}

async function genCashflow(rows, user) {
  const inflow = rows.filter((t) => IN_TYPES.includes(t.type)).reduce((s, t) => s + Number(t.amount), 0);
  const outflow = rows.filter((t) => OUT_TYPES.includes(t.type)).reduce((s, t) => s + Number(t.total_charged || t.amount), 0);
  const netMonthly = round2((inflow - outflow) / 30 * 30);
  const balance = Number(user.wallet_balance) || 0;
  const months = 2;
  const projected = balance + netMonthly * months;
  if (projected < 0) {
    return [{
      insight_type: 'CASHFLOW', severity: 'alert', metric: round2(projected),
      title: 'Cashflow may turn negative',
      body: `At your current net flow, projected balance in ${months} months is ${round2(projected)}. Consider trimming spending or building a buffer.`,
      health: 0.3,
    }];
  }
  if (projected < balance * 0.5 && balance > 0) {
    return [{
      insight_type: 'CASHFLOW', severity: 'warning', metric: round2(netMonthly),
      title: 'Cashflow is tight',
      body: `Net monthly flow is ${round2(netMonthly)}. Your buffer is depleting — a savings-buffer goal would help.`,
      health: 0.55,
    }];
  }
  return [];
}

async function genSavingsRate(inflow, save) {
  const income = inflow * 30 / 30;
  if (income <= 0) return [];
  const rate = (save.saved / Math.max(income, 1)) * 100;
  if (rate >= 15) {
    return [{ insight_type: 'SAVINGS_RATE', severity: 'good', metric: round2(rate), title: 'Healthy savings rate', body: `You save ~${round2(rate)}% of inflows — above the 15% guideline.` , health: 1 }];
  }
  if (rate >= 5) {
    return [{ insight_type: 'SAVINGS_RATE', severity: 'info', metric: round2(rate), title: 'Savings rate can improve', body: `Savings are ${round2(rate)}% of inflows. Aim for at least 15% using auto-save.`, health: 0.65 }];
  }
  return [{ insight_type: 'SAVINGS_RATE', severity: 'warning', metric: round2(rate), title: 'Low savings rate', body: `You are saving only ${round2(rate)}% of inflows. Set a savings goal and enable auto-save.`, health: 0.4 }];
}

async function genBudget(bh) {
  if (bh.budget <= 0) return [];
  if (bh.spent > bh.budget) {
    return [{ insight_type: 'BUDGET_HEALTH', severity: 'alert', metric: round2(bh.spent - bh.budget), title: 'Over budget this month', body: `You have spent ${round2(bh.spent)} against a budget of ${round2(bh.budget)}. Tighten discretionary spending.` , health: 0.35 }];
  }
  if (bh.spent > bh.budget * 0.85) {
    return [{ insight_type: 'BUDGET_HEALTH', severity: 'info', metric: round2((bh.spent / bh.budget) * 100), title: 'Approaching budget limit', body: `You have used ${round2((bh.spent / bh.budget) * 100)}% of your monthly budget.`, health: 0.7 }];
  }
  return [{ insight_type: 'BUDGET_HEALTH', severity: 'good', metric: round2((bh.spent / bh.budget) * 100), title: 'Within budget', body: 'You are pacing within your budget — keep it up.', health: 1 }];
}

async function genAnomaly(rows) {
  const totals = rows.reduce((acc, t) => {
    acc[t.type] = (acc[t.type] || 0) + Number(t.total_charged || t.amount);
    return acc;
  }, {});
  const isAnomalyLike = (type) => !['ROSCA_PAYOUT', 'PROJECT_DISTRIBUTION', 'DEPOSIT'].includes(type);
  let topAnomaly = null;
  for (const [type, amount] of Object.entries(totals)) {
    if (!isAnomalyLike(type) || amount <= 100000) continue;
    if (!topAnomaly || amount > topAnomaly.amount) topAnomaly = { type, amount };
  }
  if (topAnomaly) {
    return [{
      insight_type: 'ANOMALY', severity: 'warning', metric: round2(topAnomaly.amount),
      title: 'Larger than usual outflow',
      body: `${topAnomaly.type} of ${round2(topAnomaly.amount)} stands out this period. ${topAnomaly.type === 'WITHDRAWAL' ? 'Verify it is expected.' : 'Check for unusual activity.'}`,
      health: 0.5,
    }];
  }
  return [];
}

async function genCredit(score) {
  if (score == null) return [];
  if (score >= 700) {
    return [{ insight_type: 'CREDIT_READINESS', severity: 'good', metric: score, title: 'Credit ready', body: `Your credit score is ${score} — strong eligibility for financing.`, health: 1 }];
  }
  if (score >= 500) {
    return [{ insight_type: 'CREDIT_READINESS', severity: 'info', metric: score, title: 'Credit score building', body: `Your credit score is ${score}. Consistency lifts eligibility.`, health: 0.6 }];
  }
  return [{ insight_type: 'CREDIT_READINESS', severity: 'warning', metric: score, title: 'Credit score needs attention', body: `Your credit score is ${score}. Improve repayment and contribution reliability.`, health: 0.35 }];
}

async function genLoanRelief(user) {
  const missed = await pool.query(
    'SELECT COALESCE(SUM(contributions_missed),0)::int AS m FROM rosca_members WHERE user_id = $1',
    [user.id]
  );
  const m = Number(missed.rows[0].m || 0);
  if (m >= 3) {
    return [{
      insight_type: 'LOAN_RELIEF', severity: 'warning', metric: m,
      title: 'Missed contributions detected',
      body: `You have missed ${m} ROSCA contributions. Consider lower contribution or grace period to protect your trust score.`,
      health: 0.45,
    }];
  }
  return [];
}

// ---------------------------------------------------------------------------

function severityWeight(sev) {
  return { good: 1, info: 0.75, warning: 0.5, alert: 0.25 }[sev] ?? 0.6;
}

async function refreshInsights(userId) {
  const user = { ...(await currentBalanceAndTrust(userId)), id: userId };
  const rows = await txTotals(userId, 30);
  const inflow = rows.filter((t) => IN_TYPES.includes(t.type)).reduce((s, t) => s + Number(t.amount), 0);
  const save = await savingsPosition(userId);
  const bh = await budgetHealth(userId);
  const score = await creditScore(userId);

  const generated = [];
  const push = (arr) => { generated.push(...arr); };

  push(await genSpendConcentration(rows));
  push(await genCashflow(rows, user));
  push(await genSavingsRate(inflow, save));
  push(await genBudget(bh));
  push(await genAnomaly(rows));
  push(await genCredit(score));
  push(await genLoanRelief(user));

  if (generated.length === 0) {
    generated.push({
      insight_type: 'DIGEST', severity: 'good', metric: null,
      title: 'No issues detected', body: 'Your recent finances look steady. Keep contributing on time.',
      health: 1,
    });
  }

  const healthRaw = generated.reduce((s, g) => s + (g.health ?? 0.6), 0) / generated.length;
  const healthScore = Math.round(healthRaw * 100);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ai_insights WHERE user_id = $1 AND NOT dismissed', [userId]);
    for (const g of generated) {
      await client.query(
        `INSERT INTO ai_insights (user_id, insight_type, severity, title, body, metric, model_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [userId, g.insight_type, g.severity, g.title, g.body, g.metric ?? null, MODEL]
      );
    }
    await client.query(
      `INSERT INTO ai_model_register (model_key, model_version, generated_by, scope_user_id, insight_count)
       VALUES ($1,$2,$3,$4,$5)`,
      [MODEL_KEY, MODEL, userId, userId, generated.length]
    );
    await client.query('COMMIT');

    const ins = await client.query(
      'SELECT * FROM ai_insights WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40',
      [userId]
    );
    return { insights: ins.rows, healthScore, modelVersion: MODEL, generatedAt: new Date().toISOString() };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getInsights(userId) {
  const ins = await pool.query(
    'SELECT * FROM ai_insights WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40',
    [userId]
  );
  const healthScore = Math.round(ins.rows.reduce((s, r) => s + severityWeight(r.severity), 0) / Math.max(ins.rows.length, 1) * 100);
  return { insights: ins.rows, healthScore };
}

async function dismissInsight(userId, id) {
  const r = await pool.query(
    `UPDATE ai_insights SET dismissed = TRUE WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  if (r.rows.length === 0) throw Object.assign(new Error('Insight haipatikani.'), { statusCode: 404 });
  return r.rows[0];
}

async function cashflowForecast(userId, months = 3) {
  const rows = await txTotals(userId, 30);
  const inflow = rows.filter((t) => IN_TYPES.includes(t.type)).reduce((s, t) => s + Number(t.amount), 0);
  const outflow = rows.filter((t) => OUT_TYPES.includes(t.type)).reduce((s, t) => s + Number(t.total_charged || t.amount), 0);
  const netMonthly = round2(inflow - outflow);
  const balance = Number((await currentBalanceAndTrust(userId)).wallet_balance) || 0;
  const forecast = [];
  let bal = balance;
  for (let i = 1; i <= months; i++) {
    bal = round2(bal + netMonthly);
    forecast.push({ month: i, projected_balance: bal, net_flow: netMonthly });
  }
  return { balance, netMonthly, forecast };
}

module.exports = { refreshInsights, getInsights, dismissInsight, cashflowForecast };
