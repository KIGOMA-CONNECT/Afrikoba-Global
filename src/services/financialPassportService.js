/**
 * FINANCIAL PASSPORT SERVICE
 * A governed, explainable financial identity built from AFRIKOBA activity.
 *
 * The passport is NOT a single opaque credit score. It produces named,
 * explainable dimensions (identity / behaviour / capacity), a composite
 * AFRIKOBA Score, monetary capacity/obligation figures, and a transaction
 * risk level. Every dimension carries a human-readable reason so that each
 * decision can be justified.
 *
 * It is READ-ONLY against the ledger and app projections (no balance mutation),
 * so it never interferes with the double-entry journal or the reconciliation
 * invariants. Each calculation is stored as a VERSIONED, append-only snapshot
 * (see migration 036) preserving the governance trail of how scores change.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

// ----------------------------------------------------------------------------
// Scoring weights (explainable, configurable in code for now)
// ----------------------------------------------------------------------------
const WEIGHTS = {
  identity: 0.30,
  behaviour: 0.45,
  capacity: 0.25,
};

// ----------------------------------------------------------------------------
// Dimension calculators
// ----------------------------------------------------------------------------

/** 1. Identity confidence (0-100). */
async function computeIdentity(userId) {
  const r = await pool.query(
    `SELECT kyc_level, phone_number, nida_number, created_at, is_active
       FROM users WHERE id = $1`, [userId]
  );
  const u = r.rows[0];
  if (!u) return { dimensions: [], identity: 0, kyc_level: 0, phone_verified: false, nida_present: false, account_age_days: 0 };

  const kyc_level = u.kyc_level || 0;
  const phone_verified = !!(u.phone_number && u.phone_number.trim());
  const nida_present = !!(u.nida_number && u.nida_number.trim());
  const account_age_days = u.created_at
    ? Math.max(0, Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86400000))
    : 0;

  const dims = [];
  let score = 0;

  const kycScore = Math.min(40, kyc_level * 13);
  dims.push({ dimension: 'KYC Level', band: `${kycScore}/40`, reason: `Verified identity level ${kyc_level}` });
  score += kycScore;

  if (phone_verified) { dims.push({ dimension: 'Phone Verified', band: '15/15', reason: 'Registered phone number present' }); score += 15; }
  else { dims.push({ dimension: 'Phone Verified', band: '0/15', reason: 'No registered phone number' }); }

  if (nida_present) { dims.push({ dimension: 'NIDA Verified', band: '30/30', reason: 'National ID on file' }); score += 30; }
  else { dims.push({ dimension: 'NIDA Verified', band: '0/30', reason: 'No NIDA on file' }); }

  const ageScore = Math.min(15, Math.floor(account_age_days / 30) * 1.5);
  dims.push({ dimension: 'Account Age', band: `${ageScore}/15`, reason: `${account_age_days} days since registration` });
  score += ageScore;

  return {
    dimensions: dims,
    identity: Math.min(100, Math.round(score)),
    kyc_level,
    phone_verified,
    nida_present,
    account_age_days,
  };
}

