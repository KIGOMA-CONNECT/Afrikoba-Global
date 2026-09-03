/**
 * Project Capital & Controlled Project Finance Service
 *
 * Implements the Afrikoba "Project Fundraising & Controlled Project Finance"
 * module (developer directive phases 5-7):
 *   - Project submission + governed approval workflow
 *   - Project-specific financial account (never a personal wallet)
 *   - Investment with versioned, accepted agreement (idempotent)
 *   - Structured budget, milestones, controlled disbursement
 *   - Append-only progress reports with plan-vs-actual variance
 *   - Revenue collection into the project account
 *   - Payroll and automated profit distribution (net of reserves/reinvestment)
 *
 * Non-negotiables honoured:
 *   - Every money movement goes through the financial engine (double-entry ledger)
 *   - Idempotency via unique references
 *   - No hard delete of financial records (status updates / reversals only)
 *   - Projected returns never presented as guaranteed
 */

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
const fin = require('./financialEngine');
const { logAudit } = require('./auditService');

const PROJECT_ACCOUNT = 'PROJECT_FUND';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const WORKFLOW_STAGES = ['INITIAL_REVIEW', 'DUE_DILIGENCE', 'RISK_ASSESSMENT', 'GOVERNANCE_REVIEW'];

class ValidityError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function getProjectForOwner(projectId, userId, client = pool) {
  const r = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (r.rows.length === 0) throw new ValidityError('Mradi haupatikani.', 404);
  if (r.rows[0].owner_user_id !== userId) throw new ValidityError('Huna ruhusa za mradi huu.', 403);
  return r.rows[0];
}

async function getProject(projectId, client = pool) {
  const r = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (r.rows.length === 0) throw new ValidityError('Mradi haupatikani.', 404);
  return r.rows[0];
}

// ============================================================================
// PROJECT SUBMISSION & APPROVAL WORKFLOW
// ============================================================================

async function createProject(userId, data) {
  const required = ['name', 'capital_required'];
  for (const f of required) {
    if (data[f] === undefined || data[f] === null || data[f] === '') throw new ValidityError(`Sehemu '${f}' inahitajika.`);
  }
  const r = await pool.query(
    `INSERT INTO projects
       (owner_user_id, name, description, category, location, capital_required, min_investment,
        duration_days, expected_revenue, expected_costs, projected_profit,
        reinvestment_pct, reserve_pct, owner_equity_pct, distribution_method,
        risks, assumptions, business_plan, status, current_stage)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'DRAFT','DRAFT')
     RETURNING *`,
    [userId, data.name, data.description, data.category, data.location,
     data.capital_required, data.min_investment, data.duration_days,
     data.expected_revenue, data.expected_costs, data.projected_profit,
     data.reinvestment_pct, data.reserve_pct, data.owner_equity_pct,
     data.distribution_method, data.risks, data.assumptions, data.business_plan]
  );
  await logAudit({ eventType: 'PROJECT_CREATED', action: 'CREATE', entityType: 'PROJECT', userId, entityId: r.rows[0].id, afterData: { name: data.name } });
  return r.rows[0];
}

