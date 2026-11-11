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
const { createNotification } = require('./notificationService');

const PROJECT_ACCOUNT = 'PROJECT_INVESTMENT_ACCOUNT';
const projectFinance = require('./projectFinanceService');

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
        risks, assumptions, business_plan,
        business_model, market_analysis, competition_analysis, management_team,
        use_of_funds, exit_timeline, compliance_certifications, funding_deadline, status, current_stage)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,$24,$25,$26,'DRAFT','DRAFT')
     RETURNING *`,
    [userId, data.name, data.description, data.category, data.location,
     data.capital_required, data.min_investment, data.duration_days,
     data.expected_revenue, data.expected_costs, data.projected_profit,
     data.reinvestment_pct, data.reserve_pct, data.owner_equity_pct,
     data.distribution_method, data.risks, data.assumptions, data.business_plan,
     data.business_model, data.market_analysis, data.competition_analysis, data.management_team,
     data.use_of_funds, data.exit_timeline, data.compliance_certifications,
     data.funding_deadline || null]
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
  try {
    await projectFinance.runAiReview(projectId);
  } catch (e) {
    // AI scoring is advisory-only; a failed run must never block submission.
    logAudit({ eventType: 'AI_REVIEW_FAILED', action: 'CREATE', entityType: 'PROJECT_AI_REVIEW', userId, entityId: projectId, afterData: { error: e.message } });
  }
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
  if (p.funding_deadline && new Date(p.funding_deadline) < new Date()) throw new ValidityError('Muda wa ufadhili umekwisha.');
  const min = Number(p.min_investment) || 0;
  if (amt < min) throw new ValidityError(`Kiasi cha chini cha uwekezaji ni ${min}.`);

  const ref = unique_reference || generateReference('PINV');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    const cur = await client.query(
      `SELECT status, amount_raised, capital_required FROM projects WHERE id = $1`, [projectId]
    );
    const row = cur.rows[0];
    if (!['PUBLISHED', 'FUNDING'].includes(row.status)) throw new ValidityError('Mradi huu haukubali uwekezaji kwa sasa.');
    const remaining = Number(row.capital_required) - Number(row.amount_raised);
    if (remaining <= 0) throw new ValidityError('Mradi umekamilisha mahitaji ya ufadhili.');
    if (amt > remaining) throw new ValidityError(`Uwekezaji unazidi salio. Kiasi kilichobakia kujaza ni ${remaining}.`);

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
         status = CASE WHEN amount_raised + $1 >= capital_required THEN 'ACTIVE' ELSE 'FUNDING' END,
         updated_at = NOW()
       WHERE id = $2`,
      [amt, projectId]
    );

    // Phase 71 / OBS-7: escrow projection and waterfall freeze in THIS transaction,
    // under the projects row lock taken above (never after COMMIT).
    await projectFinance.recordFundingInTransaction({ client, projectId, amount: amt });

    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'PROJECT_INVEST', $4)`,
      [ref, userId, amt, JSON.stringify({ project_id: projectId, unique_reference: ref })]
    );

    await logAudit({ eventType: 'PROJECT_INVEST', action: 'INVEST', entityType: 'PROJECT', userId, entityId: projectId, referenceId: ref, amount: amt });

    await client.query('COMMIT');

    // Owner notification only (escrow and freeze were committed above).
    try {
      await projectFinance.onFundingReceived({ projectId, amount: amt });
    } catch (e) {
      console.error('PROJECT_FINANCE', 'onFundingReceived failed:', e.message);
    }
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
 * Governed disbursement: the owner may only REQUEST a tranche against an
 * expert-approved milestone. No money moves here; release requires the
 * expert review → authorize → execute path (projectFinanceService) with
 * segregation of duties. Idempotent via unique_reference.
 */
async function disburse(userId, projectId, { milestone_id, amount, unique_reference }) {
  return projectFinance.requestDisbursement(userId, projectId, { milestone_id, amount, unique_reference });
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

    // Revenue flows into the PROJECT_REVENUE_ACCOUNT ledger account (credit),
    // offset by a receivable so the double-entry stays balanced. The waterfall
    // allocation itself runs via /revenue/process-incoming (projectFinanceService).
    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'PROJECT_REVENUE_RECEIVABLE', direction: 'DR', amount: amt },
        { accountCode: 'PROJECT_REVENUE_ACCOUNT', direction: 'CR', amount: amt },
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
  await getProjectForOwner(projectId, userId);
  const payee = Number(payee_user_id);
  if (!Number.isInteger(payee) || payee <= 0) throw new ValidityError('Mlipwaji si sahihi.');
  const ref = unique_reference || generateReference('PPAY');

  // Phase 71 / F7 + F2 (owner decision): payroll is paid from
  // PROJECT_INVESTMENT_ACCOUNT, i.e. this project's investor capital held in
  // escrow, so it follows the escrow controls: ACTIVE project only, paid only
  // from THIS project's escrow remaining_balance (never another project's money
  // in the shared ledger account), decremented under lock, fail-closed.
  // Lock order (same as refunds / completion / disbursement):
  //   projects FOR UPDATE -> payee users row FOR UPDATE -> escrow row.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT id, status, owner_user_id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (locked.rows.length === 0) throw new ValidityError('Mradi haupatikani.', 404);
    if (locked.rows[0].owner_user_id !== userId) throw new ValidityError('Huna ruhusa za mradi huu.', 403);
    if (locked.rows[0].status !== 'ACTIVE') {
      const notActive = new ValidityError(`Malipo ya payroll yanaruhusiwa tu mradi ukiwa ACTIVE (sasa: ${locked.rows[0].status}).`, 409);
      notActive.code = 'PAYROLL_PROJECT_NOT_ACTIVE';
      throw notActive;
    }
    const payeeRow = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [payee]);
    if (payeeRow.rows.length === 0) throw new ValidityError('Mlipwaji hapatikani.', 404);
    await client.query(
      `INSERT INTO project_payroll (project_id, payee_user_id, role, amount, unique_reference)
       VALUES ($1,$2,$3,$4,$5)`,
      [projectId, payee, role, amt, ref]
    );
    const escrow = await client.query(
      `UPDATE controlled_project_accounts
          SET remaining_balance = remaining_balance - $2, updated_at = NOW()
        WHERE project_id = $1 AND status <> 'CLOSED' AND remaining_balance >= $2`,
      [projectId, amt]
    );
    if (escrow.rowCount !== 1) {
      const short = new ValidityError('Salio la escrow la mradi huu halitoshi kwa malipo haya; hakuna kilicholipwa.', 409);
      short.code = 'PAYROLL_ESCROW_INSUFFICIENT';
      throw short;
    }
    const credited = await fin.creditWallet({ client, userId: payee, amount: amt, reference: ref, fromAccount: PROJECT_ACCOUNT, description: `Project payroll: ${role || 'staff'}` });
    if (credited && credited.dedup) throw new ValidityError('Malipo haya tayari yamefanywa.', 409);
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'PROJECT_PAYROLL', $4)`,
      [ref, payee, amt, JSON.stringify({ project_id: projectId, unique_reference: ref })]
    );
    // Inside the transaction (an audit failure rolls the payment back).
    await logAudit({ eventType: 'PROJECT_PAYROLL', action: 'PAY', entityType: 'PROJECT', userId, entityId: projectId, referenceId: ref, amount: amt, afterData: { payee_user_id: payee, source: 'ESCROW' }, client });

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