/** 2a. Savings consistency (0-100). */
async function computeSavings(userId) {
  const goal = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_completed)::int AS completed,
            COALESCE(SUM(current_amount),0)::numeric AS current,
            COALESCE(SUM(target_amount),0)::numeric AS target
       FROM savings_goals WHERE user_id = $1`, [userId]
  );
  const fd = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('MATURED','ACTIVE'))::int AS active
       FROM fixed_deposits WHERE user_id = $1`, [userId]
  );
  const ch = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE streak >= 2)::int AS streak_ok
       FROM savings_challenge_members WHERE user_id = $1`, [userId]
  );
  const auto = await pool.query(
    `SELECT COUNT(*)::int AS active, COALESCE(SUM(run_count),0)::int AS runs
       FROM auto_save_rules WHERE user_id = $1 AND is_active = TRUE`, [userId]
  );
  const wallet = await pool.query(
    `SELECT wallet_balance, locked_balance FROM users WHERE id = $1`, [userId]
  );
  const balance = parseFloat(wallet.rows[0]?.wallet_balance || 0);

  const dims = [];
  let score = 0;

  const g = goal.rows[0];
  if (g.total > 0) {
    const completion = Math.min(40, Math.round((g.completed / g.total) * 40));
    const progress = g.target > 0 ? Math.min(15, Math.round((g.current / g.target) * 15)) : 0;
    dims.push({ dimension: 'Savings Goals', band: `${completion + progress}/55`, reason: `${g.completed}/${g.total} goals completed` });
    score += completion + progress;
  } else {
    dims.push({ dimension: 'Savings Goals', band: '0/55', reason: 'No savings goals created' });
  }

  if (fd.rows[0].total > 0) {
    const fdScore = Math.min(15, fd.rows[0].active * 4);
    dims.push({ dimension: 'Fixed Deposits', band: `${fdScore}/15`, reason: `${fd.rows[0].active} active/matured deposits` });
    score += fdScore;
  } else {
    dims.push({ dimension: 'Fixed Deposits', band: '0/15', reason: 'No fixed deposits' });
  }

  if (ch.rows[0].total > 0) {
    const chScore = Math.min(15, ch.rows[0].streak_ok * 5);
    dims.push({ dimension: 'Savings Challenges', band: `${chScore}/15`, reason: `${ch.rows[0].streak_ok} challenge streaks` });
    score += chScore;
  } else {
    dims.push({ dimension: 'Savings Challenges', band: '0/15', reason: 'No savings challenges' });
  }

  if (auto.rows[0].active > 0) {
    const autoScore = Math.min(15, Math.min(15, auto.rows[0].active * 5 + Math.floor(auto.rows[0].runs / 3)));
    dims.push({ dimension: 'Auto-Save', band: `${autoScore}/15`, reason: `${auto.rows[0].active} active auto-save rules, ${auto.rows[0].runs} runs` });
    score += autoScore;
  } else {
    dims.push({ dimension: 'Auto-Save', band: '0/15', reason: 'No auto-save rules' });
  }

  const balanceScore = Math.min(10, Math.floor(balance / 10000));
  dims.push({ dimension: 'Balance Maintenance', band: `${balanceScore}/10`, reason: `Available balance ${balance.toLocaleString()}` });
  score += balanceScore;

  return { dimensions: dims, savings: Math.min(100, Math.round(score)) };
}

/** 2b. Repayment reliability (0-100). */
async function computeRepayment(userId) {
  // micro-loan repayments
  const ml = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('COMPLETED','REPAID','PAID'))::int AS repaid,
            COUNT(*) FILTER (WHERE status IN ('DEFAULTED','OVERDUE'))::int AS defaulted
       FROM micro_loans WHERE user_id = $1`, [userId]
  );
  // VICOBA loan schedule repayments (on-time-ish)
  const vs = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE s.status IN ('PAID','COMPLETED'))::int AS paid,
            COUNT(*) FILTER (WHERE s.status IN ('LATE','OVERDUE','DEFAULTED'))::int AS late
       FROM vicoba_loan_schedules s
       JOIN vicoba_loan_requests r ON r.id = s.loan_id
      WHERE r.applicant_user_id = $1`, [userId]
  );

  // VICOBA contributions reflect obligation-follow-through too
  const contrib = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_late = FALSE)::int AS on_time,
            COUNT(*) FILTER (WHERE is_late = TRUE)::int AS late
       FROM vicoba_member_contributions WHERE user_id = $1`, [userId]
  );

  const dims = [];
  let weightCollected = 0, onTimeWeight = 0;

  const m = ml.rows[0];
  if (m.total > 0) {
    weightCollected += m.total;
    onTimeWeight += m.repaid;
    dims.push({ dimension: 'Micro-Loans', band: `${m.repaid}/${m.total}`, reason: `${m.total} micro-loans, ${m.repaid} repaid${m.defaulted ? `, ${m.defaulted} defaulted` : ''}` });
  } else {
    dims.push({ dimension: 'Micro-Loans', band: 'n/a', reason: 'No micro-loan history (neutral)' });
  }

  const c = contrib.rows[0];
  if (c.total > 0) {
    weightCollected += c.total;
    onTimeWeight += c.on_time;
    dims.push({ dimension: 'VICOBA Contributions', band: `${c.on_time}/${c.total}`, reason: `${c.on_time} on-time of ${c.total} contributions${c.late ? `, ${c.late} late` : ''}` });
  } else {
    dims.push({ dimension: 'VICOBA Contributions', band: 'n/a', reason: 'No contribution history (neutral)' });
  }

  // VICOBA schedules (if present) contribute to on-time ratio
  const s2 = vs.rows[0];
  if (s2 && s2.total > 0) {
    weightCollected += s2.total;
    onTimeWeight += s2.paid;
    dims.push({ dimension: 'Schedule Repayments', band: `${s2.paid}/${s2.total}`, reason: `${s2.paid} paid of ${s2.total} schedule installments` });
  }

  let repayment;
  if (weightCollected === 0) {
    repayment = null; // no history -> neutral 50 (no penalty, no bonus)
    dims.push({ dimension: 'Repayment Reliability', band: '50/100', reason: 'No repayment history yet (neutral)' });
  } else {
    const ratio = onTimeWeight / weightCollected;
    repayment = Math.round(ratio * 100);
    dims.push({ dimension: 'Repayment Reliability', band: `${repayment}/100`, reason: `${onTimeWeight} on-time of ${weightCollected} obligations` });
  }

  return { dimensions: dims, repayment: repayment === null ? 50 : repayment };
}