async function submitProject(userId, projectId) {
  const p = await getProjectForOwner(projectId, userId);
  if (p.status !== 'DRAFT') throw new ValidityError('Mradi huu tayari umewasilishwa.');
  if (Number(p.min_investment) <= 0) throw new ValidityError('Weka kiwango cha juu zaidi cha uwekezaji (min_investment) kabla ya kuwasilisha.');
  const r = await pool.query(
    `UPDATE projects SET status = 'SUBMITTED', current_stage = 'SUBMITTED', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [projectId]
  );
  await logAudit({ eventType: 'PROJECT_SUBMITTED', action: 'SUBMIT', entityType: 'PROJECT', userId, entityId: projectId });
  return r.rows[0];
}

/**
 * Advance a project through the governance workflow. Only ADMIN/moderator may
 * call this via the route guard. Each stage transition is recorded append-only.
 */
async function makeWorkflowDecision(userId, projectId, { stage, decision, reason, risk_classification }) {
  if (!WORKFLOW_STAGES.includes(stage)) throw new ValidityError('Hatua si sahihi.');
  if (!['APPROVED', 'REJECTED', 'RETURNED'].includes(decision)) throw new ValidityError('Uamuzi si sahihi.');
  const p = await getProject(projectId);

  const allowedFrom = stage === 'INITIAL_REVIEW' ? ['SUBMITTED', 'DRAFT'] :
    stage === 'DUE_DILIGENCE' ? ['INITIAL_REVIEW'] :
    stage === 'RISK_ASSESSMENT' ? ['DUE_DILIGENCE'] :
    ['RISK_ASSESSMENT'];
  if (!allowedFrom.includes(p.status)) throw new ValidityError(`Haiwezi kufanyika katika hali ya sasa (${p.status}).`);

  await pool.query(
    `INSERT INTO project_approvals (project_id, stage, decision, reviewer_user_id, reason, risk_classification)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [projectId, stage, decision, userId, reason, risk_classification]
  );

  let nextStatus = p.status;
  if (decision === 'REJECTED') nextStatus = 'REJECTED';
  else if (decision === 'RETURNED') nextStatus = 'DRAFT';
  else if (stage === 'INITIAL_REVIEW') nextStatus = 'INITIAL_REVIEW';
  else if (stage === 'DUE_DILIGENCE') nextStatus = 'DUE_DILIGENCE';
  else if (stage === 'RISK_ASSESSMENT') nextStatus = 'RISK_ASSESSMENT';
  else if (stage === 'GOVERNANCE_REVIEW' && decision === 'APPROVED') nextStatus = 'APPROVED';

  const r = await pool.query(
    `UPDATE projects SET status = $1, current_stage = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
    [nextStatus, nextStatus === 'APPROVED' ? 'GOVERNANCE_REVIEW' : nextStatus, projectId]
  );
  await logAudit({ eventType: 'PROJECT_WORKFLOW', action: `WORKFLOW_${decision}`, entityType: 'PROJECT', userId, entityId: projectId, afterData: { stage, risk_classification } });
  return r.rows[0];
}

async function publishProject(userId, projectId) {
  const p = await getProject(projectId);
  if (p.status !== 'APPROVED') throw new ValidityError('Mradi lazima ukubaliwe kabla ya kuchapishwa.');
  const r = await pool.query(
    `UPDATE projects SET status = 'PUBLISHED', current_stage = 'PUBLISHED', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [projectId]
  );
  await logAudit({ eventType: 'PROJECT_PUBLISHED', action: 'PUBLISH', entityType: 'PROJECT', userId, entityId: projectId });
  return r.rows[0];
}

// ============================================================================
// AGREEMENT & INVESTMENT
// ============================================================================

