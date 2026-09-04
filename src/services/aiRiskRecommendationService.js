/**
 * AI Risk Engine, Recommendation Engine & Confidence/Explainability
 *
 * Computes a per-user financial risk assessment (0-100) from behavioural features,
 * generates prioritized actionable recommendations, and logs every AI decision to
 * an explainability + model-governance ledger so each output has a confidence score
 * and human-understandable rationale.
 *
 * Models registered in the afri-ai governance register:
 *   afri-risk-1.0  (risk engine)
 *   afri-reco-1.0  (recommendation engine)
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const RISK_MODEL = 'afri-risk-1.0';
const RECO_MODEL = 'afri-reco-1.0';

async function txTotals(userId, days) {
  const res = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN amount >= 0 THEN amount END),0)::numeric AS inflow,
            COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END),0)::numeric AS outflow,
            COUNT(*)::int AS count
       FROM (
         (SELECT wallet_amount AS amount FROM transactions WHERE user_id=$1 AND created_at >= NOW() - ($2::int || ' days')::interval)
         UNION ALL
         (SELECT -wallet_amount FROM transactions WHERE user_id=$1 AND type='WITHDRAWAL' AND created_at >= NOW() - ($2::int || ' days')::interval)
       ) t`,
    [userId, days]
  );
  const r = res.rows[0] || { inflow: 0, outflow: 0, count: 0 };
  return { inflow: Number(r.inflow), outflow: Number(r.outflow), count: r.count };
}

async function getOverdueCount(userId) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS c FROM global_loans WHERE user_id=$1 AND status='OVERDUE'`,
    [userId]
  ).catch(() => pool.query(`SELECT COUNT(*)::int AS c FROM credit_accounts WHERE user_id=$1 AND status='OVERDUE'`, [userId]).catch(() => ({ rows: [{ c: 0 }] })));
  return res.rows[0]?.c || 0;
}

/** Build behavioural input features for a user. */
async function buildFeatures(userId) {
  const user = (await pool.query(
    'SELECT wallet_balance, trust_score FROM users WHERE id=$1',
    [userId]
  )).rows[0] || { wallet_balance: 0, trust_score: 100 };
  const t = await txTotals(userId, 30);
  const overdue = await getOverdueCount(userId);

  // credit score (best-effort)
  let credit = 650;
  try {
    const creditService = require('./creditScoreService');
    const cs = await creditService.getCreditScore(userId);
    credit = typeof cs === 'number' ? cs : (cs?.score ?? 650);
  } catch (e) { credit = 650; }

  const balance = Number(user.wallet_balance) || 0;
  const trust = Number(user.trust_score) || 100;

  const burnRate = t.inflow > 0 ? t.outflow / t.inflow : Infinity; // outflow/inflow ratio
  const lowRunway = t.inflow > 0 && balance < (t.outflow * 30) / 30 * 0.5;

  return {
    balance, trust, credit, overdue,
    inflow: t.inflow, outflow: t.outflow, txCount: t.count,
    burnRate: Number.isFinite(burnRate) ? burnRate : 3,
    lowRunway,
  };
}

/**
 * Risk engine: derive a 0-100 risk score with weighted, explainable factors.
 * Higher = higher risk to the institution/group.
 */
function scoreRisk(f) {
  const factors = [];
  let risk = 0;

  const push = (name, weight, value, label) => {
    risk += weight;
    factors.push({ name, weight, value, label });
  };

  if (f.burnRate > 1.5) push('BURN_RATE', 30, f.burnRate, 'Outflows exceed inflows');
  if (f.burnRate > 1.0) push('BURN_RATE_MODERATE', 15, f.burnRate, 'Elevated spending ratio');

  if (f.trust < 70) push('LOW_TRUST', 20, f.trust, 'Low trust score');
  else if (f.trust < 85) push('TRUST_WATCH', 8, f.trust, 'Declining trust signal');

  if (f.credit < 550) push('LOW_CREDIT', 20, f.credit, 'Low credit score');
  else if (f.credit < 650) push('CREDIT_WATCH', 10, f.credit, 'Credit below ideal');

  if (f.overdue > 0) push('OVERDUE_LOANS', 25, f.overdue, 'Overdue loans');

  if (f.lowRunway) push('LOW_RUNWAY', 15, f.balance, 'Low liquidity runway');

  if (f.balance < 0) push('NEGATIVE_BALANCE', 20, f.balance, 'Negative wallet balance');

  risk = Math.min(100, Math.round(risk));

  const level = risk >= 75 ? 'CRITICAL' : risk >= 60 ? 'HIGH' : risk >= 40 ? 'MEDIUM' : 'LOW';
  const confidence = Math.round(Math.min(96, 65 + f.txCount * 0.5).toFixed(0));

  // Explainability: highest-impact features
  const topFeatures = factors.slice().sort((a, b) => b.weight - a.weight).slice(0, 3);

  return { riskScore: risk, riskLevel: level, confidence, factors, topFeatures };
}