/** 2c. Contribution & group participation (0-100). */
async function computeGroups(userId) {
  const g = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM vicoba_members WHERE user_id=$1)::int AS vicoba,
       (SELECT COUNT(*) FROM rosca_members WHERE user_id=$1)::int AS rosca,
       (SELECT COUNT(*) FROM savings_challenge_members WHERE user_id=$1)::int AS challenge,
       (SELECT COUNT(*) FROM family_wallet_members WHERE user_id=$1)::int AS family`,
    [userId]
  );
  const r = g.rows[0];
  const total = (r.vicoba || 0) + (r.rosca || 0) + (r.challenge || 0) + (r.family || 0);
  const dims = [];
  let score = 0;
  if (r.vicoba) { dims.push({ dimension: 'VICOBA Groups', band: `${r.vicoba}`, reason: `Member of ${r.vicoba} VICOBA group(s)` }); score += Math.min(40, r.vicoba * 20); }
  if (r.rosca) { dims.push({ dimension: 'ROSCA Pools', band: `${r.rosca}`, reason: `Member of ${r.rosca} ROSCA pool(s)` }); score += Math.min(25, r.rosca * 12); }
  if (r.challenge) { dims.push({ dimension: 'Savings Challenges', band: `${r.challenge}`, reason: `Joined ${r.challenge} savings challenge(s)` }); score += Math.min(20, r.challenge * 10); }
  if (r.family) { dims.push({ dimension: 'Family Wallets', band: `${r.family}`, reason: `Part of ${r.family} family wallet(s)` }); score += Math.min(15, r.family * 7); }
  if (total === 0) { dims.push({ dimension: 'Group Participation', band: '0', reason: 'Not yet part of any group' }); }
  // meeting attendance reliability
  const att = await pool.query(
    `SELECT COALESCE(SUM(meetings_attended),0)::int AS attended, COALESCE(SUM(meetings_attended + meetings_missed),0)::int AS total
       FROM vicoba_members WHERE user_id = $1`, [userId]
  );
  let attScore = 0;
  if (att.rows[0].total > 0) {
    attScore = Math.round((att.rows[0].attended / att.rows[0].total) * 25);
    dims.push({ dimension: 'Meeting Attendance', band: `${attScore}/25`, reason: `${att.rows[0].attended}/${att.rows[0].total} meetings attended` });
  } else {
    attScore = 0;
    dims.push({ dimension: 'Meeting Attendance', band: '0/25', reason: 'No meeting records' });
  }
  score += attScore;
  return { dimensions: dims, groups: Math.min(100, Math.round(score)) };
}

/** 2d. Transaction regularity (0-100). */
async function computeRegularity(userId) {
  const r = await pool.query(
    `SELECT COUNT(DISTINCT DATE_TRUNC('week', created_at))::int AS weeks6
       FROM transactions
      WHERE user_id=$1 AND status='SUCCESS' AND created_at > NOW() - INTERVAL '6 months'`, [userId]
  );
  const r3 = await pool.query(
    `SELECT COUNT(DISTINCT DATE_TRUNC('week', created_at))::int AS weeks3
       FROM transactions
      WHERE user_id=$1 AND status='SUCCESS' AND created_at > NOW() - INTERVAL '3 months'`, [userId]
  );
  const w6 = r.rows[0]?.weeks6 || 0;
  const w3 = r3.rows[0]?.weeks3 || 0;
  const score = Math.min(100, Math.round(w6 * 8 * 0.6 + w3 * 8 * 0.4)); // recency-weighted activity
  return {
    dimensions: [{ dimension: 'Transaction Regularity', band: `${score}/100`, reason: `${w3} active weeks (3mo), ${w6} (6mo)` }],
    regularity: score,
  };
}

/** 2e. Transaction risk level (LOW/MEDIUM/HIGH). */
async function computeRisk(userId) {
  const d = await pool.query(`SELECT COUNT(*)::int AS c FROM disputes WHERE user_id=$1`, [userId]);
  const f = await pool.query(`SELECT COUNT(*)::int AS c FROM fraud_alerts WHERE user_id=$1 AND is_resolved = FALSE`, [userId]);
  const rev = await pool.query(`SELECT COUNT(*)::int AS c FROM transactions WHERE user_id=$1 AND reversed_at IS NOT NULL`, [userId]);
  const riskPoints = (d.rows[0]?.c || 0) * 25 + (f.rows[0]?.c || 0) * 50 + (rev.rows[0]?.c || 0) * 20;
  let level = 'LOW';
  if (riskPoints >= 100) level = 'HIGH';
  else if (riskPoints >= 40) level = 'MEDIUM';
  return {
    dimensions: [{ dimension: 'Transaction Risk', band: level, reason: `${d.rows[0]?.c||0} disputes, ${f.rows[0]?.c||0} unresolved fraud alerts, ${rev.rows[0]?.c||0} reversals` }],
    risk: level,
    riskPoints,
  };
}

/** 3. Capacity (monetary, TZS). */
async function computeCapacity(userId) {
  const cf = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type='DEPOSIT' THEN total_charged END),0)::numeric AS income,
       COALESCE(SUM(CASE WHEN type<>'DEPOSIT' THEN total_charged END),0)::numeric AS expenses
     FROM transactions
     WHERE user_id=$1 AND status='SUCCESS' AND created_at > NOW() - INTERVAL '3 months'`, [userId]
  );
  const income = parseFloat(cf.rows[0]?.income || 0);
  const expenses = parseFloat(cf.rows[0]?.expenses || 0);
  const estMonthlyIncome = Math.round(income / 3);
  const estCashflow = Math.round((income - expenses) / 3);

  // committed obligations
  const microDebt = await pool.query(
    `SELECT COALESCE(SUM(due_amount - paid_amount),0)::numeric AS o FROM micro_loans
      WHERE user_id=$1 AND status IN ('ACTIVE','APPROVED','DISBURSED','PENDING')`, [userId]
  );
  const debts = await pool.query(
    `SELECT COALESCE(SUM(amount - amount_paid),0)::numeric AS o FROM debts
      WHERE user_id=$1 AND status IN ('PENDING','OUTSTANDING','ACTIVE')`, [userId]
  );
  const guar = await pool.query(
    `SELECT COALESCE(SUM(lg.blocked_amount),0)::numeric AS o FROM loan_guarantors lg
      WHERE lg.guarantor_id=$1 AND lg.status IN ('GUARANTEED','ACTIVE','BLOCKED')`, [userId]
  );
  const vicobaDebt = await pool.query(
    `SELECT COALESCE(SUM(r.total_repaid),0)::numeric AS repaid,
            COALESCE(SUM(r.approved_amount),0)::numeric AS approved
       FROM vicoba_loan_requests r JOIN vicoba_members m ON m.user_id = $1 AND m.group_id = r.group_id
      WHERE r.status IN ('ACTIVE','DISBURSED','APPROVED','ONGOING')
        AND r.applicant_user_id = $1`, [userId]
  );
  const vicobaObligation = Math.max(0, parseFloat(vicobaDebt.rows[0]?.approved || 0) - parseFloat(vicobaDebt.rows[0]?.repaid || 0));

  const committed = Math.round(
    (microDebt.rows[0]?.o || 0) + (debts.rows[0]?.o || 0) + (guar.rows[0]?.o || 0) + vicobaObligation
  );
  const disposable = Math.max(0, Math.round(estCashflow - committed));

  return {
    dimensions: [
      { dimension: 'Estimated Monthly Income', band: estMonthlyIncome.toLocaleString(), reason: `Average DEPOSITS over 3 months` },
      { dimension: 'Estimated Monthly Cashflow', band: estCashflow.toLocaleString(), reason: `(income - expenses) monthly average` },
      { dimension: 'Committed Obligations', band: committed.toLocaleString(), reason: `Active loans + debts + guarantees + VICOBA dues` },
      { dimension: 'Disposable Capacity', band: disposable.toLocaleString(), reason: `cashflow minus committed obligations` },
    ],
    estMonthlyIncome,
    estCashflow,
    committed,
    disposable,
  };
}