async function computeDistribution(userId, projectId, { gross_profit } = {}) {
  await getProjectForOwner(projectId, userId);
  const gross = Number(gross_profit);
  if (!gross || gross <= 0) throw new ValidityError('Faida si sahihi.');
  // Phase 71 / F7 (owner decision): profit distribution must be supported by
  // evidence of revenue and of distributable profit. This legacy path paid
  // investors from PROJECT_INVESTMENT_ACCOUNT (investor capital, shared by all
  // projects) using a request-supplied gross_profit, with no link to any
  // recorded revenue or profit. It is therefore refused (fail-closed) and moves
  // no money; nothing is written. Defining distributable profit is an owner
  // decision and is not implemented here.
  const refused = new ValidityError(
    'Mgawanyo huu wa faida umezuiwa: hauungwi mkono na ushahidi wa mapato na faida inayostahili kugawanywa. Hakuna kilicholipwa.', 409);
  refused.code = 'PROJECT_DISTRIBUTION_UNSUPPORTED';
  throw refused;
}

// ============================================================================
// FUNDING DEADLINE EXPIRY
// ============================================================================

/**
 * Sweep: expire all FUNDING projects whose funding_deadline has passed and
 * amount_raised < capital_required. Best-effort; errors are logged per-project.
 */
async function expireUnfundedProjects(client = pool) {
  const r = await client.query(
    `UPDATE projects
       SET status = 'EXPIRED', funding_expired_at = NOW(), updated_at = NOW()
     WHERE funding_deadline IS NOT NULL
       AND funding_deadline < NOW()
       AND status IN ('FUNDING')
       AND amount_raised < capital_required
     RETURNING id, name, owner_user_id, amount_raised, capital_required`
  );
  for (const p of r.rows) {
    try {
      await logAudit({
        eventType: 'PROJECT_FUNDING_EXPIRED', action: 'EXPIRE', entityType: 'PROJECT',
        userId: p.owner_user_id, entityId: p.id,
        afterData: { amount_raised: p.amount_raised, capital_required: p.capital_required },
      });
    } catch (_) { /* best-effort */ }
  }
  return { expired: r.rows.length, ids: r.rows.map(p => p.id) };
}