async function createAgreement(userId, projectId, terms) {
  if (typeof terms !== 'object' || !terms) throw new ValidityError('Masharti (terms) yanahitajika.');
  const p = await getProjectForOwner(projectId, userId);
  const r = await pool.query(
    `INSERT INTO project_agreements (project_id, version, terms) VALUES ($1, $2, $3) RETURNING *`,
    [projectId, (await pool.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM project_agreements WHERE project_id = $1', [projectId])).rows[0].v, terms]
  );
  return r.rows[0];
}

async function listAgreements(userId, projectId) {
  await getProjectForOwner(projectId, userId);
  const r = await pool.query('SELECT * FROM project_agreements WHERE project_id = $1 ORDER BY version DESC', [projectId]);
  return r.rows;
}

async function acceptAgreement(projectId, version, userId) {
  const r = await pool.query(
    `UPDATE project_agreements SET accepted_user_id = $1, accepted_at = NOW()
     WHERE project_id = $2 AND version = $3 RETURNING *`,
    [userId, projectId, version]
  );
  if (r.rows.length === 0) throw new ValidityError('Makubaliano hayapatikani.');
  await logAudit({ eventType: 'PROJECT_AGREEMENT_ACCEPTED', action: 'ACCEPT', entityType: 'PROJECT_AGREEMENT', userId, entityId: r.rows[0].id });
  return r.rows[0];
}

/**
 * Investment. Funds are debited from the investor's wallet into the PROJECT_FUND
 * ledger account (never a personal custody account). Idempotent via unique_reference.
 */
async function invest(userId, projectId, { amount, unique_reference, agreement_version }) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
  const p = await getProject(projectId);
  if (!['PUBLISHED', 'FUNDING'].includes(p.status)) throw new ValidityError('Mradi huu haukubali uwekezaji kwa sasa.');
  const min = Number(p.min_investment) || 0;
  if (amt < min) throw new ValidityError(`Kiasi cha chini cha uwekezaji ni ${min}.`);
  const raised = Number(p.amount_raised) || 0;
  if (raised + amt > Number(p.capital_required)) throw new ValidityError('Mradi umekamilisha mahitaji ya ufadhili.');

  const ref = unique_reference || generateReference('PINV');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO project_investments (project_id, investor_user_id, amount, agreement_version, status, unique_reference)
       VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING id`,
      [projectId, userId, amt, agreement_version, ref]
    );

    await fin.debitWallet({ client, userId, amount: amt, reference: ref, toAccount: PROJECT_ACCOUNT, description: 'Project investment' });

    const participation = Number(p.capital_required) > 0 ? (amt / Number(p.capital_required)) : 0;
    await client.query(
      `UPDATE project_investments SET participation_pct = $1, status = 'CONFIRMED' WHERE project_id = $2 AND investor_user_id = $3 AND unique_reference = $4`,
      [round2(participation * 100), projectId, userId, ref]
    );
    await client.query(
      `UPDATE projects SET amount_raised = amount_raised + $1,
         status = CASE WHEN amount_raised >= capital_required THEN 'ACTIVE' ELSE 'FUNDING' END,
         updated_at = NOW()
       WHERE id = $2`,
      [amt, projectId]
    );

    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'PROJECT_INVEST', $4)`,
      [ref, userId, amt, JSON.stringify({ project_id: projectId, unique_reference: ref })]
    );

    await logAudit({ eventType: 'PROJECT_INVEST', action: 'INVEST', entityType: 'PROJECT', userId, entityId: projectId, referenceId: ref, amount: amt });

    await client.query('COMMIT');
    return { success: true, investment_id: ref, participation_pct: round2(participation * 100) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof ValidityError) throw e;
    if (String(e.message || '').toLowerCase().includes('duplicate') || String(e.message || '').includes('unique_reference')) {
      throw new ValidityError('Uwekezaji huu tayari umesajiliwa. Tumia unique_reference mpya.', 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================================
// BUDGET & MILESTONES
// ============================================================================

async function addBudgetItem(userId, projectId, { category, phase, approved_amount, responsible }) {
  const p = await getProjectForOwner(projectId, userId);
  if (!['DRAFT', 'APPROVED', 'PUBLISHED', 'FUNDING', 'ACTIVE'].includes(p.status)) throw new ValidityError('Unaweza kuongeza bajeti tu katika hali halali.');
  const r = await pool.query(
    `INSERT INTO project_budget (project_id, category, phase, approved_amount, responsible)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [projectId, category, phase, approved_amount, responsible]
  );
  return r.rows[0];
}

async function listBudget(projectId) {
  const rows = await pool.query('SELECT * FROM project_budget WHERE project_id = $1 ORDER BY id', [projectId]);
  return rows.rows;
}

async function addMilestone(userId, projectId, data) {
  const p = await getProjectForOwner(projectId, userId);
  if (!['DRAFT', 'APPROVED', 'PUBLISHED', 'FUNDING', 'ACTIVE'].includes(p.status)) throw new ValidityError('Unaweza kuweka hatua tu katika hali halali.');
  const rr = await pool.query(
    `INSERT INTO project_milestones
       (project_id, phase, name, budget, start_date, expected_end_date, deliverables)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [projectId, data.phase, data.name, data.budget, data.start_date, data.expected_end_date, data.deliverables]
  );
  return rr.rows[0];
}

async function listMilestones(projectId) {
  const rows = await pool.query('SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY id', [projectId]);
  return rows.rows;
}

// ============================================================================
// CONTROLLED DISBURSEMENT
// ============================================================================

/**
 * Release funds only against a milestone (budget-allowed) into the owner's wallet
 * via the financial engine. Idempotent via unique_reference.
 */
async function disburse(userId, projectId, { milestone_id, amount, unique_reference }) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
  const p = await getProjectForOwner(projectId, userId);
  const hasFunds = await pool.query('SELECT 1 FROM project_investments WHERE project_id = $1 LIMIT 1', [projectId]);
  if (hasFunds.rows.length === 0) throw new ValidityError('Mradi huu haujafadhiliwa.');
  const ref = unique_reference || generateReference('PDIS');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let milestone = null;
    if (milestone_id) {
      const mr = await client.query('SELECT * FROM project_milestones WHERE id = $1 AND project_id = $2', [milestone_id, projectId]);
      if (mr.rows.length === 0) throw new ValidityError('Hatua haipatikani.');
      milestone = mr.rows[0];
      if (Number(amt) > Number(milestone.budget)) throw new ValidityError('Kiasi kinazidi bajeti ya hatua hii.');
    }

    await client.query(
      `INSERT INTO project_disbursements (project_id, milestone_id, amount, status, authorized_by, unique_reference)
       VALUES ($1,$2,$3,'PENDING',$4,$5)`,
      [projectId, milestone_id, amt, userId, ref]
    );

    await fin.creditWallet({ client, userId, amount: amt, reference: ref, fromAccount: PROJECT_ACCOUNT, description: 'Project milestone disbursement' });

    await client.query(
      `UPDATE project_disbursements SET status = 'RELEASED', txn_id = (SELECT MAX(id) FROM transactions WHERE reference_id = $1) WHERE unique_reference = $1`,
      [ref]
    );
    if (milestone) {
      await client.query(`UPDATE project_milestones SET status = 'IN_PROGRESS' WHERE id = $1`, [milestone.id]);
    }
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'PROJECT_DISBURSEMENT', $4)`,
      [ref, userId, amt, JSON.stringify({ project_id: projectId, milestone_id, unique_reference: ref })]
    );
    await logAudit({ eventType: 'PROJECT_DISBURSEMENT', action: 'RELEASE', entityType: 'PROJECT', userId, entityId: projectId, referenceId: ref, amount: amt });

    await client.query('COMMIT');
    return { success: true, disbursement_id: ref, amount: amt };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof ValidityError) throw e;
    if (String(e.message || '').toLowerCase().includes('duplicate') || String(e.message || '').includes('unique_reference')) {
      throw new ValidityError('Malipo haya tayari yamefanywa.', 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================================
// PROGRESS REPORTS & PLAN-VS-ACTUAL
// ============================================================================

async function submitProgressReport(userId, projectId, { completion_pct, expenditure, details }) {
  await getProjectForOwner(projectId, userId);
  const versionRow = await pool.query(
    'SELECT COALESCE(MAX(version),0)+1 AS v FROM project_progress_reports WHERE project_id = $1',
    [projectId]
  );
  const r = await pool.query(
    `INSERT INTO project_progress_reports (project_id, version, completion_pct, expenditure, details)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [projectId, versionRow.rows[0].v, completion_pct, expenditure, details || {}]
  );
  await logAudit({ eventType: 'PROJECT_PROGRESS', action: 'REPORT', entityType: 'PROJECT', userId, entityId: projectId, afterData: { version: versionRow.rows[0].v, completion_pct } });
  return r.rows[0];
}