// ----------------------------------------------------------------------------
// Composite score
// ----------------------------------------------------------------------------
function ratingFor(score) {
  if (score >= 750) return { label: 'Excellent', label_sw: 'Bora', color: '#4CAF50' };
  if (score >= 650) return { label: 'Good', label_sw: 'Nzuri', color: '#8BC34A' };
  if (score >= 525) return { label: 'Fair', label_sw: 'Wastani', color: '#FFC107' };
  if (score >= 400) return { label: 'Below Average', label_sw: 'Chini ya Wastani', color: '#FF9800' };
  return { label: 'Poor', label_sw: 'Mbaya', color: '#F44336' };
}

function computeCompositeScore({ identity, savings, repayment, groups, regularity, risk, disposable }) {
  const behaviour =
    (savings * 0.30) +
    (repayment * 0.30) +
    (groups * 0.15) +
    (regularity * 0.25);
  const capacity = Math.min(100, disposable > 0 ? 60 + Math.min(40, Math.log10(disposable + 1) * 4) : (disposable >= 0 ? 30 : 0));
  let score = WEIGHTS.identity * identity + WEIGHTS.behaviour * behaviour + WEIGHTS.capacity * capacity;
  // risk guardrail
  if (risk === 'HIGH') score -= 80;
  else if (risk === 'MEDIUM') score -= 30;
  return Math.max(0, Math.min(850, Math.round(score)));
}