/** Recommendation engine: derive prioritized actionable recommendations. */
function deriveRecommendations(f, risk) {
  const recos = [];
  const push = (category, priority, title, body, impact) => { recos.push({ category, priority, title, body, impact }); };

  if (f.burnRate > 1.5) push('RISK', 'CRITICAL', 'Reduce spending rate',
    `Your outflows are ${f.burnRate.toFixed(1)}x your inflows over the last 30 days.`, { savingsPercent: 15 });
  if (f.burnRate > 1.0) push('BUDGET', 'HIGH', 'Set a monthly spending cap',
    'A spending cap can stabilize your cash flow and protect your trust score.', { savingsPercent: 10 });
  if (f.overdue > 0) push('CREDIT', 'CRITICAL', 'Clear overdue loans',
    `You have ${f.overdue} overdue loan(s). Settling them lifts your credit score.`, { scoreGain: 60 });
  if (f.trust < 85) push('RISK', 'MEDIUM', 'Protect your trust score',
    'Regular contributions and on-time payments will rebuild trust.', { trustGain: 10 });
  if (f.credit < 650 && f.credit > 0) push('CREDIT', 'MEDIUM', 'Build credit history',
    'Small regular savings-backed contributions improve creditworthiness.', { scoreGain: 30 });
  if (f.lowRunway || f.balance < 0) push('SAVINGS', 'HIGH', 'Build a liquidity buffer',
    'A small emergency cushion prevents overdraw and high burn. Start with a weekly micro-savings top-up.', { bufferWeeks: 4 });
  if (f.inflow > f.outflow && f.txCount > 0) push('INVESTMENT', 'LOW', 'Consider yield savings',
    'You have monthly surplus; directing some into a yield pool grows idle funds.', { annualYield: '4-8%' });

  return recos.sort((a, b) => ({ CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 }[b.priority]) - ({ CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 }[a.priority])).slice(0, 6);
}

async function evaluateRisk(userId) {
  const features = await buildFeatures(userId);
  const risk = scoreRisk(features);

  const assessRes = await pool.query(
    `INSERT INTO ai_risk_assessments (user_id, risk_score, risk_level, confidence, factors, recommendations, model_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, risk.riskScore, risk.riskLevel, risk.confidence, JSON.stringify(risk.factors), JSON.stringify([]), RISK_MODEL]
  );
  const assessment = assessRes.rows[0];

  // Derive + persist recommendations
  const recommendations = deriveRecommendations(features, risk);
  const recoIds = [];
  for (const rc of recommendations) {
    const r = await pool.query(
      `INSERT INTO ai_recommendations (user_id, category, priority, title, body, impact_estimate, confidence, model_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [userId, rc.category, rc.priority, rc.title, rc.body, JSON.stringify(rc.impact), risk.confidence, RECO_MODEL]
    );
    recoIds.push(r.rows[0].id);
  }

  // Log explainability + model governance
  await pool.query(
    `INSERT INTO ai_decision_explanations (user_id, decision_type, decision_ref, model_version, inputs, top_features, explanation, confidence)
     VALUES ($1,'RISK',$2,$3,$4,$5,$6,$7)`,
    [userId, assessment.id, RISK_MODEL, JSON.stringify({ burnRate: features.burnRate, trust: features.trust, credit: features.credit, overdue: features.overdue, balance: features.balance }),
     JSON.stringify(risk.topFeatures), `Risk level ${risk.riskLevel} (${risk.riskScore}/100) driven primarily by ${risk.topFeatures.map((f) => f.name).join(', ') || 'no major factors'}.`, risk.confidence]
  );

  // Register model usage in the AI model governance register
  await pool.query(
    `INSERT INTO ai_model_register (model_key, model_version, generated_by, scope_user_id, insight_count)
     VALUES ($1,$2,'aiRiskRecommender', $3, $4)`,
    [RISK_MODEL, RISK_MODEL, userId, 1 + recommendations.length]
  ).catch(() => {});

  logger.info('AI_RISK', `User ${userId}: risk=${risk.riskLevel} (${risk.riskScore}, conf ${risk.confidence}), reco=${recommendations.length}`);
  return {
    success: true,
    assessment: { ...assessment, risk_score: assessment.risk_score, risk_level: assessment.risk_level, confidence: assessment.confidence },
    recommendations,
    topFeatures: risk.topFeatures,
    model: RISK_MODEL,
  };
}

async function getLatestRisk(userId) {
  const res = await pool.query(
    `SELECT * FROM ai_risk_assessments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function getActiveRecommendations(userId) {
  const res = await pool.query(
    `SELECT * FROM ai_recommendations WHERE user_id=$1 AND status='ACTIVE' ORDER BY created_at DESC`,
    [userId]
  );
  return res.rows;
}

async function dismissRecommendation(userId, id) {
  const res = await pool.query(
    `UPDATE ai_recommendations SET status='DISMISSED' WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, userId]
  );
  return res.rows[0];
}

async function getExplanations(userId, decisionType) {
  const params = [userId];
  let where = 'WHERE user_id=$1';
  if (decisionType) { params.push(decisionType); where += ` AND decision_type=$${params.length}`; }
  const res = await pool.query(`SELECT * FROM ai_decision_explanations ${where} ORDER BY created_at DESC`, params);
  return res.rows;
}

module.exports = { evaluateRisk, getLatestRisk, getActiveRecommendations, dismissRecommendation, getExplanations };