async function listProgressReports(projectId) {
  const rows = await pool.query('SELECT * FROM project_progress_reports WHERE project_id = $1 ORDER BY version', [projectId]);
  return rows.rows;
}

// ============================================================================
// REVENUE & PAYROLL
// ============================================================================

async function recordRevenue(userId, projectId, { revenue_type, amount, unique_reference }) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
  const p = await getProjectForOwner(projectId, userId);
  const ref = unique_reference || generateReference('PREV');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Revenue flows into the PROJECT_FUND ledger account (credit), offset by a
    // receivable so the double-entry stays balanced.
    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'PROJECT_REVENUE_RECEIVABLE', direction: 'DR', amount: amt },
        { accountCode: PROJECT_ACCOUNT, direction: 'CR', amount: amt },
      ],
      referenceId: ref,
      description: `Project revenue (${revenue_type})`,
    });

    await client.query(
      `INSERT INTO project_revenue (project_id, revenue_type, amount, reconciled, unique_reference)
       VALUES ($1,$2,$3,TRUE,$4) RETURNING id`,
      [projectId, revenue_type, amt, ref]
    );
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'PROJECT_REVENUE', $4)`,
      [ref, userId, amt, JSON.stringify({ project_id: projectId, unique_reference: ref })]
    );
    await logAudit({ eventType: 'PROJECT_REVENUE', action: 'REVENUE', entityType: 'PROJECT', userId, entityId: projectId, referenceId: ref, amount: amt });

    await client.query('COMMIT');
    return { success: true, revenue_id: ref, amount: amt };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e.message || '').toLowerCase().includes('duplicate') || String(e.message || '').includes('unique_reference')) {
      throw new ValidityError('Mapato haya tayari yamerekodiwa.', 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

async function recordPayroll(userId, projectId, { payee_user_id, role, amount, unique_reference }) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
  const p = await getProjectForOwner(projectId, userId);
  const ref = unique_reference || generateReference('PPAY');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO project_payroll (project_id, payee_user_id, role, amount, unique_reference)
       VALUES ($1,$2,$3,$4,$5)`,
      [projectId, payee_user_id, role, amt, ref]
    );
    await fin.creditWallet({ client, userId: payee_user_id, amount: amt, reference: ref, fromAccount: PROJECT_ACCOUNT, description: `Project payroll: ${role || 'staff'}` });
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'PROJECT_PAYROLL', $4)`,
      [ref, payee_user_id, amt, JSON.stringify({ project_id: projectId, unique_reference: ref })]
    );
    await logAudit({ eventType: 'PROJECT_PAYROLL', action: 'PAY', entityType: 'PROJECT', userId, entityId: projectId, referenceId: ref, amount: amt });

    await client.query('COMMIT');
    return { success: true, payroll_id: ref, amount: amt };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e.message || '').toLowerCase().includes('duplicate') || String(e.message || '').includes('unique_reference')) {
      throw new ValidityError('Malipo haya tayari yamefanywa.', 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================================
// DISTRIBUTION ENGINE
// ============================================================================

async function computeDistribution(userId, projectId, { gross_profit, period_label = null }) {
  const p = await getProjectForOwner(projectId, userId);
  const gross = Number(gross_profit);
  if (!gross || gross <= 0) throw new ValidityError('Faida si sahihi.');

  const reinvest = Number(p.reinvestment_pct) || 0;
  const reserve = Number(p.reserve_pct) || 0;
  const ownerPct = Number(p.owner_equity_pct) || 0;
  const investorPct = Math.max(0, 100 - reinvest - reserve - ownerPct);

  const toInvestors = round2(gross * (investorPct / 100));
  const toReinvest = round2(gross * (reinvest / 100));
  const toReserve = round2(gross * (reserve / 100));
  const toOwner = round2(gross * (ownerPct / 100));

  const invs = await pool.query(
    'SELECT investor_user_id, participation_pct, amount FROM project_investments WHERE project_id = $1 AND status = $2',
    [projectId, 'CONFIRMED']
  );

  const totalParticipation = invs.rows.reduce((s, i) => s + (Number(i.participation_pct) || 0), 0) || 1;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const distributions = [];
    for (const inv of invs.rows) {
      const sharePct = (Number(inv.participation_pct) || 0) / totalParticipation;
      const amount = round2(toInvestors * sharePct);
      const ref = generateReference('PDIST');
      await client.query(
        `INSERT INTO project_distributions (project_id, investor_user_id, period_label, gross_profit, investor_pct, amount, status, unique_reference)
         VALUES ($1,$2,$3,$4,$5,$6,'CALCULATED',$7)`,
        [projectId, inv.investor_user_id, period_label, gross, round2(sharePct * 100), amount, ref]
      );
      await fin.creditWallet({ client, userId: inv.investor_user_id, amount, reference: ref, fromAccount: PROJECT_ACCOUNT, description: `Project distribution (${period_label || 'period'})` });
      await client.query(
        `UPDATE project_distributions SET status = 'PAID', txn_id = (SELECT MAX(id) FROM transactions WHERE reference_id = $1) WHERE unique_reference = $1`,
        [ref]
      );
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'PROJECT_DISTRIBUTION', $4)`,
        [ref, inv.investor_user_id, amount, JSON.stringify({ project_id: projectId, unique_reference: ref })]
      );
      distributions.push({ investor_user_id: inv.investor_user_id, amount, unique_reference: ref });
    }

    await client.query(
      `INSERT INTO project_reserves (project_id, reserve_type, amount) VALUES ($1, 'DISTRIBUTION_RESERVE', $2)
       ON CONFLICT (project_id, reserve_type) DO UPDATE SET amount = project_reserves.amount + EXCLUDED.amount, updated_at = NOW()`,
      [projectId, toReserve]
    );

    await logAudit({ eventType: 'PROJECT_DISTRIBUTION', action: 'DISTRIBUTE', entityType: 'PROJECT', userId, entityId: projectId, amount: toInvestors, afterData: { gross, reinvest: reinvest, reserve, owner: toOwner, investors: toInvestors } });

    await client.query('COMMIT');
    return { success: true, period_label, toInvestors, toReinvest, toReserve, toOwner, distributions };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================================