/** Compute the change-triggers against the previous passport snapshot, if any. */
async function computeTriggers(userId, current) {
  const prev = await pool.query(
    `SELECT afrikoba_score FROM financial_passports
      WHERE user_id=$1
      ORDER BY version DESC LIMIT 1`, [userId]
  );
  if (!prev.rows.length) return ['First passport issued'];
  const diff = current - prev.rows[0].afrikoba_score;
  if (Math.abs(diff) < 1) return ['No material change since last passport'];
  return [`Score moved ${diff > 0 ? 'up' : 'down'} ${Math.abs(diff)} points vs previous passport`];
}

/**
 * Calculate (& persist as the new current version of) a user's Financial Passport.
 * @returns {object} full explained passport
 */
async function calculatePassport(userId, calculatedBy = 'passport:manual') {
  const identity = await computeIdentity(userId);
  const savings = await computeSavings(userId);
  const repayment = await computeRepayment(userId);
  const groups = await computeGroups(userId);
  const regularity = await computeRegularity(userId);
  const risk = await computeRisk(userId);
  const capacity = await computeCapacity(userId);

  const composite = computeCompositeScore({
    identity: identity.identity,
    savings: savings.savings,
    repayment: repayment.repayment,
    groups: groups.groups,
    regularity: regularity.regularity,
    risk: risk.risk,
    disposable: capacity.disposable,
  });
  const rating = ratingFor(composite);

  const versionRow = await pool.query(
    `SELECT COALESCE(MAX(version),0)::int AS v FROM financial_passports WHERE user_id=$1`, [userId]
  );
  const version = versionRow.rows[0].v + 1;

  const triggers = await computeTriggers(userId, composite);

  const dimensions = [
    ...identity.dimensions,
    ...savings.dimensions,
    ...repayment.dimensions,
    ...groups.dimensions,
    ...regularity.dimensions,
    ...risk.dimensions,
    ...capacity.dimensions,
    { dimension: 'AFRIKOBA Score', band: `${composite}/850`, reason: `Identity ${Math.round(WEIGHTS.identity*100)}% / Behaviour ${Math.round(WEIGHTS.behaviour*100)}% / Capacity ${Math.round(WEIGHTS.capacity*100)}%` },
  ];

  await pool.query(
    `INSERT INTO financial_passports
       (user_id, version, afrikoba_score, rating_label, rating_label_sw, rating_color,
        identity_confidence, kyc_level, phone_verified, nida_present, account_age_days,
        savings_consistency, repayment_reliability, contribution_consistency, group_participation,
        tx_regularity, tx_risk_level,
        est_monthly_income, est_cashflow, committed_obligations, disposable_capacity,
        dimensions, triggers, calculated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [userId, version, composite, rating.label, rating.label_sw, rating.color,
     identity.identity, identity.kyc_level, identity.phone_verified, identity.nida_present, identity.account_age_days,
     savings.savings, repayment.repayment, groups.groups, groups.groups,
     regularity.regularity, risk.risk,
     capacity.estMonthlyIncome, capacity.estCashflow, capacity.committed, capacity.disposable,
     JSON.stringify(dimensions), JSON.stringify(triggers), calculatedBy]
  );

  logger.info('PASSPORT', `User ${userId} passport v${version} score ${composite}`);

  return {
    userId,
    version,
    afrikobaScore: composite,
    ...rating,
    dimensions,
    triggers,
    identity: { confidence: identity.identity, kycLevel: identity.kyc_level, phoneVerified: identity.phone_verified, nidaPresent: identity.nida_present, accountAgeDays: identity.account_age_days },
    behaviour: { savings: savings.savings, repayment: repayment.repayment, groups: groups.groups, regularity: regularity.regularity, risk: risk.risk },
    capacity: { monthlyIncome: capacity.estMonthlyIncome, cashflow: capacity.estCashflow, obligations: capacity.committed, disposable: capacity.disposable },
    calculatedAt: new Date().toISOString(),
  };
}

/**
 * Get the latest current passport snapshot (compute fresh if none exists).
 */
async function getPassport(userId) {
  const r = await pool.query(
    `SELECT * FROM financial_passports WHERE user_id=$1 AND is_current=TRUE`, [userId]
  );
  if (r.rows.length === 0) return calculatePassport(userId);
  const p = r.rows[0];
  return {
    userId: p.user_id,
    version: p.version,
    afrikobaScore: p.afrikoba_score,
    label: p.rating_label,
    label_sw: p.rating_label_sw,
    color: p.rating_color,
    dimensions: p.dimensions,
    triggers: p.triggers,
    identity: { confidence: p.identity_confidence, kycLevel: p.kyc_level, phoneVerified: p.phone_verified, nidaPresent: p.nida_present, accountAgeDays: p.account_age_days },
    behaviour: { savings: p.savings_consistency, repayment: p.repayment_reliability, groups: p.group_participation, regularity: p.tx_regularity, risk: p.tx_risk_level },
    capacity: { monthlyIncome: p.est_monthly_income, cashflow: p.est_cashflow, obligations: p.committed_obligations, disposable: p.disposable_capacity },
    calculatedAt: p.calculated_at,
  };
}

module.exports = { calculatePassport, getPassport, computeCompositeScore, ratingFor };