// ============================================================================
// INVESTMENT REFUND
// ============================================================================

/**
 * Refund a confirmed investment when the project has EXPIRED (failed to reach
 * funding target). Double-entry: DR PROJECT_INVESTMENT_ACCOUNT / CR CUSTOMER_WALLET.
 * Idempotent via refund_reference UNIQUE.
 */
async function refundInvestment(projectId, investmentId, userId) {
  const p = await getProject(projectId);
  if (p.status !== 'EXPIRED') throw new ValidityError('Mradi haujaexpira; not yet eligible for refund.');

  const invR = await pool.query(
    `SELECT * FROM project_investments WHERE id = $1 AND project_id = $2`,
    [investmentId, projectId]
  );
  if (invR.rows.length === 0) throw new ValidityError('Uwekezaji haujapatikana.', 404);
  const inv = invR.rows[0];
  if (inv.investor_user_id !== userId) throw new ValidityError('Huna ruhusa ya kurejesha uwekezaji huu.', 403);
  if (inv.status !== 'CONFIRMED') throw new ValidityError(`Hali ya uwekezaji (${inv.status}) hairuhusu kurejeshwa.`);
  if (inv.refund_reference) {
    return { success: true, refund_reference: inv.refund_reference, refunded_at: inv.refunded_at, already_refunded: true };
  }

  const refundRef = generateReference('PREF');
  const amt = Number(inv.amount);

  const client = await pool.connect();
  let committed = false; // errors after COMMIT are never mapped to 409
  let stage = 'start';   // last step entered; logged when a refund is refused
  try {
    await client.query('BEGIN');
    // Phase 71 / E0b. Lock order, the same as forceCloseFunding
    // (src/services/projectFinanceService.js), always:
    //   1. the project row FOR UPDATE,
    //   2. the investment(s) FOR UPDATE ORDER BY id,
    //   3. the investor's users row ORDER BY id FOR UPDATE,
    // all before creditWallet. The checks made above, outside the transaction,
    // are repeated here under the locks: a parallel refund (either path) of
    // the same investment waits at step 1 and then sees it REFUNDED.
    stage = 'project-lock';
    const lockedProject = await client.query('SELECT id, status FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (lockedProject.rows.length === 0) throw new ValidityError('Mradi haupatikani.', 404);
    if (lockedProject.rows[0].status !== 'EXPIRED') throw new ValidityError('Mradi haujaexpira; not yet eligible for refund.');
    stage = 'investment-lock';
    const lockedInv = await client.query(
      `SELECT * FROM project_investments WHERE id = $1 AND project_id = $2
       ORDER BY id
       FOR UPDATE`,
      [investmentId, projectId]
    );
    if (lockedInv.rows.length === 0) throw new ValidityError('Uwekezaji haujapatikana.', 404);
    const cur = lockedInv.rows[0];
    if (cur.investor_user_id !== userId) throw new ValidityError('Huna ruhusa ya kurejesha uwekezaji huu.', 403);
    if (cur.status !== 'CONFIRMED') throw new ValidityError(`Hali ya uwekezaji (${cur.status}) hairuhusu kurejeshwa.`);
    if (cur.refund_reference) {
      await client.query('COMMIT');
      committed = true;
      return { success: true, refund_reference: cur.refund_reference, refunded_at: cur.refunded_at, already_refunded: true };
    }
    stage = 'users-lock';
    await client.query('SELECT id FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [[userId]]);
    stage = 'mark-refunded';
    const marked = await client.query(
      `UPDATE project_investments SET refund_reference = $1, refunded_at = NOW(), status = 'REFUNDED' WHERE id = $2 AND status = 'CONFIRMED'`,
      [refundRef, investmentId]
    );
    // The row is locked and was read CONFIRMED: exactly one row must flip.
    if (marked.rowCount !== 1) {
      const changed = new ValidityError('Hali ya uwekezaji imebadilika wakati wa kurejesha; hakuna kilichorejeshwa, jaribu tena.', 409);
      changed.code = 'FUNDING_REFUND_STATE_CHANGED';
      throw changed;
    }
    // Phase 71 / F2: rejected (409) when the escrow cannot cover the refund;
    // no GREATEST(..., 0) floor that would hide a shortfall.
    stage = 'escrow';
    await projectFinance.applyRefundToEscrow({ client, projectId, amount: amt });
    stage = 'credit';
    await fin.creditWallet({ client, userId, amount: amt, reference: refundRef, fromAccount: PROJECT_ACCOUNT, description: 'Project investment refund' });
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1,$2,$3,0,$3,'SUCCESS','PROJECT_REFUND',$4)`,
      [refundRef, userId, amt, JSON.stringify({ project_id: projectId, investment_id: inv.id, refund_reference: refundRef })]
    );
    // On the refund's own client (Phase 71 / E0b): audit_logs.user_id has an FK
    // to users, and this transaction holds the investor's users row FOR UPDATE,
    // so a separate pool connection waited lock_timeout (3 s) and the audit row
    // was silently lost. Inside the transaction, an audit failure now rolls the
    // whole refund back (writeAudit rethrows when given a client).
    await logAudit({ eventType: 'PROJECT_REFUND', action: 'REFUND', entityType: 'PROJECT_INVESTMENT', userId, entityId: investmentId, referenceId: refundRef, amount: amt, client });
    await client.query('COMMIT');
    committed = true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (!committed && e && (e.code === '55P03' || e.code === '40P01')) {
      require('../utils/logger').warn(
        'PROJECT_FUNDING_REFUND',
        `refundInvestment ${investmentId} for project ${projectId} not completed at stage ${stage} (${e.code}): ${e.message}`,
        { code: e.code, projectId, investmentId, path: 'refundInvestment', stage, table: e.table || null, routine: e.routine || null }
      );
      const busy = new ValidityError(
        'Urejeshaji wa uwekezaji haukukamilika kwa sababu ya shughuli nyingine zinazoendelea. Hakuna kilichorejeshwa. Jaribu tena baadaye.', 409);
      busy.code = 'FUNDING_REFUND_IN_PROGRESS';
      throw busy;
    }
    throw e;
  } finally {
    client.release();
  }
  createNotification(userId, {
    title: 'Uwekezaji umerudishwa',
    body: `Uwekezaji wako TZS ${Number(amt).toLocaleString('en-US')} katika "${p.name}" umerudishwa. Rejea: ${refundRef}`,
    type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
  }).catch(() => {});
  return { success: true, refund_reference: refundRef, amount: amt };
}

// ============================================================================
// CAP TABLE
// ============================================================================

async function getCapTable(projectId, { userId, role } = {}) {
  const p = await getProject(projectId);
  const invAccess = await pool.query(
    `SELECT investor_user_id FROM project_investments
      WHERE project_id = $1 AND investor_user_id = $2 AND status IN ('CONFIRMED','REFUNDED')`,
    [projectId, userId]
  );
  const isOwner = p.owner_user_id === userId;
  const isExpert = ['ADMIN', 'MODERATOR', 'EXPERT'].includes(role);
  const isInvestor = invAccess.rows.length > 0;
  if (!isOwner && !isExpert && !isInvestor) throw new ValidityError('Huna ruhusa ya kuona orodha ya wawekezaji.', 403);
  const r = await pool.query(
    `SELECT i.id AS investment_id, i.investor_user_id, u.full_name, u.phone_number,
            i.amount, i.participation_pct, i.status, i.refund_reference, i.refunded_at, i.created_at
       FROM project_investments i
       JOIN users u ON u.id = i.investor_user_id
      WHERE i.project_id = $1
      ORDER BY i.created_at ASC`,
    [projectId]
  );
  const payouts = await pool.query(
    `SELECT investor_user_id, COALESCE(SUM(entitlement),0) AS total_entitlement
       FROM project_investor_payouts
      WHERE project_id = $1 AND status = 'PAID'
      GROUP BY investor_user_id`,
    [projectId]
  );
  const paidMap = {};
  for (const row of payouts.rows) paidMap[row.investor_user_id] = Number(row.total_entitlement);
  return {
    project: { id: p.id, name: p.name, capital_required: p.capital_required, amount_raised: p.amount_raised, funding_deadline: p.funding_deadline, status: p.status },
    investors: r.rows.map(inv => ({ ...inv, total_payouts: paidMap[inv.investor_user_id] || 0 })),
    total_investors: r.rows.length,
    is_owner: isOwner,
  };
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
  expireUnfundedProjects,
  refundInvestment,
  getCapTable,
};