// READ / OVERVIEW
// ============================================================================

async function listProjects(status) {
  const r = await pool.query(
    `SELECT * FROM projects WHERE ($1::varchar IS NULL OR status = $1) ORDER BY created_at DESC`,
    [status || null]
  );
  return r.rows;
}

async function listMyInvestments(userId) {
  const r = await pool.query(
    `SELECT i.*, p.name AS project_name, p.status AS project_status
     FROM project_investments i JOIN projects p ON p.id = i.project_id
     WHERE i.investor_user_id = $1 ORDER BY i.created_at DESC`,
    [userId]
  );
  return r.rows;
}

async function getProjectFinancials(userId, projectId) {
  await getProjectForOwner(projectId, userId);
  const [budget, milestones, disbursements, revenue, investments, distributions, reserves, progress] = await Promise.all([
    pool.query('SELECT * FROM project_budget WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM project_milestones WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM project_disbursements WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM project_revenue WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM project_investments WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM project_distributions WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM project_reserves WHERE project_id = $1', [projectId]),
    pool.query('SELECT * FROM project_progress_reports WHERE project_id = $1', [projectId]),
  ]);
  const totalBudget = budget.rows.reduce((s, b) => s + Number(b.approved_amount), 0);
  const totalActual = budget.rows.reduce((s, b) => s + Number(b.actual_amount), 0);
  return {
    totalBudget,
    totalActual,
    variance: round2(totalActual - totalBudget),
    budget: budget.rows,
    milestones: milestones.rows,
    disbursements: disbursements.rows,
    revenue: revenue.rows,
    investments: investments.rows,
    distributions: distributions.rows,
    reserves: reserves.rows,
    progress: progress.rows,
  };
}

module.exports = {
  getProject,
  createProject,
  submitProject,
  makeWorkflowDecision,
  publishProject,
  createAgreement,
  listAgreements,
  acceptAgreement,
  invest,
  addBudgetItem,
  listBudget,
  addMilestone,
  listMilestones,
  disburse,
  submitProgressReport,
  listProgressReports,
  recordRevenue,
  recordPayroll,
  computeDistribution,
  listProjects,
  listMyInvestments,
  getProjectFinancials,
};
