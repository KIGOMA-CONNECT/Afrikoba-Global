/**
 * Savings & Credit
 * I1: Savings goals (extended) | I2: Auto-save rules | I3: Fixed deposits
 * I4-I5: Micro loans + installments | I6-I8: Credit score, limit, payoff
 * I9: Guarantors | I10: Credit report
 */

const pool = require('../config/db');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const fin = require('./financialEngine');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function badge(err, statusCode) {
  return Object.assign(new Error(err), { statusCode });
}

async function findUserByPhone(phone) {
  const r = await pool.query('SELECT id, full_name, phone_number, wallet_balance FROM users WHERE phone_number = $1', [String(phone).trim()]);
  return r.rows[0];
}

async function logTx(client, userId, amount, type, meta) {
  await client.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', $4, $5)`,
    [generateReference(), userId, amount, type, JSON.stringify(meta || {})]
  );
}

function intervalFor(frequency) {
  if (frequency === 'DAILY') return `INTERVAL '1 day'`;
  if (frequency === 'MONTHLY') return `INTERVAL '1 month'`;
  return `INTERVAL '1 week'`;
}

// ====================================================================
// I1: SAVINGS GOALS
// ====================================================================

async function createSavingsGoal(userId, data) {
  const { name, target_amount, deadline, icon } = data;
  const target = Number(target_amount);
  if (!name) throw badge('Jina la lengo ni lazima.', 400);
  if (!target || target <= 0) throw badge('Kikomo (target) ni lazima kiwe chanya.', 400);
  const res = await pool.query(
    `INSERT INTO savings_goals (user_id, name, target_amount, deadline, icon)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, name, target, deadline || null, icon || 'target']
  );
  await logAudit(userId, 'SAVINGS_GOAL_CREATED', `Lengo ${name} limeundwa`).catch(() => {});
  return res.rows[0];
}

async function listGoals(userId) {
  const res = await pool.query(
    `SELECT *, ROUND((CASE WHEN target_amount > 0 THEN (current_amount / target_amount * 100) ELSE 0 END)::numeric, 1) AS progress_pct
     FROM savings_goals WHERE user_id = $1 ORDER BY status = 'ACTIVE' DESC, created_at DESC`,
    [userId]
  );
  return res.rows;
}

async function contributeGoal(userId, goalId, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw badge('Kiasi si sahihi.', 400);
  const goal = await pool.query("SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'", [goalId, userId]);
  if (!goal.rows.length) throw badge('Lengo haipatikani au imekamilika.', 404);
  const g = goal.rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.debitWallet({ client, userId, amount: amountNum, reference: generateReference('SCGOAL'), toAccount: 'SUSPENSE', description: 'Savings goal contribution' });
    const newAmount = round2(Number(g.current_amount) + amountNum);
    const completed = newAmount >= Number(g.target_amount);
    await client.query(
      `UPDATE savings_goals
       SET current_amount = $1, status = CASE WHEN $2 THEN 'COMPLETED' ELSE status END,
           is_completed = $2, completed_at = CASE WHEN $2 THEN NOW() ELSE completed_at END, updated_at = NOW()
       WHERE id = $3`,
      [newAmount, completed, goalId]
    );
    await logTx(client, userId, amountNum, 'SAVINGS_DEPOSIT', { feature: 'savings_goal', goal_id: goalId });
    await client.query('COMMIT');
    return { success: true, goal_id: goalId, current_amount: newAmount, completed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ====================================================================
// I2: AUTO-SAVE RULES
// ====================================================================

async function createAutoSaveRule(userId, goalId, data) {
  const { frequency, amount } = data;
  const amountNum = Number(amount);
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) throw badge('frequency isiyo sahihi.', 400);
  if (!amountNum || amountNum <= 0) throw badge('Kiasi si sahihi.', 400);
  const goal = await pool.query("SELECT id FROM savings_goals WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'", [goalId, userId]);
  if (!goal.rows.length) throw badge('Lengo haipatikani au imekamilika.', 404);
  const res = await pool.query(
    `INSERT INTO auto_save_rules (goal_id, user_id, frequency, amount, next_run_at)
     VALUES ($1,$2,$3,$4, NOW()) RETURNING *`,
    [goalId, userId, frequency, amountNum]
  );
  return res.rows[0];
}

async function runAutoSave(userId) {
  const rules = await pool.query(
    `SELECT r.*, g.name, g.target_amount, g.current_amount
     FROM auto_save_rules r JOIN savings_goals g ON g.id = r.goal_id
     WHERE r.user_id = $1 AND r.is_active = TRUE AND g.status = 'ACTIVE' AND r.next_run_at <= NOW()`,
    [userId]
  );
  if (!rules.rows.length) return { ran: 0, total: 0, skipped: 0, message: 'Hakuna auto-save iliyopo.' };
  const client = await pool.connect();
  let total = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    for (const rule of rules.rows) {
      const amountNum = Number(rule.amount);
      const u = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (Number(u.rows[0].wallet_balance) < amountNum) { skipped += 1; continue; }
      await fin.debitWallet({ client, userId, amount: amountNum, reference: generateReference('SCAUTO'), toAccount: 'SUSPENSE', description: 'Auto-save contribution' });
      const newAmount = round2(Number(rule.current_amount) + amountNum);
      const completed = newAmount >= Number(rule.target_amount);
      await client.query(
        `UPDATE savings_goals
         SET current_amount = $1, status = CASE WHEN $2 THEN 'COMPLETED' ELSE status END,
             is_completed = $2, completed_at = CASE WHEN $2 THEN NOW() ELSE completed_at END, updated_at = NOW()
         WHERE id = $3`,
        [newAmount, completed, rule.goal_id]
      );
      await client.query(
        `UPDATE auto_save_rules SET next_run_at = NOW() + ${intervalFor(rule.frequency)}, run_count = run_count + 1, updated_at = NOW() WHERE id = $1`,
        [rule.id]
      );
      await logTx(client, userId, amountNum, 'SAVINGS_DEPOSIT', { feature: 'auto_save', rule_id: rule.id, goal_id: rule.goal_id });
      total += amountNum;
    }
    await client.query('COMMIT');
    return { ran: rules.rows.length - skipped, total: round2(total), skipped, message: `Auto-save imetekelezwa (${formatMoney(total)}).` };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ====================================================================
// I3: FIXED DEPOSITS
// ====================================================================

async function createFixedDeposit(userId, data) {
  const { amount, term_months } = data;
  const amountNum = Number(amount);
  const term = parseInt(term_months, 10);
  if (!amountNum || amountNum <= 0) throw badge('Kiasi si sahihi.', 400);
  if (!term || term < 1 || term > 24) throw badge('Muda (miezi) ni kati ya 1 na 24.', 400);
  const annualRate = Number(data.annual_rate) > 0 ? Number(data.annual_rate) : 10.0;
  const maturity = new Date();
  maturity.setMonth(maturity.getMonth() + term);
  const maturityDate = maturity.toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.debitWallet({ client, userId, amount: amountNum, reference: generateReference('SCFD'), toAccount: 'SUSPENSE', description: 'Fixed deposit booking' });
    const res = await client.query(
      `INSERT INTO fixed_deposits (user_id, amount, term_months, annual_rate, maturity_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, amountNum, term, annualRate, maturityDate]
    );
    await logTx(client, userId, amountNum, 'FIXED_DEPOSIT', { feature: 'fixed_deposit', deposit_id: res.rows[0].id });
    await client.query('COMMIT');
    await logAudit(userId, 'FIXED_DEPOSIT_CREATED', `Mchango wa ${formatMoney(amountNum)} umezuiliwa kwa ${term} miezi`).catch(() => {});
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function listFixedDeposits(userId) {
  const res = await pool.query(
    'SELECT * FROM fixed_deposits WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return res.rows;
}

async function withdrawFixedDeposit(userId, depositId, data) {
  const allowEarly = !!(data && (data.allow_early === true || data.allow_early === 'true'));
  const dep = await pool.query("SELECT * FROM fixed_deposits WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'", [depositId, userId]);
  if (!dep.rows.length) throw badge('Mchango huu haupatikani au umechukuliwa.', 404);
  const d = dep.rows[0];
  const today = new Date();
  const matured = new Date(d.maturity_date) <= today;
  const client = await pool.connect();
  let deposit;
  let interest = 0;
  let penalty = 0;
  try {
    await client.query('BEGIN');
    const amountNum = Number(d.amount);
    if (matured) {
      interest = round2(amountNum * (Number(d.annual_rate) / 100) * (Number(d.term_months) / 12));
      penalty = 0;
      deposit = amountNum + interest;
      await client.query(
        `UPDATE fixed_deposits SET status = 'MATURED', interest_accrued = $1, matured_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [interest, depositId]
      );
    } else if (allowEarly) {
      penalty = round2(amountNum * 0.02);
      interest = 0;
      deposit = amountNum - penalty;
      await client.query(
        `UPDATE fixed_deposits SET status = 'WITHDRAWN_EARLY', penalty_amount = $1, updated_at = NOW() WHERE id = $2`,
        [penalty, depositId]
      );
    } else {
      throw badge('Mchango huu haujakomaa bado. Tumia allow_early=true kwa kuondoa mapema (penalty 2%).', 400);
    }
    await fin.creditWallet({ client, userId, amount: deposit, reference: `SCFD:${depositId}:WITH`, fromAccount: 'SUSPENSE', description: 'Fixed deposit withdrawal' });
    await logTx(client, userId, amountNum, 'FIXED_DEPOSIT', { feature: 'fixed_deposit_withdraw', deposit_id: depositId, matured, penalty });
    if (interest > 0) await logTx(client, userId, interest, 'FIXED_DEPOSIT_INTEREST', { feature: 'fixed_deposit_interest', deposit_id: depositId });
    if (penalty > 0) await logTx(client, userId, penalty, 'FIXED_DEPOSIT_PENALTY', { feature: 'fixed_deposit_penalty', deposit_id: depositId });
    await client.query('COMMIT');
    return { success: true, deposit_id: depositId, payout: round2(deposit), principal: amountNum, interest: round2(interest), penalty: round2(penalty), status: matured ? 'MATURED' : 'WITHDRAWN_EARLY' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function savingsSummary(userId) {
  const goals = await pool.query(
    `SELECT COUNT(*)::int AS total_goals,
            COALESCE(SUM(current_amount),0)::numeric AS goal_balance,
            COALESCE(SUM(target_amount),0)::numeric AS total_target,
            COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed
     FROM savings_goals WHERE user_id = $1`,
    [userId]
  );
  const deposits = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN amount ELSE 0 END),0)::numeric AS active_principal,
            COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN amount * (annual_rate/100) * (term_months/12.0) ELSE 0 END),0)::numeric AS projected_interest,
            COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_count
     FROM fixed_deposits WHERE user_id = $1`,
    [userId]
  );
  const g = goals.rows[0];
  const d = deposits.rows[0];
  return {
    totalGoals: Number(g.total_goals),
    completedGoals: Number(g.completed),
    goalBalance: Number(g.goal_balance),
    totalTarget: Number(g.total_target),
    activeDeposits: Number(d.active_count),
    activeDepositsPrincipal: Number(d.active_principal),
    projectedInterest: round2(Number(d.projected_interest)),
    totalSavedOverall: round2(Number(g.goal_balance) + Number(d.active_principal)),
  };
}

// ====================================================================
// I6-I8: CREDIT SCORE, LIMIT, MICRO LOANS
// ====================================================================

function getRating(score) {
  if (score >= 700) return { label: 'Excellent', labelSw: 'Bora', color: '#4CAF50' };
  if (score >= 600) return { label: 'Good', labelSw: 'Nzuri', color: '#8BC34A' };
  if (score >= 500) return { label: 'Fair', labelSw: 'Wastani', color: '#FFC107' };
  if (score >= 400) return { label: 'Below Average', labelSw: 'Chini ya Wastani', color: '#FF9800' };
  return { label: 'Poor', labelSw: 'Mbaya', color: '#F44336' };
}

async function recomputeScore(userId) {
  const u = await pool.query('SELECT kyc_level, wallet_balance FROM users WHERE id = $1', [userId]);
  if (!u.rows.length) throw badge('Mtumiaji hajapatikana.', 404);
  const kyc = Number(u.rows[0].kyc_level) || 0;
  const balance = Number(u.rows[0].wallet_balance) || 0;

  const tx = await pool.query(
    `SELECT COUNT(*)::int AS cnt,
            COUNT(DISTINCT DATE_TRUNC('week', created_at))::int AS weeks
     FROM transactions WHERE user_id = $1 AND status = 'SUCCESS' AND created_at > NOW() - INTERVAL '90 days'`,
    [userId]
  );
  const loans = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'REPAID')::int AS repaid
     FROM micro_loans WHERE user_id = $1`,
    [userId]
  );

  const factors = [];
  const ageScore = 100;
  factors.push({ factor: 'ACCOUNT_STABILITY', score: ageScore });
  const kycScore = Math.min(150, kyc * 50);
  factors.push({ factor: 'KYC_LEVEL', score: kycScore });
  const volumeScore = Math.min(200, Number(tx.rows[0].cnt) * 5);
  factors.push({ factor: 'TRANSACTION_VOLUME', score: volumeScore, detail: `${tx.rows[0].cnt} transactions` });
  const regularityScore = Math.min(150, Number(tx.rows[0].weeks) * 15);
  factors.push({ factor: 'TRANSACTION_REGULARITY', score: regularityScore, detail: `${tx.rows[0].weeks} active weeks` });
  const balanceScore = Math.min(100, Math.floor(balance / 10000));
  factors.push({ factor: 'BALANCE_MAINTENANCE', score: balanceScore });
  let loanScore = 100;
  if (Number(loans.rows[0].total) > 0) loanScore = Math.floor((Number(loans.rows[0].repaid) / Number(loans.rows[0].total)) * 200);
  factors.push({ factor: 'LOAN_REPAYMENT', score: loanScore, detail: `${loans.rows[0].repaid}/${loans.rows[0].total} repaid` });

  let score = Math.max(0, Math.min(800, Math.round(ageScore + kycScore + volumeScore + regularityScore + balanceScore + loanScore)));
  const creditLimit = Math.round((50000 + score * 250) / 1000) * 1000;

  await pool.query(
    `INSERT INTO credit_scores (user_id, score, credit_limit, factors, last_calculated)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (user_id) DO UPDATE SET score = $2, credit_limit = $3, factors = $4, last_calculated = NOW(), updated_at = NOW()`,
    [userId, score, creditLimit, JSON.stringify(factors)]
  );

  return { userId, score, rating: getRating(score), credit_limit: creditLimit, factors, calculatedAt: new Date().toISOString() };
}

async function getScore(userId) {
  const cached = await pool.query(
    `SELECT * FROM credit_scores WHERE user_id = $1 AND last_calculated > NOW() - INTERVAL '7 days'`,
    [userId]
  );
  if (cached.rows.length) {
    const row = cached.rows[0];
    return { userId, score: Number(row.score), rating: getRating(Number(row.score)), credit_limit: Number(row.credit_limit), factors: row.factors, calculatedAt: row.last_calculated };
  }
  return recomputeScore(userId);
}

async function applyMicroLoan(userId, data) {
  const { amount, term_months, interest_rate } = data;
  const amountNum = Number(amount);
  const term = parseInt(term_months, 10);
  if (!amountNum || amountNum <= 0) throw badge('Kiasi si sahihi.', 400);
  if (!term || term < 1 || term > 24) throw badge('Muda (miezi) ni kati ya 1 na 24.', 400);
  const rate = Number(interest_rate) > 0 ? Number(interest_rate) : 5;
  const scoreData = await getScore(userId);
  if (amountNum > Number(scoreData.credit_limit)) throw badge(`Kiasi cha mkopo kinazidi kikomo chako (${formatMoney(scoreData.credit_limit)}).`, 400);

  // Trust-score driven combined exposure limit (micro-loans + vicooba)
  const { enforceCreditLimit } = require('./creditLimitService');
  const limitCheck = await enforceCreditLimit(userId, amountNum);
  if (!limitCheck.approved) {
    throw badge(`Mkopo umezuiwa: ${limitCheck.reasons.join(' ')}`, 402);
  }

  const res = await pool.query(
    `INSERT INTO micro_loans (user_id, amount, interest_rate, term_months, credit_score_at_apply, guarantor_required)
     VALUES ($1,$2,$3,$4,$5, TRUE) RETURNING *`,
    [userId, amountNum, rate, term, scoreData.score]
  );
  await logAudit(userId, 'MICRO_LOAN_APPLIED', `Mkopo wa ${formatMoney(amountNum)} umeombwa`).catch(() => {});
  return { ...res.rows[0], creditLimit: limitCheck.creditLimit };
}

async function listMicroLoans(userId, isAdmin) {
  const q = isAdmin
    ? `SELECT ml.*, u.full_name, u.phone_number FROM micro_loans ml JOIN users u ON u.id = ml.user_id ORDER BY ml.created_at DESC`
    : `SELECT * FROM micro_loans WHERE user_id = $1 ORDER BY created_at DESC`;
  const res = isAdmin ? await pool.query(q) : await pool.query(q, [userId]);
  return res.rows;
}

async function adminApproveMicroLoan(loanId, adminId, note) {
  const loan = await pool.query("SELECT * FROM micro_loans WHERE id = $1 AND status = 'PENDING' FOR UPDATE", [loanId]);
  if (!loan.rows.length) throw badge('Mkopo haupatikani au uko kwenye status isiyo sahihi.', 404);
  const res = await pool.query(
    `UPDATE micro_loans SET status = 'APPROVED', admin_note = $1, approved_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
    [note || null, loanId]
  );
  await logAudit(adminId, 'MICRO_LOAN_APPROVED', `Mkopo #${loanId} umeidhinishwa`).catch(() => {});
  return res.rows[0];
}

async function addGuarantor(userId, loanId, phone) {
  const loan = await pool.query("SELECT * FROM micro_loans WHERE id = $1 AND user_id = $2 AND status = 'PENDING'", [loanId, userId]);
  if (!loan.rows.length) throw badge('Mkopo haupatikani au hauko kwenye status PENDING.', 404);
  const guarantor = await findUserByPhone(phone);
  if (!guarantor) throw badge('Mdhamini hajapatikana kwenye mfumo.', 404);
  if (guarantor.id === userId) throw badge('Huwezi kuwa mdhamini wa mkopo wako mwenyewe.', 400);
  const l = loan.rows[0];
  const blocked = round2(Number(l.amount) * 0.2);
  const res = await pool.query(
    `INSERT INTO loan_guarantors (loan_id, guarantor_id, blocked_amount)
     VALUES ($1,$2,$3) ON CONFLICT (loan_id, guarantor_id) DO NOTHING RETURNING *`,
    [loanId, guarantor.id, blocked]
  );
  if (!res.rows.length) throw badge('Mwaliko wa mdhamini tayari upo.', 409);
  return res.rows[0];
}

async function respondGuarantor(userId, loanId, accept) {
  const inv = await pool.query(
    `SELECT * FROM loan_guarantors WHERE loan_id = $1 AND guarantor_id = $2 AND status = 'PENDING'`,
    [loanId, userId]
  );
  if (!inv.rows.length) throw badge('Mwaliko haupatikani au tayari umejibiwa.', 404);
  if (accept) {
    const blocked = Number(inv.rows[0].blocked_amount);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const u = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (Number(u.rows[0].wallet_balance) < blocked) throw badge('Salio la mdhamini halitoshi kwa dhamana hii.', 400);
      await fin.lockWallet({ client, userId, amount: blocked, reference: `SCGUAR:${loanId}:${userId}:LOCK`, description: 'Loan guarantee hold' });
      await client.query(`UPDATE loan_guarantors SET status = 'ACCEPTED', decided_at = NOW() WHERE id = $1`, [inv.rows[0].id]);
      await logTx(client, userId, blocked, 'LOAN_GUARANTEE', { feature: 'loan_guarantee', loan_id: loanId });
      await client.query('COMMIT');
      return { success: true, blocked_amount: blocked, message: 'Dhamana imekubaliwa.' };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }
  await pool.query(`UPDATE loan_guarantors SET status = 'DECLINED', decided_at = NOW() WHERE id = $1`, [inv.rows[0].id]);
  return { success: true, blocked_amount: 0, message: 'Dhamana imekataliwa.' };
}

async function releaseGuarantees(client, loanId) {
  const active = await pool.query(
    `SELECT * FROM loan_guarantors WHERE loan_id = $1 AND status = 'ACCEPTED'`,
    [loanId]
  );
  for (const g of active.rows) {
    const blocked = Number(g.blocked_amount);
    await fin.unlockWallet({ client, userId: g.guarantor_id, amount: blocked, reference: `SCGUAR:${loanId}:${g.guarantor_id}:REL`, description: 'Loan guarantee release' });
    await client.query(`UPDATE loan_guarantors SET status = 'RELEASED', released_at = NOW() WHERE id = $1`, [g.id]);
    await logTx(client, g.guarantor_id, blocked, 'LOAN_GUARANTEE_RELEASE', { feature: 'loan_guarantee_release', loan_id: loanId, guarantor_id: g.guarantor_id });
  }
}

async function adminDisburseMicroLoan(loanId, adminId) {
  const loan = await pool.query("SELECT * FROM micro_loans WHERE id = $1 AND status = 'APPROVED' FOR UPDATE", [loanId]);
  if (!loan.rows.length) throw badge('Mkopo haupatikani au haujaiddhinishwa.', 404);
  const l = loan.rows[0];
  const rate = Number(l.interest_rate);
  const due = round2(Number(l.amount) * (1 + rate / 100));
  const term = Number(l.term_months);
  const installment = round2(due / term);
  if (term > 1) {
    const acc = await pool.query(`SELECT COUNT(*)::int AS n FROM loan_guarantors WHERE loan_id = $1 AND status = 'ACCEPTED'`, [loanId]);
    if (Number(acc.rows[0].n) === 0) throw badge('Lazima kuwe na mdhamini aliyekubali kabla ya kutoa mkopo.', 400);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({ client, userId: l.user_id, amount: l.amount, reference: `SCLOAN:${loanId}:DISBURSE`, fromAccount: 'SUSPENSE', description: 'Micro loan disbursement' });
    await client.query(
      `UPDATE micro_loans SET status = 'ACTIVE', due_amount = $1, monthly_installment = $2, disbursed_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [due, installment, loanId]
    );
    for (let i = 1; i <= term; i++) {
      const dd = new Date();
      dd.setMonth(dd.getMonth() + i);
      await client.query(
        `INSERT INTO loan_installments (loan_id, sequence, due_date, amount) VALUES ($1,$2,$3,$4)`,
        [loanId, i, dd.toISOString().slice(0, 10), installment]
      );
    }
    await logTx(client, l.user_id, Number(l.amount), 'LOAN_CREDIT', { feature: 'micro_loan', loan_id: loanId });
    await releaseGuarantees(client, loanId);
    await client.query('COMMIT');
    await logAudit(adminId, 'MICRO_LOAN_DISBURSED', `Mkopo #${loanId} umetolewa (${formatMoney(due)})`).catch(() => {});
    return { success: true, amount: Number(l.amount), due_amount: due, monthly_installment: installment, installments: term, message: 'Mkopo umetolewa kwenye wallet yako.' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function loanSchedule(userId, loanId) {
  const loan = await pool.query('SELECT id FROM micro_loans WHERE id = $1 AND user_id = $2', [loanId, userId]);
  if (!loan.rows.length) throw badge('Mkopo haupatikani.', 404);
  const res = await pool.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY sequence', [loanId]);
  return res.rows;
}

async function payInstallment(userId, loanId, installmentId) {
  const loan = await pool.query("SELECT * FROM micro_loans WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'", [loanId, userId]);
  if (!loan.rows.length) throw badge('Mkopo haupatikani au hauko ACTIVE.', 404);
  const inst = await pool.query("SELECT * FROM loan_installments WHERE id = $1 AND loan_id = $2 AND status = 'PENDING'", [installmentId, loanId]);
  if (!inst.rows.length) throw badge('Kipindi hiki hakipatikani au tayari kimalizika.', 404);
  const l = loan.rows[0];
  const amount = Number(inst.rows[0].amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.debitWallet({ client, userId, amount, reference: `SCLOAN:${loanId}:INST:${installmentId}:PAY`, toAccount: 'SUSPENSE', description: 'Micro loan installment repayment' });
    await client.query(`UPDATE loan_installments SET paid_amount = $1, status = 'PAID', paid_at = NOW() WHERE id = $2`, [amount, installmentId]);
    const paidAmount = round2(Number(l.paid_amount) + amount);
    const status = paidAmount >= Number(l.due_amount) ? 'REPAID' : 'ACTIVE';
    await client.query('UPDATE micro_loans SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3', [paidAmount, status, loanId]);
    await logTx(client, userId, amount, 'LOAN_REPAYMENT', { feature: 'micro_loan_installment', loan_id: loanId, installment_id: installmentId });
    await client.query('COMMIT');
    return { success: true, paid: amount, remaining: round2(Number(l.due_amount) - paidAmount), status };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function payoffLoan(userId, loanId) {
  const loan = await pool.query("SELECT * FROM micro_loans WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'", [loanId, userId]);
  if (!loan.rows.length) throw badge('Mkopo haupatikani au hauko ACTIVE.', 404);
  const l = loan.rows[0];
  const remaining = round2(Number(l.due_amount) - Number(l.paid_amount));
  if (remaining <= 0) throw badge('Mkopo tayari umemalizika.', 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.debitWallet({ client, userId, amount: remaining, reference: `SCLOAN:${loanId}:PAYOFF`, toAccount: 'SUSPENSE', description: 'Micro loan payoff' });
    const waived = await client.query(
      `UPDATE loan_installments SET status = 'WAIVED', paid_at = NOW()
       WHERE loan_id = $1 AND status = 'PENDING' RETURNING id`,
      [loanId]
    );
    await client.query(
      `UPDATE micro_loans SET paid_amount = due_amount, status = 'REPAID', updated_at = NOW() WHERE id = $1`,
      [loanId]
    );
    await logTx(client, userId, remaining, 'LOAN_REPAYMENT', { feature: 'micro_loan_payoff', loan_id: loanId });
    await client.query('COMMIT');
    await logAudit(userId, 'MICRO_LOAN_PAID', `Mkopo #${loanId} umemalizika kabla ya muda`).catch(() => {});
    return { success: true, paid: remaining, status: 'REPAID', waived_count: waived.rows.length, message: 'Mkopo umepakiwa kabisa.' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function creditReport(userId) {
  const score = await getScore(userId);
  const loans = await pool.query(
    `SELECT ml.*,
            COALESCE((SELECT COUNT(*) FROM loan_installments li WHERE li.loan_id = ml.id AND li.status = 'PAID'),0)::int AS paid_installments,
            COALESCE((SELECT COUNT(*) FROM loan_installments li WHERE li.loan_id = ml.id AND li.status = 'WAIVED'),0)::int AS waived_installments
     FROM micro_loans ml WHERE ml.user_id = $1 ORDER BY ml.created_at DESC`,
    [userId]
  );
  const overdue = await pool.query(
    `SELECT COALESCE(COUNT(*),0)::int AS n FROM loan_installments li
     JOIN micro_loans ml ON ml.id = li.loan_id
     WHERE ml.user_id = $1 AND li.status = 'PENDING' AND li.due_date < CURRENT_DATE`,
    [userId]
  );
  const activeLoans = loans.rows.filter((x) => x.status === 'ACTIVE').length;
  return {
    score: score.score,
    rating: score.rating,
    creditLimit: score.credit_limit,
    activeLoans,
    overdueInstallments: Number(overdue.rows[0].n),
    totalLoanCount: loans.rows.length,
    loans: loans.rows.map((x) => ({ id: x.id, amount: Number(x.amount), status: x.status, paid_amount: Number(x.paid_amount), due_amount: Number(x.due_amount), paid_installments: x.paid_installments, waived_installments: x.waived_installments })),
    message: `Sifa ya mikopo yako imehesabiwa (${score.rating.labelSw}).`,
  };
}

module.exports = {
  createSavingsGoal,
  listGoals,
  contributeGoal,
  createAutoSaveRule,
  runAutoSave,
  createFixedDeposit,
  listFixedDeposits,
  withdrawFixedDeposit,
  savingsSummary,
  recomputeScore,
  getScore,
  applyMicroLoan,
  listMicroLoans,
  adminApproveMicroLoan,
  adminDisburseMicroLoan,
  addGuarantor,
  respondGuarantor,
  loanSchedule,
  payInstallment,
  payoffLoan,
  creditReport,
};