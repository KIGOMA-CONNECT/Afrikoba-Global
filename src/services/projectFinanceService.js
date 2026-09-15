/**
 * Project Finance Governance Service
 *
 * Implements the Afrikoba FinOS project-finance foundation:
 *   Phase 0 — segregated internal project ledger accounts (sub-ledgers)
 *   Phase 1 — versioned / freezable waterfall allocation rules + idempotent,
 *             double-entry process-incoming waterfall runs
 *   Phase 2 — milestone proof submission & expert review; two-phase
 *             (request → review → authorize → release) disbursement with
 *             segregation of duties
 *   Project documents CRUD + immutable audit trail visibility
 *
 * Non-negotiables honoured:
 *   - Ledger (journal_entries) is the source of truth. No balance change
 *     without a balanced double-entry posting through financialEngine.
 *   - Idempotency: every revenue/disbursement event claims a unique
 *     reference in financial_operations before posting.
 *   - Segregation of duties: the requester can never approve/execute his
 *     own request.
 *   - Frozen waterfall rules cannot change; amendments become new versions
 *     effective on an approved date.
 *   - Financial events are append-only (no hard deletes).
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const pool = require('../config/db');
const { generateReference, formatMoney } = require('../utils/helpers');
const fin = require('./financialEngine');
const { logAudit } = require('./auditService');
const { createNotification } = require('./notificationService');
const { enqueueOutbox } = require('./outboxService');

const ACCOUNTS = {
  INVESTMENT: 'PROJECT_INVESTMENT_ACCOUNT',
  REVENUE: 'PROJECT_REVENUE_ACCOUNT',
  TAX: 'PROJECT_TAX_ACCOUNT',
  RESERVE: 'PROJECT_RESERVE_ACCOUNT',
  DEBT_SERVICE: 'PROJECT_DEBT_SERVICE_ACCOUNT',
  DIVIDEND: 'PROJECT_DIVIDEND_ACCOUNT',
  OPERATING: 'PROJECT_OPERATING_ACCOUNT',
  OWNER_RESIDUAL: 'PROJECT_OWNER_RESIDUAL_ACCOUNT',
};

const INVESTMENT_ACCOUNT = 'PROJECT_INVESTMENT_ACCOUNT';

// Ordered waterfall steps (Phase 1 order: tax → opex → payroll → debt →
// reserve → investor dividends → owner residual).
const WATERFALL_STEPS = [
  { key: 'TAX', column: 'tax_percentage', dest: ACCOUNTS.TAX, priority: 1 },
  { key: 'OPEX', column: 'opex_percentage', dest: ACCOUNTS.OPERATING, priority: 2 },
  { key: 'PAYROLL', column: 'payroll_percentage', dest: ACCOUNTS.OPERATING, priority: 3 },
  { key: 'DEBT_SERVICE', column: 'debt_service_percentage', dest: ACCOUNTS.DEBT_SERVICE, priority: 4 },
  { key: 'RESERVE', column: 'reserve_fund_percentage', dest: ACCOUNTS.RESERVE, priority: 5 },
  { key: 'DIVIDEND', column: 'investor_dividend_percentage', dest: ACCOUNTS.DIVIDEND, priority: 6 },
  { key: 'OWNER_RESIDUAL', column: 'owner_residual_percentage', dest: ACCOUNTS.OWNER_RESIDUAL, priority: 7 },
];

const EXPERT_ROLES = ['ADMIN', 'MODERATOR', 'EXPERT'];

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

class ValidityError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isExpert(role) {
  return EXPERT_ROLES.includes(role);
}

async function getProject(projectId, client = pool) {
  const r = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (r.rows.length === 0) throw new ValidityError('Mradi haupatikani.', 404);
  return r.rows[0];
}

async function getOwnerOnly(projectId, userId, client = pool) {
  const p = await getProject(projectId, client);
  if (p.owner_user_id !== userId) throw new ValidityError('Huna ruhusa za mradi huu.', 403);
  return p;
}

// ============================================================================
// PHASE 1 — WATERFALL ALLOCATION RULES (VERSIONED, FREEZABLE)
// ============================================================================

const RULE_COLUMNS = ['tax_percentage', 'opex_percentage', 'payroll_percentage',
  'debt_service_percentage', 'reserve_fund_percentage',
  'investor_dividend_percentage', 'owner_residual_percentage'];

function normalizePercentages(data) {
  const pct = {};
  for (const col of RULE_COLUMNS) {
    const raw = data && data[col];
    const v = raw === undefined || raw === null ? 0 : Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new ValidityError(`Asilimia ya '${col}' si sahihi (0-100).`);
    pct[col] = v;
  }
  const total = round2(RULE_COLUMNS.reduce((s, c) => s + pct[c], 0));
  if (total !== 100) throw new ValidityError(`Jumla ya asilimia lazima iwe 100 (imepata ${total}).`);
  return pct;
}

/** Current (non-superseded) version of the rules for a project. */
async function getEffectiveRule(projectId, client = pool) {
  const r = await client.query(
    `SELECT * FROM waterfall_allocation_rules
     WHERE project_id = $1 AND status <> 'SUPERSEDED'
     ORDER BY version DESC LIMIT 1`,
    [projectId]
  );
  return r.rows[0] || null;
}

/** Rules list for a project (all versions). */
async function listWaterfallRules(projectId) {
  const r = await pool.query(
    `SELECT * FROM waterfall_allocation_rules WHERE project_id = $1 ORDER BY version DESC`,
    [projectId]
  );
  return r.rows;
}

/**
 * Owner creates / proposes the initial (version 1) rules. Draft until approved.
 */
async function createInitialRules(userId, projectId, data) {
  await getOwnerOnly(projectId, userId);
  const pct = normalizePercentages(data);
  const existing = await pool.query(
    'SELECT 1 FROM waterfall_allocation_rules WHERE project_id = $1 LIMIT 1', [projectId]
  );
  if (existing.rows.length > 0) throw new ValidityError('Waterfall rules tayari zipo kwa mradi huu.');
  const r = await pool.query(
    `INSERT INTO waterfall_allocation_rules (project_id, version, status,
        ${RULE_COLUMNS.join(', ')}, proposed_by, proposed_at)
     VALUES ($1, 1, 'DRAFT', ${RULE_COLUMNS.map((_, i) => `$${i + 2}`).join(', ')}, $${RULE_COLUMNS.length + 2}, NOW())
     RETURNING *`,
    [projectId, ...RULE_COLUMNS.map((c) => pct[c]), userId]
  );
  await logAudit({ eventType: 'WATERFALL_RULES_CREATED', action: 'CREATE', entityType: 'WATERFALL_RULE', userId, entityId: projectId });
  return r.rows[0];
}

/**
 * Propose an amendment. If the current rule is FROZEN (or ACTIVE), the change
 * always becomes a NEW version (never mutates a frozen rule directly).
 */
async function proposeWaterfallRules(userId, projectId, data) {
  await getOwnerOnly(projectId, userId);
  const pct = normalizePercentages(data);
  const current = await getEffectiveRule(projectId);
  if (!current) throw new ValidityError('Anzisha waterfall rules kwanza.');

  const vNext = current.version + 1;
  const r = await pool.query(
    `INSERT INTO waterfall_allocation_rules
       (project_id, version, status, ${RULE_COLUMNS.join(', ')},
        proposed_by, proposed_at, supersedes_rule_id, change_reason)
     VALUES ($1, $2, 'PROPOSED', $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11, $12)
     RETURNING *`,
    [projectId, vNext, ...RULE_COLUMNS.map((c) => pct[c]), userId, current.id, data.change_reason || null]
  );
  await logAudit({ eventType: 'WATERFALL_RULES_PROPOSED', action: 'PROPOSE', entityType: 'WATERFALL_RULE', userId, entityId: r.rows[0].id, afterData: { version: vNext } });
  return r.rows[0];
}

/**
 * Expert/admin approves a DRAFT or PROPOSED rule → ACTIVE. Marks any prior
 * non-frozen rule SUPERSEDED. If a later version already took effect, skip.
 */
async function approveWaterfallRule(userId, ruleId, { effective_date } = {}) {
  const rule = await pool.query('SELECT * FROM waterfall_allocation_rules WHERE id = $1', [ruleId]);
  if (rule.rows.length === 0) throw new ValidityError('Waterfall rule haipatikani.', 404);
  const cur = rule.rows[0];
  if (!['DRAFT', 'PROPOSED'].includes(cur.status)) throw new ValidityError(`Rule iko katika hali '${cur.status}', haiwezi kuidhinishwa.`);

  const effective = effective_date || cur.effective_date || new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newer = await client.query(
      `SELECT 1 FROM waterfall_allocation_rules
       WHERE project_id = $1 AND id <> $2 AND version > $3 AND status IN ('ACTIVE','FROZEN') LIMIT 1`,
      [cur.project_id, cur.id, cur.version]
    );
    if (newer.rows.length > 0) throw new ValidityError('Kuna version ya hivi karibuni iliyokwisha kuwa ACTIVE/FROZEN.');

    await client.query(
      `UPDATE waterfall_allocation_rules
       SET status = 'SUPERSEDED', updated_at = NOW()
       WHERE project_id = $1 AND id <> $2 AND status NOT IN ('SUPERSEDED')`,
      [cur.project_id, cur.id]
    );
    await client.query(
      `UPDATE waterfall_allocation_rules
       SET status = 'ACTIVE', approved_by = $2, approved_at = NOW(), effective_date = $3, updated_at = NOW()
       WHERE id = $1`,
      [cur.id, userId, effective]
    );
    await logAudit({ eventType: 'WATERFALL_RULES_APPROVED', action: 'APPROVE', entityType: 'WATERFALL_RULE', userId, entityId: cur.id, afterData: { project_id: cur.project_id, version: cur.version, effective_date: effective } });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return (await pool.query('SELECT * FROM waterfall_allocation_rules WHERE id = $1', [ruleId])).rows[0];
}

async function setWaterfallFrozen(ruleId, frozen) {
  const r = await pool.query(
    `UPDATE waterfall_allocation_rules SET status = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [ruleId, frozen ? 'FROZEN' : 'ACTIVE']
  );
  if (r.rows.length === 0) throw new ValidityError('Waterfall rule haipatikani.', 404);
  return r.rows[0];
}

async function freezeWaterfallRule(userId, ruleId) {
  const rule = await setWaterfallFrozen(ruleId, true);
  await logAudit({ eventType: 'WATERFALL_RULES_FROZEN', action: 'FREEZE', entityType: 'WATERFALL_RULE', userId, entityId: ruleId });
  return rule;
}

async function unfreezeWaterfallRule(userId, ruleId) {
  const rule = await setWaterfallFrozen(ruleId, false);
  await logAudit({ eventType: 'WATERFALL_RULES_UNFROZEN', action: 'UNFREEZE', entityType: 'WATERFALL_RULE', userId, entityId: ruleId });
  return rule;
}

/**
 * Called after a successful investment. Ensures the project's controlled
 * account balance projection tracks the ledger, and freezes the active
 * waterfall rule from the moment funding begins (Phase 0/1 locking).
 */
async function onFundingReceived({ projectId, amount, firstFunding }) {
  const p = await getProject(projectId);
  const raised = Number(p.amount_raised) || 0;
  const target = Number(p.capital_required) || 0;
  const cur = p.currency_code || 'TZS';

  await pool.query(
    `INSERT INTO controlled_project_accounts
       (project_id, escrow_balance, remaining_balance, funding_target, currency, is_locked, status)
     VALUES ($1, $2, $2, $3, $4, TRUE, 'ACTIVE')
     ON CONFLICT (project_id) DO UPDATE
       SET escrow_balance = $2, remaining_balance = $2, funding_target = $3,
           updated_at = NOW()`,
    [projectId, raised, target, cur]
  );

  if (firstFunding) {
    const rule = await getEffectiveRule(projectId);
    if (rule && ['ACTIVE'].includes(rule.status)) {
      await setWaterfallFrozen(rule.id, true);
    }
  }

  const owner = await pool.query('SELECT id FROM users WHERE id = $1', [p.owner_user_id]);
  if (owner.rows.length > 0) {
    await createNotification(p.owner_user_id, {
      title: 'Ufadhili umepokelewa',
      body: `Mradi "${p.name}" umepokea ufadhili wa ${amount}.`,
      type: 'PROJECT',
      entityType: 'PROJECT',
      entityId: projectId,
    });
  }
}

// ============================================================================
// PHASE 1 — PROCESS INCOMING REVENUE (WATERFALL RUN, IDEMPOTENT)
// ============================================================================

/**
 * The single idempotent entry point for revenue:
 *   1. claim unique_reference (idempotency gate)
 *   2. record the revenue event append-only
 *   3. post balanced double-entry (DR RECEIVABLE / CR REVENUE_ACCOUNT)
 *   4. run the waterfall: for each step compute the allocation and post
 *      balanced journal (DR destination / CR REVENUE_ACCOUNT), recording
 *      full lineage in waterfall_allocation_records.
 * Percentages come exclusively from the ACTIVE/FROZEN rule (never code).
 */
async function processIncomingRevenue(userId, projectId, { amount, revenue_type, unique_reference, description } = {}) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
  const p = await getProject(projectId);

  const rule = await getEffectiveRule(projectId);
  if (!rule) throw new ValidityError('Waterfall rules hazijawekwa kwa mradi huu.');
  if (!['ACTIVE', 'FROZEN'].includes(rule.status)) throw new ValidityError('Waterfall rules bado hazijaidhinishwa.');

  const ref = unique_reference || generateReference('PREV');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claimed = await fin.claimOperation({
      client, operationType: 'PROJECT_REVENUE_PROCESS', reference: ref, userId, amount: amt,
    });
    if (!claimed.claimed) {
      throw new ValidityError('Mapato haya tayari yamechakatwa. Tumia unique_reference mpya.', 409);
    }

    const rev = await client.query(
      `INSERT INTO project_revenue (project_id, revenue_type, amount, reconciled, unique_reference)
       VALUES ($1,$2,$3,TRUE,$4) RETURNING id`,
      [projectId, revenue_type || 'SALES', amt, ref]
    );
    const txn = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1,$2,$3,0,$3,'SUCCESS','PROJECT_REVENUE',$4) RETURNING id`,
      [ref, userId, amt, JSON.stringify({ project_id: projectId, unique_reference: ref })]
    );

    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'PROJECT_REVENUE_RECEIVABLE', direction: 'DR', amount: amt },
        { accountCode: ACCOUNTS.REVENUE, direction: 'CR', amount: amt },
      ],
      referenceId: ref,
      description: description || `Project revenue (${revenue_type || 'SALES'})`,
      postedBy: `project:${userId}`,
      productType: 'PROJECT',
      productRef: String(projectId),
    });

    // Compute allocations; final step absorbs rounding so the waterfall sums
    // exactly to the incoming revenue.
    const allocations = [];
    let committed = 0;
    for (let i = 0; i < WATERFALL_STEPS.length; i++) {
      const step = WATERFALL_STEPS[i];
      const pct = Number(rule[step.column] || 0);
      let stepAmount = 0;
      if (i === WATERFALL_STEPS.length - 1) {
        stepAmount = Math.max(0, round2(amt - committed));
      } else if (pct > 0) {
        stepAmount = round2(amt * (pct / 100));
      }
      committed = round2(committed + stepAmount);
      allocations.push({ step, pct, amount: stepAmount });
    }

    // Confirmed investors (for per-investor dividend entitlements).
    const invRes = await client.query(
      `SELECT investor_user_id, amount, participation_pct
       FROM project_investments
       WHERE project_id = $1 AND status = 'CONFIRMED'`,
      [projectId]
    );
    const investors = invRes.rows;
    const totalRaised = round2(investors.reduce((s, i) => s + Number(i.amount), 0));
    const dividendNotices = [];

    for (const { step, pct, amount: stepAmount } of allocations) {
      if (stepAmount <= 0) continue;
      const stepRef = `${ref}-${step.key}`;
      const groupId = await fin.postJournal({
        client,
        lines: [
          { accountCode: step.dest, direction: 'DR', amount: stepAmount },
          { accountCode: ACCOUNTS.REVENUE, direction: 'CR', amount: stepAmount },
        ],
        referenceId: stepRef,
        description: `Waterfall ${step.key} allocation (rule v${rule.version})`,
        postedBy: `project:${userId}`,
        productType: 'PROJECT',
        productRef: String(projectId),
      });
      const allocRes = await client.query(
        `INSERT INTO waterfall_allocation_records
           (project_id, rule_id, rule_version, allocation_step, priority,
            revenue_transaction_id, revenue_reference, source_account_code,
            destination_account_code, calculation_basis, percentage, amount,
            currency, ledger_group_id, reconciliation_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PERCENTAGE',$10,$11,COALESCE($12,'TZS'),$13,'RECONCILED')
         RETURNING id`,
        [projectId, rule.id, rule.version, step.key, step.priority,
         txn.rows[0].id, ref, ACCOUNTS.REVENUE, step.dest, pct, stepAmount,
         p.currency_code || 'TZS', groupId]
      );
      if (step.key === 'DIVIDEND' && investors.length > 0) {
        for (const inv of investors) {
          const share = (inv.participation_pct == null || Number(inv.participation_pct) <= 0)
            ? (totalRaised > 0 ? Number(inv.amount) / totalRaised : 0)
            : Number(inv.participation_pct) / 100;
          const entitlement = round2(stepAmount * Math.min(Math.max(share, 0), 1));
          if (entitlement <= 0) continue;
          const payoutRef = `${ref}-div-${step.key}-u${inv.investor_user_id}`;
          await client.query(
            `INSERT INTO project_investor_payouts
               (project_id, allocation_id, investor_user_id, entitlement, payout_reference)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (payout_reference) DO NOTHING`,
            [projectId, allocRes.rows[0].id, inv.investor_user_id, entitlement, payoutRef]
          );
          dividendNotices.push({ investor_user_id: inv.investor_user_id, entitlement, payoutRef });
        }
      }
    }

    await logAudit({ eventType: 'PROJECT_REVENUE_PROCESSED', action: 'PROCESS', entityType: 'PROJECT', userId, entityId: projectId, referenceId: ref, amount: amt, afterData: { rule_version: rule.version } });

    await client.query('COMMIT');

    // Transactional notifications: fired only after COMMIT succeeded.
    for (const notice of dividendNotices) {
      await createNotification(notice.investor_user_id, {
        title: 'Mgawanyo wa faida',
        body: `Mradi "${p.name}" ulipokea mapato ${amt}. Mgawanyo wako: TZS ${notice.entitlement}.`,
        type: 'PROJECT',
        entityType: 'PROJECT',
        entityId: projectId,
      });
    }
    for (const inv of investors) {
      await createNotification(inv.investor_user_id, {
        title: 'Mapato yamepokelewa',
        body: `Mradi "${p.name}" ulipokea mapato ${amt}. Allocation kwenye waterfall imetengenezwa (rule v${rule.version}).`,
        type: 'PROJECT',
        entityType: 'PROJECT',
        entityId: projectId,
      });
    }

    // Outbox fan-out for downstream integrations (transaction-aware reference;
    // dispatcher picks it up ~every minute).
    await enqueueOutbox({
      eventType: 'PROJECT_REVENUE_PROCESSED',
      aggregateId: String(projectId),
      payload: { projectId, name: p.name, amount: amt, reference: ref, allocations: allocations.filter((a) => a.amount > 0).map((a) => ({ step: a.step.key, amount: a.amount })) },
      reference: `${ref}-outbox`,
    }).catch(() => {});

    return { success: true, revenue_id: ref, amount: amt, allocations: allocations.filter((a) => a.amount > 0).map((a) => ({ step: a.step.key, amount: a.amount, pct: a.pct })) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof ValidityError) throw e;
    if (String(e.message || '').toLowerCase().includes('duplicate')) throw new ValidityError('Mapato haya tayari yamerekodiwa.', 409);
    throw e;
  } finally {
    client.release();
  }
}

async function listRevenueTransactions(projectId) {
  const r = await pool.query(
    `SELECT r.*, t.id AS txn_id FROM project_revenue r
     LEFT JOIN transactions t ON t.meta->>'unique_reference' = r.unique_reference
     WHERE r.project_id = $1 ORDER BY r.created_at DESC`,
    [projectId]
  );
  return r.rows;
}

async function listRevenueAllocations(projectId) {
  const r = await pool.query(
    `SELECT * FROM waterfall_allocation_records WHERE project_id = $1 ORDER BY created_at DESC, priority`,
    [projectId]
  );
  return r.rows;
}

// ============================================================================
// PHASE 2 — MILESTONE PROOF & EXPERT REVIEW
// ============================================================================

async function submitMilestoneProof(userId, projectId, milestoneId, { documents, notes } = {}) {
  await getOwnerOnly(projectId, userId);
  const m = await pool.query('SELECT * FROM project_milestones WHERE id = $1 AND project_id = $2', [milestoneId, projectId]);
  if (m.rows.length === 0) throw new ValidityError('Hatua hii haipatikani.', 404);
  const milestone = m.rows[0];
  if (!['IN_PROGRESS', 'REJECTED'].includes(milestone.status)) {
    throw new ValidityError(`Uthibitisho unaweza kuwasilishwa tu kwa hatua iliyo 'IN_PROGRESS'. (sasa: ${milestone.status})`);
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new ValidityError('Angalau hati moja ya uthibitisho inahitajika (documents).');
  }
  const cleanDocs = documents.map((d) => ({ type: d.type || 'PROOF', title: d.title || '', url: d.url }));
  const r = await pool.query(
    `UPDATE project_milestones
     SET status = 'REPORT_SUBMITTED', proof_documents = $3, proof_notes = $4,
         proof_submitted_by = $2, proof_submitted_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [milestoneId, userId, JSON.stringify(cleanDocs), notes || null]
  );
  await logAudit({ eventType: 'MILESTONE_PROOF_SUBMITTED', action: 'SUBMIT', entityType: 'MILESTONE', userId, entityId: milestoneId, afterData: { docs: cleanDocs.length } });
  const owner = await pool.query('SELECT owner_user_id FROM projects WHERE id = $1', [projectId]);
  return r.rows[0];
}

async function listMilestoneEvidence(projectId, milestoneId) {
  const m = await pool.query('SELECT proof_documents, proof_notes FROM project_milestones WHERE id = $1 AND project_id = $2', [milestoneId, projectId]);
  if (m.rows.length === 0) throw new ValidityError('Hatua hii haipatikani.', 404);
  return m.rows[0];
}

/**
 * Expert review of milestone proof. Governing roles only (route-guarded).
 * APPROVED moves the milestone to COMPLETED; REJECTED returns it to work.
 */
async function reviewMilestone(userId, projectId, milestoneId, { decision, comment, ai_verification } = {}) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new ValidityError('Uamuzi lazima uwe APPROVED au REJECTED.');
  const m = await pool.query('SELECT * FROM project_milestones WHERE id = $1 AND project_id = $2', [milestoneId, projectId]);
  if (m.rows.length === 0) throw new ValidityError('Hatua hii haipatikani.', 404);
  const milestone = m.rows[0];
  if (milestone.status !== 'REPORT_SUBMITTED') {
    throw new ValidityError(`Hatua lazima iwe 'REPORT_SUBMITTED' kwa ukaguzi. (sasa: ${milestone.status})`);
  }

  const nextStatus = decision === 'APPROVED' ? 'COMPLETED' : 'IN_PROGRESS';
  const r = await pool.query(
    `UPDATE project_milestones
     SET status = $3, expert_reviewer_id = $2, expert_reviewed_at = NOW(),
         expert_comment = $4, ai_verification = COALESCE($5, ai_verification), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [milestoneId, userId, nextStatus, comment || null, ai_verification ? JSON.stringify(ai_verification) : null]
  );
  await logAudit({ eventType: 'MILESTONE_EXPERT_REVIEW', action: decision, entityType: 'MILESTONE', userId, entityId: milestoneId, afterData: { comment } });

  const owner = await pool.query('SELECT owner_user_id FROM projects WHERE id = $1', [projectId]);
  if (owner.rows.length > 0) {
    await createNotification(owner.rows[0].owner_user_id, {
      title: decision === 'APPROVED' ? 'Hatua imeidhinishwa' : 'Hatua imerejeshwa',
      body: `Hatua "${milestone.name}" ime${decision === 'APPROVED' ? 'idhinishwa' : 'rejeshwa kwa marekebisho'}.`,
      type: 'PROJECT',
      entityType: 'PROJECT',
      entityId: projectId,
    });
  }
  return r.rows[0];
}

// ============================================================================
// PHASE 2 — TWO-PHASE DISBURSEMENT (SEGREGATION OF DUTIES)
// ============================================================================

async function getRequest(projectId, requestId, client = pool) {
  const r = await client.query(
    `SELECT * FROM project_disbursements WHERE id = $1 AND project_id = $2`,
    [requestId, projectId]
  );
  if (r.rows.length === 0) throw new ValidityError('Ombi la malipo halipatikani.', 404);
  return r.rows[0];
}

/**
 * Owner requests a tranche against an expert-APPROVED (COMPLETED) milestone.
 * Creates a REQUEST. No money moves at this stage.
 */
async function requestDisbursement(userId, projectId, { milestone_id, amount, unique_reference } = {}) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
  await getOwnerOnly(projectId, userId);

  const p = await getProject(projectId);
  const funded = await pool.query('SELECT 1 FROM project_investments WHERE project_id = $1 LIMIT 1', [projectId]);
  if (funded.rows.length === 0) throw new ValidityError('Mradi huu haujafadhiliwa.');

  if (!milestone_id) throw new ValidityError('Ombi la malipo lazima liwe na milestone_id.');
  const m = await pool.query('SELECT * FROM project_milestones WHERE id = $1 AND project_id = $2', [milestone_id, projectId]);
  if (m.rows.length === 0) throw new ValidityError('Hatua haipatikani.');
  const milestone = m.rows[0];
  // First release of a milestone may precede proof (expert reviews the budget
  // during the review/approve phase). Any subsequent release requires the
  // milestone to be expert-approved (COMPLETED) via proof review.
  const priorRelease = await pool.query(
    `SELECT 1 FROM project_disbursements
     WHERE project_id = $1 AND milestone_id = $2 AND status = 'RELEASED' LIMIT 1`,
    [projectId, milestone_id]
  );
  const firstRelease = priorRelease.rows.length === 0;
  if (firstRelease) {
    if (!['NOT_STARTED', 'IN_PROGRESS'].includes(milestone.status)) {
      throw new ValidityError(`Hatua iko '${milestone.status}'. Tranche ya kwanza inahitaji hatua kuwa NOT_STARTED au IN_PROGRESS.`);
    }
  } else if (milestone.status !== 'COMPLETED') {
    throw new ValidityError('Fedha za tranche zinazofuata zinatolewa tu baada ya hatua kuidhinishwa na expert (COMPLETED).');
  }
  const spent = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM project_disbursements
     WHERE project_id = $1 AND milestone_id = $2 AND status = 'RELEASED'`,
    [projectId, milestone_id]
  );
  const allowed = round2(Number(milestone.budget) - Number(spent.rows[0].s));
  if (amt > allowed) throw new ValidityError(`Kiasi kinazidi salio la bajeti ya hatua hii (${allowed}).`);

  const escrow = await pool.query('SELECT remaining_balance FROM controlled_project_accounts WHERE project_id = $1', [projectId]);
  const available = escrow.rows.length > 0 ? Number(escrow.rows[0].remaining_balance) : 0;
  if (amt > available) throw new ValidityError(`Fedha zilizopo (${available}) hazitoshi kwa ombi hili.`);

  const ref = unique_reference || generateReference('PDIS');
  const r = await pool.query(
    `INSERT INTO project_disbursements
       (project_id, milestone_id, amount, status, requested_by, unique_reference, reason)
     VALUES ($1,$2,$3,'REQUESTED',$4,$5,$6) RETURNING *`,
    [projectId, milestone_id, amt, userId, ref, 'Tranche request']
  );
  await logAudit({ eventType: 'DISBURSEMENT_REQUESTED', action: 'REQUEST', entityType: 'DISBURSEMENT', userId, entityId: r.rows[0].id, referenceId: ref, amount: amt });
  return { success: true, request_id: r.rows[0].id, status: 'REQUESTED', unique_reference: ref, amount: amt };
}

/** Expert reviews the request (REQUESTED → REVIEWED or REJECTED). */
async function reviewDisbursement(userId, projectId, requestId, { decision, comment } = {}) {
  if (!['APPROVE', 'REJECT'].includes(decision)) throw new ValidityError('decision lazima iwe APPROVE au REJECT.');
  const req = await getRequest(projectId, requestId);
  if (req.status !== 'REQUESTED') throw new ValidityError(`Ombi liko '${req.status}', haliko tayari kwa ukaguzi.`);
  if (req.requested_by === userId) throw new ValidityError('Mtu aliyewasilisha ombi hawezi kukagua ombi lake mwenyewe.');

  const r = await pool.query(
    `UPDATE project_disbursements SET status = $3, reviewed_by = $2, reviewed_at = NOW(), expert_comment = $4, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [requestId, userId, decision === 'APPROVE' ? 'REVIEWED' : 'REJECTED', comment || null]
  );
  await logAudit({ eventType: 'DISBURSEMENT_REVIEWED', action: decision, entityType: 'DISBURSEMENT', userId, entityId: requestId, afterData: { comment } });
  return r.rows[0];
}

/** Second approver authorizes a reviewed request (REVIEWED → AUTHORIZED). */
async function approveDisbursement(userId, projectId, requestId) {
  const req = await getRequest(projectId, requestId);
  if (req.status !== 'REVIEWED') throw new ValidityError(`Ombi liko '${req.status}', lazima liwe REVIEWED kabla ya kuidhinishwa.`);
  if (req.requested_by === userId) throw new ValidityError('Mtu aliyewasilisha ombi hawezi kuuidhinisha mwenyewe.');
  const r = await pool.query(
    `UPDATE project_disbursements SET status = 'AUTHORIZED', authorized_by = $2, approved_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [requestId, userId]
  );
  await logAudit({ eventType: 'DISBURSEMENT_AUTHORIZED', action: 'AUTHORIZE', entityType: 'DISBURSEMENT', userId, entityId: requestId });
  return r.rows[0];
}

async function rejectDisbursement(userId, projectId, requestId, { reason } = {}) {
  const req = await getRequest(projectId, requestId);
  if (!['REQUESTED', 'REVIEWED'].includes(req.status)) throw new ValidityError(`Ombi liko '${req.status}', haliwezi kukataliwa.`);
  if (req.requested_by === userId) throw new ValidityError('Mtu aliyewasilisha ombi hawezi kukataa ombi lake mwenyewe.');
  const r = await pool.query(
    `UPDATE project_disbursements SET status = 'REJECTED', authorized_by = $2, approved_at = NOW(), reject_reason = $3, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [requestId, userId, reason || null]
  );
  await logAudit({ eventType: 'DISBURSEMENT_REJECTED', action: 'REJECT', entityType: 'DISBURSEMENT', userId, entityId: requestId, afterData: { reason } });
  return r.rows[0];
}

/**
 * Treasury executes an AUTHORIZED request: money leaves the investment escrow
 * to the owner wallet via double-entry, escrow projection is decremented, and
 * the milestone is marked disbursed. Idempotent on unique_reference.
 */
async function executeDisbursement(userId, projectId, requestId) {
  const req = await getRequest(projectId, requestId);
  if (req.status !== 'AUTHORIZED') throw new ValidityError(`Ombi liko '${req.status}', lazima liwe AUTHORIZED kabla ya kutekelezwa.`);
  if (req.requested_by === userId) throw new ValidityError('Mtu aliyewasilisha ombi hawezi kulitekeleza mwenyewe.');
  const p = await getProject(projectId);
  const amt = Number(req.amount);
  const ref = req.unique_reference || generateReference('PDIS');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await fin.claimOperation({
      client, operationType: 'PROJECT_DISBURSEMENT_EXECUTE', reference: req.id, userId, amount: amt,
    });
    if (!claimed.claimed) throw new ValidityError('Disbursement hii tayari imetekelezwa.', 409);

    await fin.creditWallet({
      client, userId: p.owner_user_id, amount: amt, reference: ref,
      fromAccount: ACCOUNTS.INVESTMENT,
      description: `Project disbursement for milestone #${req.milestone_id}`,
    });

    await client.query(
      `UPDATE project_disbursements
       SET status = 'RELEASED', executed_by = $2, executed_at = NOW(),
           txn_id = (SELECT MAX(id) FROM transactions WHERE reference_id = $3), updated_at = NOW()
       WHERE id = $1`,
      [requestId, userId, ref]
    );
    await client.query(
      `UPDATE controlled_project_accounts
       SET remaining_balance = GREATEST(0, remaining_balance - $2),
           disbursed_total = disbursed_total + $2, updated_at = NOW()
       WHERE project_id = $1`,
      [projectId, amt]
    );
    if (req.milestone_id) {
      // First tranche release marks the milestone in-progress (work started),
      // enabling proof submission. Never regress an expert-approved milestone.
      await client.query(
        `UPDATE project_milestones
         SET status = CASE WHEN status = 'NOT_STARTED' THEN 'IN_PROGRESS' ELSE status END,
             disbursed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [req.milestone_id]
      );
    }
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1,$2,$3,0,$3,'SUCCESS','PROJECT_DISBURSEMENT',$4)`,
      [ref, p.owner_user_id, amt, JSON.stringify({ project_id: projectId, milestone_id: req.milestone_id, request_id: requestId })]
    );
    await logAudit({ eventType: 'PROJECT_DISBURSEMENT', action: 'RELEASE', entityType: 'PROJECT', userId, entityId: projectId, referenceId: ref, amount: amt, afterData: { request_id: requestId } });

    await client.query('COMMIT');

    // Transactional notification: fired only after the money moved.
    await createNotification(p.owner_user_id, {
      title: 'Fedha zimetolewa',
      body: `Tranche ya ${amt} imetolewa kwa mradi "${p.name}".`,
      type: 'PROJECT',
      entityType: 'PROJECT',
      entityId: projectId,
    });
    return { success: true, disbursement_id: ref, amount: amt, status: 'RELEASED' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof ValidityError) throw e;
    if (String(e.message || '').toLowerCase().includes('duplicate')) throw new ValidityError('Disbursement hii tayari imetekelezwa.', 409);
    throw e;
  } finally {
    client.release();
  }
}

async function listDisbursementRequests(projectId) {
  const r = await pool.query(
    `SELECT d.*, m.name AS milestone_name, u.full_name AS requested_by_name
     FROM project_disbursements d
     LEFT JOIN project_milestones m ON m.id = d.milestone_id
     LEFT JOIN users u ON u.id = d.requested_by
     WHERE d.project_id = $1 ORDER BY d.created_at DESC`,
    [projectId]
  );
  return r.rows;
}

// ============================================================================
// PROJECT DOCUMENTS
// ============================================================================

async function addProjectDocument(userId, projectId, { doc_type, title, url }) {
  await getOwnerOnly(projectId, userId);
  if (!url || !title) throw new ValidityError('title na url zinahitajika.');
  const r = await pool.query(
    `INSERT INTO project_documents (project_id, doc_type, title, url)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [projectId, doc_type || 'GENERAL', title, url]
  );
  await logAudit({ eventType: 'PROJECT_DOCUMENT_ADDED', action: 'CREATE', entityType: 'PROJECT_DOCUMENT', userId, entityId: r.rows[0].id, afterData: { project_id: projectId, doc_type } });
  return r.rows[0];
}

async function listProjectDocuments(projectId) {
  const r = await pool.query(
    'SELECT * FROM project_documents WHERE project_id = $1 ORDER BY created_at DESC', [projectId]
  );
  return r.rows;
}

async function getProjectDocument(projectId, documentId) {
  const r = await pool.query('SELECT * FROM project_documents WHERE id = $1 AND project_id = $2', [documentId, projectId]);
  if (r.rows.length === 0) throw new ValidityError('Hati haipatikani.', 404);
  return r.rows[0];
}

async function deleteProjectDocument(userId, projectId, documentId) {
  const doc = await getProjectDocument(projectId, documentId);
  await getOwnerOnly(projectId, userId);
  await pool.query('DELETE FROM project_documents WHERE id = $1', [documentId]);
  await logAudit({ eventType: 'PROJECT_DOCUMENT_DELETED', action: 'DELETE', entityType: 'PROJECT_DOCUMENT', userId, entityId: documentId, afterData: { project_id: projectId, title: doc.title } });
  return { success: true };
}

// ============================================================================
// PHASE 3: SUBMISSION QUALITY / AI SCORING / CONSULTATION FEE
// ============================================================================

const MODEL_VERSION = 'afrikoba-finance-v1';

function completeness(project) {
  const required = [
    ['name', 'name'],
    ['description', 'description'],
    ['business_plan', 'business_plan'],
    ['business_model', 'business_model'],
    ['market_analysis', 'market_analysis'],
    ['competition_analysis', 'competition_analysis'],
    ['management_team', 'management_team'],
    ['use_of_funds', 'use_of_funds'],
    ['exit_timeline', 'exit_timeline'],
    ['location', 'location'],
  ];
  const present = required.filter(([, key]) => {
    const v = project[key];
    return typeof v === 'string' && v.trim().length >= 10;
  }).length;
  return present / required.length;
}

/**
 * Deterministic, advisory-only AI scoring. Uses the submitted business plan
 * numbers (never authorizes money) and produces:
 *   - score      0-100 fundability index
 *   - risk_flags human-checkable warnings
 *   - confidence how much of the score rests on hard submitted figures
 * Append-only; every run creates a project_ai_reviews row.
 */
async function runAiReview(projectId) {
  const p = await getProject(projectId);

  const revenue = Number(p.expected_revenue) || 0;
  const costs = Number(p.expected_costs) || 0;
  const cap = Number(p.capital_required) || 0;
  const profit = Number(p.projected_profit) || Math.max(0, revenue - costs);
  const margin = revenue > 0 ? profit / revenue : 0;
  const reinvest = Number(p.reinvestment_pct) || 0;
  const reserve = Number(p.reserve_pct) || 0;
  const equity = Number(p.owner_equity_pct) || 0;
  const durationDays = Number(p.duration_days) || 1;

  const financial = Math.max(0, Math.min(30, margin * 30));
  const scale = Math.min(15, (cap / 1000000) * 3);
  const runway = Math.max(0, Math.min(15, (durationDays / 365) * 15));
  const reinvestmentSafety = reinvest >= reserve ? 5 : 0;
  const equityCommitment = equity >= 20 ? 5 : equity >= 10 ? 3 : 0;
  const quality = completeness(p) * 20;
  const planCoverage = [p.business_plan, p.business_model, p.market_analysis].filter(
    (x) => typeof x === 'string' && x.trim().length >= 40
  ).length;

  const rawScore = financial + scale + runway + reinvestmentSafety + equityCommitment + quality + planCoverage * 5;
  const score = round2(Math.min(100, rawScore));

  const riskFlags = [];
  if (revenue <= 0) riskFlags.push('Hakuna makadirio ya mapato');
  if (costs <= 0) riskFlags.push('Hakuna makadirio ya gharama');
  if (margin < 0.15) riskFlags.push('Pembe ya faida iko chini ya 15%');
  if (cap <= 0) riskFlags.push('Hakuna mtaji uliotajwa');
  if (reserve < 10) riskFlags.push('Akiba ya waterfall iko chini ya 10%');
  if (reinvest < reserve) riskFlags.push('Reinvestment ni chini ya akiba ya reserve');
  if (equity < 10) riskFlags.push('Mchango wa mwenyewe ni chini ya 10%');
  if (durationDays < 30) riskFlags.push('Muda wa mradi ni mfupi sana');
  if (margin > 0.6) riskFlags.push('Pembe ya faida ni juu isivyo kawaida (verify)');
  if (completeness(p) < 0.6) riskFlags.push('Fomu ya usajili haijakamilika');

  const confidence =
    revenue > 0 && costs > 0 && cap > 0 && planCoverage >= 2
      ? round2(Math.min(0.95, financial / 30 + 0.3))
      : round2(Math.max(0.3, quality / 20 + 0.15));

  const recommendedAction = score >= 75 ? 'PRIORITIZE_REVIEW' : score >= 50 ? 'REVIEW' : 'ADVISE_IMPROVEMENTS';

  const insert = await pool.query(
    `INSERT INTO project_ai_reviews
       (project_id, score, risk_flags, confidence, model_version, financial_health, submission_quality, recommended_action)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7::jsonb, $8)
     RETURNING *`,
    [
      projectId,
      score,
      JSON.stringify(riskFlags),
      confidence,
      MODEL_VERSION,
      JSON.stringify({ margin, revenue, costs, profit, reinvest, reserve, equity, durationDays }),
      JSON.stringify({ completeness: completeness(p), business_plan: !!p.business_plan, market_analysis: !!p.market_analysis }),
      recommendedAction,
    ]
  );

  await pool.query(
    `UPDATE projects SET ai_score = $1, ai_review_count = ai_review_count + 1, updated_at = NOW() WHERE id = $2`,
    [score, projectId]
  );

  await logAudit({ eventType: 'AI_REVIEW_RUN', action: 'CREATE', entityType: 'PROJECT_AI_REVIEW', entityId: insert.rows[0].id, afterData: { project_id: projectId, score, risk_flags: riskFlags.length, recommended_action: recommendedAction } });

  return {
    advisory_only: true,
    final_authority: 'EXPERT_TEAM',
    model_version: MODEL_VERSION,
    review: insert.rows[0],
  };
}

/** Latest AI review for display (no new run). */
async function getAiReview(projectId) {
  const r = await pool.query(
    'SELECT * FROM project_ai_reviews WHERE project_id = $1 ORDER BY id DESC LIMIT 1',
    [projectId]
  );
  if (r.rows.length === 0) return { project_id: projectId, review: null };
  return { project_id: projectId, advisory_only: true, final_authority: 'EXPERT_TEAM', review: r.rows[0] };
}

/**
 * Idempotent consultation-fee payment. Debits the owner wallet and books the
 * fee into PROJECT_CONSULTATION_FEE. If a transaction with the same reference
 * already exists, the saved consultation is returned (no double charge).
 */
async function payConsultationFee(projectId, userId, uniqueReference) {
  const p = await getProject(projectId);
  if (Number(p.owner_user_id) !== Number(userId)) {
    throw new ValidityError('Unaweza kulipa consultation fee kwa mradi wako tu.', 403);
  }
  if (p.consultation_paid_at) return { already_paid: true, amount: Number(p.consultation_fee), paid_at: p.consultation_paid_at };

  const fee = Number(p.consultation_fee) > 0 ? Number(p.consultation_fee) : 0;
  if (fee <= 0) throw new ValidityError('Consultation fee kwa mradi huu haijawekwa.', 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await fin.claimOperation({
      client,
      operationType: 'PROJECT_CONSULTATION',
      reference: uniqueReference,
      userId,
      amount: fee,
    });
    if (!claim) {
      const existing = await client.query(
        `SELECT * FROM project_consultations WHERE unique_reference = $1 ORDER BY id DESC LIMIT 1`,
        [uniqueReference]
      );
      await client.query('COMMIT');
      return { already_paid: true, consultation: existing.rows[0] };
    }

    await fin.debitWallet({
      client,
      userId,
      amount: fee,
      reference: `${uniqueReference}-wallet`,
      toAccount: 'PROJECT_CONSULTATION_FEE',
      description: `Consultation fee - ${p.name}`,
      productType: 'PROJECT',
      productRef: String(projectId),
    });

    const inserted = await client.query(
      `INSERT INTO project_consultations (project_id, owner_user_id, amount, unique_reference)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [projectId, userId, fee, uniqueReference]
    );
    await client.query(
      `UPDATE projects SET consultation_paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [projectId]
    );
    await client.query('COMMIT');

    await logAudit({ eventType: 'CONSULTATION_FEE_PAID', action: 'CREATE', entityType: 'PROJECT_CONSULTATION', userId, entityId: inserted.rows[0].id, afterData: { project_id: projectId, amount: fee, reference: uniqueReference } });

    return { already_paid: false, consultation: inserted.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listConsultations(projectId) {
  const r = await pool.query(
    `SELECT * FROM project_consultations WHERE project_id = $1 ORDER BY id DESC`,
    [projectId]
  );
  return r.rows;
}

/**
 * Expert review queue: projects awaiting expert review joined with their latest
 * AI score and consultation-fee status. Experts remain the final authority.
 */
async function listProjectsForReview() {
  const r = await pool.query(
    `SELECT p.id, p.name, p.category, p.location, p.status, p.capital_required,
            p.consultation_fee, p.consultation_paid_at, p.ai_score, p.ai_review_count,
            p.owner_user_id, u.full_name AS owner_name,
            a.score AS ai_latest_score, a.recommended_action, a.risk_flags, a.model_version,
            COUNT(c.id) AS consultation_count, MAX(c.paid_at) AS consultation_paid
     FROM projects p
     JOIN users u ON u.id = p.owner_user_id
     LEFT JOIN project_ai_reviews a ON a.id = (
       SELECT id FROM project_ai_reviews WHERE project_id = p.id ORDER BY id DESC LIMIT 1)
     LEFT JOIN project_consultations c ON c.project_id = p.id AND c.status = 'PAID'
     WHERE p.status IN ('SUBMITTED','INITIAL_REVIEW','DUE_DILIGENCE','RISK_ASSESSMENT','GOVERNANCE_REVIEW')
     GROUP BY p.id, u.full_name, a.score, a.recommended_action, a.risk_flags, a.model_version
     ORDER BY p.updated_at DESC`
  );
  return r.rows;
}

async function getAuditTrail(projectId) {
  const [approvals, disbursements, waterfall, revenue, postings] = await Promise.all([
    pool.query('SELECT * FROM project_approvals WHERE project_id = $1 ORDER BY created_at DESC', [projectId]),
    pool.query('SELECT * FROM project_disbursements WHERE project_id = $1 ORDER BY created_at DESC', [projectId]),
    pool.query('SELECT * FROM waterfall_allocation_records WHERE project_id = $1 ORDER BY created_at DESC', [projectId]),
    pool.query('SELECT * FROM project_revenue WHERE project_id = $1 ORDER BY created_at DESC', [projectId]),
    pool.query(
      `SELECT j.*, la.account_code FROM journal_entries j
       JOIN ledger_accounts la ON la.id = j.account_id
       WHERE j.product_type = 'PROJECT' AND j.product_ref = $1
       ORDER BY j.posted_at DESC LIMIT 200`,
      [String(projectId)]
    ),
  ]);
  return {
    approvals: approvals.rows,
    disbursements: disbursements.rows,
    waterfall_allocations: waterfall.rows,
    revenue: revenue.rows,
    ledger_postings: postings.rows,
  };
}

// ============================================================================
// PHASE 4 — TRANSPARENCY & NOTIFICATIONS
// Per-investor dividend entitlements, expert-authorized payouts, and a
// ledger-verified transparency picture for owner / experts / investors.
// ============================================================================

async function listDividendPayouts(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isAuthorizedView = p.owner_user_id === userId || isExpert(role);
  const values = isAuthorizedView
    ? [projectId]
    : [projectId, userId];
  const where = isAuthorizedView
    ? 'project_id = $1'
    : 'project_id = $1 AND investor_user_id = $2';
  const r = await pool.query(
    `SELECT id, project_id, investor_user_id, entitlement, payout_reference,
            status, paid_at, payout_setting_reference, created_at
     FROM project_investor_payouts
     WHERE ${where}
     ORDER BY id DESC LIMIT 500`,
    values
  );
  return { project: { id: p.id, name: p.name }, payouts: r.rows, authorized_view: isAuthorizedView };
}

async function payProjectDividends({ projectId, actorUserId, actorRole }) {
  if (!isExpert(actorRole)) {
    throw new ValidityError('Huna mamlaka ya kufanya malipo ya mgawanyo.', 403);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await getProject(projectId, client);

    const pendingRes = await client.query(
      `SELECT investor_user_id, SUM(entitlement)::numeric AS total_entitlement, COUNT(*)::int AS row_count
       FROM project_investor_payouts
       WHERE project_id = $1 AND status = 'PENDING'
       GROUP BY investor_user_id ORDER BY investor_user_id`,
      [projectId]
    );
    const pending = pendingRes.rows;
    if (pending.length === 0) {
      await client.query('COMMIT');
      return { paid: [], total: 0, already_paid: true };
    }

    const txnRef = `${generateReference('PROJECT_DIVIDEND_PAYOUT')}-${projectId}`;
    const paid = [];
    for (const row of pending) {
      const amt = Number(row.total_entitlement);
      if (amt <= 0) continue;
      const res = await fin.creditWallet({
        client,
        userId: row.investor_user_id,
        amount: amt,
        reference: `${txnRef}-u${row.investor_user_id}`,
        fromAccount: ACCOUNTS.DIVIDEND,
        description: `Dividend payout - ${p.name}`,
        productType: 'PROJECT',
        productRef: String(projectId),
      });
      if (res.dedup) continue;
      await client.query(
        `UPDATE project_investor_payouts SET status = 'PAID', paid_at = NOW(), payout_setting_reference = $1
         WHERE project_id = $2 AND investor_user_id = $3 AND status = 'PENDING'`,
        [txnRef, projectId, row.investor_user_id]
      );
      paid.push({ investor_user_id: row.investor_user_id, amount: amt });
    }

    await client.query('COMMIT');

    await logAudit({
      eventType: 'PROJECT_DIVIDEND_PAID', action: 'CREATE', entityType: 'PROJECT',
      userId: actorUserId, entityId: projectId, referenceId: txnRef,
      afterData: { reference: txnRef, paid: paid.map((x) => ({ investor_user_id: x.investor_user_id, amount: x.amount })) },
      client,
    });

    // Transactional notifications: fired only after COMMIT succeeded.
    for (const { investor_user_id, amount } of paid) {
      await createNotification(investor_user_id, {
        title: 'Mgawanyo wa faida umelipwa',
        body: `Mgawanyo wako wa mradi "${p.name}" umewekwa kwenye wallet yako: TZS ${amount}.`,
        type: 'PROJECT',
        entityType: 'PROJECT',
        entityId: projectId,
      });
    }
    await enqueueOutbox({
      eventType: 'PROJECT_DIVIDEND_PAID',
      aggregateId: String(projectId),
      payload: { projectId, name: p.name, reference: txnRef, paid },
      reference: `${txnRef}-outbox`,
    }).catch(() => {});

    return { paid, total: round2(paid.reduce((s, x) => s + Number(x.amount), 0)), already_paid: paid.length === 0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Investor transparency: how much each fundraiser reported vs what the ledger
 * actually moved, drawn purely from journal_entries (source of truth).
 */
async function getProjectTransparency(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  const invRes = await pool.query(
    `SELECT 1 FROM project_investments WHERE project_id = $1 AND investor_user_id = $2 AND status = 'CONFIRMED' LIMIT 1`,
    [projectId, userId]
  );
  const isInvestor = invRes.rows.length > 0;
  if (!isOwner && !isInvestor && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya taarifa za uwazi za mradi huu.', 403);
  }

  const [raisedRes, escrowRes, disbursedRes, revenueRes, dividendRes,
        waterfallRes, myPosition, eventsRes, myPayoutRes] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS investors
       FROM project_investments WHERE project_id = $1 AND status = 'CONFIRMED'`, [projectId]),
    pool.query(
      `SELECT remaining_balance AS balance FROM controlled_project_accounts WHERE project_id = $1 LIMIT 1`, [projectId]),
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS count
       FROM project_disbursements WHERE project_id = $1 AND status = 'RELEASED'`, [projectId]),
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS count
       FROM project_revenue WHERE project_id = $1`, [projectId]),
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS count
       FROM waterfall_allocation_records WHERE project_id = $1 AND allocation_step = 'DIVIDEND'`, [projectId]),
    pool.query(
      `SELECT allocation_step, COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS count
       FROM waterfall_allocation_records WHERE project_id = $1
       GROUP BY allocation_step ORDER BY MIN(id)`, [projectId]),
    pool.query(
      `SELECT amount, participation_pct, agreement_version, created_at
       FROM project_investments WHERE project_id = $1 AND investor_user_id = $2 AND status = 'CONFIRMED'
       ORDER BY id DESC LIMIT 1`, [projectId, userId]),
    pool.query(
      `SELECT action, meta, entity_type, created_at FROM audit_logs
       WHERE entity_type = 'PROJECT' AND entity_id = $1
       ORDER BY created_at DESC LIMIT 25`, [String(projectId)]),
    pool.query(
      `SELECT COALESCE(SUM(entitlement),0)::numeric AS pending,
              COALESCE((SELECT SUM(entitlement)::numeric FROM project_investor_payouts
                        WHERE project_id = $1 AND investor_user_id = $2 AND status = 'PAID'),0) AS paid
       FROM project_investor_payouts
       WHERE project_id = $1 AND investor_user_id = $2 AND status = 'PENDING'`, [projectId, userId]),
  ]);

  const canSeeAll = isOwner || isExpert(role);
  let allPayouts = [];
  if (canSeeAll) {
    const r = await pool.query(
      `SELECT investor_user_id, SUM(entitlement)::numeric AS pending_total, COUNT(*)::int AS pending_count
       FROM project_investor_payouts WHERE project_id = $1 AND status = 'PENDING'
       GROUP BY investor_user_id ORDER BY investor_user_id`, [projectId]);
    allPayouts = r.rows;
  }

  return {
    project: {
      id: p.id, name: p.name, category: p.category, location: p.location,
      status: p.status, capital_required: p.capital_required,
      amount_raised: raisedRes.rows[0].total, investor_count: raisedRes.rows[0].investors,
      currency_code: p.currency_code || 'TZS',
    },
    roles: { owner: isOwner, investor: isInvestor, expert: isExpert(role), authorized_view: canSeeAll },
    funds: {
      raised: raisedRes.rows[0].total,
      escrow_balance: escrowRes.rows[0] ? escrowRes.rows[0].balance : 0,
      disbursed_total: disbursedRes.rows[0].total,
      revenue_total: revenueRes.rows[0].total,
      dividend_allocated_total: dividendRes.rows[0].total,
    },
    waterfall_by_step: waterfallRes.rows,
    my_position: myPosition.rows.length > 0
      ? { invested: myPosition.rows[0].amount, participation_pct: myPosition.rows[0].participation_pct,
          pending_payout: myPayoutRes.rows[0].pending, paid_payout: myPayoutRes.rows[0].paid }
      : null,
    all_pending_payouts: canSeeAll ? allPayouts : undefined,
    recent_events: eventsRes.rows,
  };
}

/**
 * The "investor dashboard": every confirmed investment of the user with the
 * project's fundraising picture and the user's own dividend outcomes.
 */
async function getMyTransparency(userId) {
  const r = await pool.query(
    `SELECT i.id AS investment_id, i.project_id, p.name, p.status, p.category,
            p.capital_required, p.amount_raised, 'TZS' AS currency_code,
            i.amount AS invested_amount, i.participation_pct, i.created_at AS invested_at,
            COALESCE(pp.total_pending, 0)::numeric AS pending_payout_total,
            COALESCE(pa.total_paid, 0)::numeric AS paid_payout_total
     FROM project_investments i
     JOIN projects p ON p.id = i.project_id
     LEFT JOIN (SELECT project_id, SUM(entitlement)::numeric AS total_pending
                FROM project_investor_payouts
                WHERE investor_user_id = $1 AND status = 'PENDING' GROUP BY project_id) pp
            ON pp.project_id = i.project_id
     LEFT JOIN (SELECT project_id, SUM(entitlement)::numeric AS total_paid
                FROM project_investor_payouts
                WHERE investor_user_id = $1 AND status = 'PAID' GROUP BY project_id) pa
            ON pa.project_id = i.project_id
     WHERE i.investor_user_id = $1 AND i.status = 'CONFIRMED'
     ORDER BY i.id DESC`,
    [userId]
  );
  return r.rows;
}

// ============================================================================
// PHASE 6 — LIFECYCLE COMPLETION & FINAL SETTLEMENT
// If the project is ACTIVE and the owner/expert closes it, the remaining
// escrow (residual PROJECT_INVESTMENT_ACCOUNT, minus anything already
// disbursed) is returned pro-rata to confirmed investors via double-entry.
// The settlement snapshot is stored append-only; books are sealed by setting
// the controlled account CLOSED and the project COMPLETED.
// ============================================================================

async function completeProject({ projectId, actorUserId, actorRole }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === actorUserId;
  if (!isOwner && !isExpert(actorRole)) {
    throw new ValidityError('Huna mamlaka ya kukamilisha mradi huu.', 403);
  }
  if (p.status !== 'ACTIVE') throw new ValidityError(`Mradi lazima uwe ACTIVE kwa kukamilika. (sasa: ${p.status})`);

  const existing = await pool.query('SELECT 1 FROM project_settlements WHERE project_id = $1', [projectId]);
  if (existing.rows.length > 0) {
    const s = await pool.query('SELECT * FROM project_settlements WHERE project_id = $1', [projectId]);
    return { success: true, already_completed: true, settlement: s.rows[0] };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invRes = await client.query(
      `SELECT investor_user_id, amount, participation_pct
       FROM project_investments WHERE project_id = $1 AND status = 'CONFIRMED'
       ORDER BY id ASC`,
      [projectId]
    );
    const investors = invRes.rows;
    const totalRaised = round2(investors.reduce((s, i) => s + Number(i.amount), 0));

    const escrowRes = await client.query(
      `SELECT remaining_balance FROM controlled_project_accounts WHERE project_id = $1 AND status <> 'CLOSED' LIMIT 1`,
      [projectId]
    );
    const escrow = escrowRes.rows.length > 0 ? Number(escrowRes.rows[0].remaining_balance || 0) : 0;
    // Control total so retained items never exceed escrow.
    const reserveRes = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM project_reserves WHERE project_id = $1`,
      [projectId]
    );
    const reserveTotal = Number(reserveRes.rows[0].total || 0);

    const settleRef = `SETTLE-${projectId}-${Date.now()}`;
    const invDistribution = [];
    let returnedToInvestors = 0;
    let ownerShare = 0;

    if (escrow > 0 && investors.length > 0) {
      // Pro-rata return by participation (weight), last investor absorbs rounding.
      let committed = 0;
      for (let k = 0; k < investors.length; k++) {
        const inv = investors[k];
        const share = (inv.participation_pct == null || Number(inv.participation_pct) <= 0)
          ? (totalRaised > 0 ? Number(inv.amount) / totalRaised : 0)
          : Number(inv.participation_pct) / 100;
        let amt;
        if (k === investors.length - 1) amt = round2(escrow - committed);
        else amt = round2(escrow * Math.min(Math.max(share, 0), 1));
        if (amt <= 0) { committed = round2(committed + 0); continue; }
        const res = await fin.creditWallet({
          client,
          userId: inv.investor_user_id,
          amount: amt,
          reference: `${settleRef}-u${inv.investor_user_id}`,
          fromAccount: ACCOUNTS.INVESTMENT,
          description: 'Project completion settlement - escrow return',
          productType: 'PROJECT',
          productRef: String(projectId),
        });
        if (res.dedup) { committed = round2(committed + amt); continue; }
        await client.query(
          `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
           VALUES ($1,$2,$3,0,$3,'SUCCESS','PROJECT_SETTLEMENT',$4)`,
          [`${settleRef}-u${inv.investor_user_id}`, inv.investor_user_id, amt,
           JSON.stringify({ project_id: projectId, reason: 'escrow_return' })]
        );
        committed = round2(committed + amt);
        returnedToInvestors = round2(returnedToInvestors + amt);
        invDistribution.push({ investor_user_id: inv.investor_user_id, amount: amt });
      }
      // Guard against any drift: return residue to owner (should be 0 in practice).
      // ownerShare remains 0 here because escrow is fully returned to investors.
    } else if (escrow > 0) {
      const res = await fin.creditWallet({
        client,
        userId: p.owner_user_id,
        amount: escrow,
        reference: `${settleRef}-ow`,
        fromAccount: ACCOUNTS.INVESTMENT,
        description: 'Project completion settlement - owner residual escrow',
        productType: 'PROJECT',
        productRef: String(projectId),
      });
      if (!res.dedup) {
        ownerShare = escrow;
        await client.query(
          `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
           VALUES ($1,$2,$3,0,$3,'SUCCESS','PROJECT_SETTLEMENT',$4)`,
          [`${settleRef}-ow`, p.owner_user_id, escrow, JSON.stringify({ project_id: projectId, reason: 'owner_residual' })]
        );
      }
    }

    const revRes = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM project_revenue WHERE project_id = $1`,
      [projectId]
    );
    const divRes = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM waterfall_allocation_records
       WHERE project_id = $1 AND allocation_step = 'DIVIDEND'`, [projectId]
    );
    const divPendingRes = await client.query(
      `SELECT COALESCE(SUM(entitlement),0)::numeric AS total FROM project_investor_payouts
       WHERE project_id = $1 AND status = 'PENDING'`, [projectId]
    );
    const milRes = await client.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS done
       FROM project_milestones WHERE project_id = $1`, [projectId]
    );

    await client.query(
      `UPDATE controlled_project_accounts
       SET remaining_balance = 0, status = 'CLOSED', updated_at = NOW()
       WHERE project_id = $1 AND status <> 'CLOSED'`,
      [projectId]
    );

    await client.query(
      `INSERT INTO project_settlements
         (project_id, invested_total, escrow_balance, returned_to_investors, owner_received,
          reserve_released, revenue_total, dividend_allocated, dividend_pending,
          milestone_total, milestone_completed, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [projectId, totalRaised, escrow, returnedToInvestors, ownerShare,
       reserveTotal, Number(revRes.rows[0].total || 0), Number(divRes.rows[0].total || 0),
       Number(divPendingRes.rows[0].total || 0), milRes.rows[0].total, milRes.rows[0].done,
       JSON.stringify({
         reference: settleRef,
         returned_to_investors: invDistribution,
         owner_received: ownerShare,
       }), actorUserId]
    );

    const upd = await client.query(
      `UPDATE projects SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [projectId]
    );

    await logAudit({
      eventType: 'PROJECT_COMPLETED', action: 'COMPLETE', entityType: 'PROJECT',
      userId: actorUserId, entityId: projectId, referenceId: settleRef,
      afterData: { returned_to_investors: returnedToInvestors, owner_received: ownerShare, escrow },
      client,
    });

    await client.query('COMMIT');

    // Transactional notifications after COMMIT.
    await createNotification(p.owner_user_id, {
      title: 'Mradi umekamilika',
      body: `Mradi "${p.name}" umekamilika. Escrow iliyobaki (TZS ${escrow}) imerejeshwa kwa wawekezaji (TZS ${returnedToInvestors}).`,
      type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
    });
    for (const d of invDistribution) {
      await createNotification(d.investor_user_id, {
        title: 'Mradi umekamilika - malipo ya kurejesha',
        body: `Mradi "${p.name}" umekamilika. Umepewa TZS ${d.amount} kwenye wallet yako (escrow return).`,
        type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
      });
    }
    await enqueueOutbox({
      eventType: 'PROJECT_COMPLETED',
      aggregateId: String(projectId),
      payload: { projectId, name: p.name, reference: settleRef, returned_to_investors: returnedToInvestors, owner_received: ownerShare },
      reference: `${settleRef}-outbox`,
    }).catch(() => {});

    return { success: true, project: upd.rows[0], settlement: { invested_total: totalRaised, escrow_balance: escrow, returned_to_investors: returnedToInvestors, owner_received: ownerShare, reserve_released: reserveTotal } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e.message || '').toLowerCase().includes('duplicate key')) {
      const s = await pool.query('SELECT * FROM project_settlements WHERE project_id = $1', [projectId]);
      if (s.rows.length > 0) return { success: true, already_completed: true, settlement: s.rows[0] };
    }
    throw e;
  } finally {
    client.release();
  }
}

async function getSettlementReport(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  const invRes = await pool.query(
    `SELECT 1 FROM project_investments WHERE project_id = $1 AND investor_user_id = $2 AND status IN ('CONFIRMED','REFUNDED') LIMIT 1`,
    [projectId, userId]
  );
  const isInvestor = invRes.rows.length > 0;
  if (!isOwner && !isInvestor && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya ripoti ya ukomo wa mradi huu.', 403);
  }
  const s = await pool.query('SELECT * FROM project_settlements WHERE project_id = $1', [projectId]);
  if (s.rows.length === 0) {
    return { project: { id: p.id, name: p.name, status: p.status }, settlement: null, completed: false };
  }
  const settlement = s.rows[0];
  const milestones = await pool.query(
    `SELECT phase, name, status FROM project_milestones WHERE project_id = $1 ORDER BY id`, [projectId]
  );
  const payouts = await pool.query(
    `SELECT investor_user_id, entitlement, status, paid_at FROM project_investor_payouts
     WHERE project_id = $1 AND status IN ('PENDING','PAID') ORDER BY id`, [projectId]
  );
  return {
    project: { id: p.id, name: p.name, status: p.status, completed_at: p.completed_at },
    completed: true,
    settlement,
    milestones: milestones.rows,
    payouts: payouts.rows,
  };
}

/**
 * Investor performance: per-investment realized ROI from paid dividends/payouts
 * plus refunds, with outstanding (pending) dividends flagged separately.
 */
async function getMyPerformance(userId) {
  const r = await pool.query(
    `SELECT i.id AS investment_id, i.investor_user_id, i.project_id, p.name, p.status AS project_status,
            p.capital_required, p.amount_raised, i.amount AS invested,
            i.participation_pct, i.status AS investment_status,
            i.refund_reference, i.refunded_at, i.created_at AS invested_at,
            COALESCE(pp.total_pending, 0)::numeric AS pending_total,
            COALESCE(pa.total_paid, 0)::numeric AS paid_total,
            (s.id IS NOT NULL) AS completed, (l.id IS NOT NULL) AS liquidated,
            s.summary AS settlement_summary
     FROM project_investments i
     JOIN projects p ON p.id = i.project_id
     LEFT JOIN project_settlements s ON s.project_id = i.project_id
     LEFT JOIN project_liquidations l ON l.project_id = i.project_id
     LEFT JOIN (SELECT project_id, SUM(entitlement)::numeric AS total_pending
                FROM project_investor_payouts
                WHERE investor_user_id = $1 AND status = 'PENDING' GROUP BY project_id) pp
            ON pp.project_id = i.project_id
     LEFT JOIN (SELECT project_id, SUM(entitlement)::numeric AS total_paid
                FROM project_investor_payouts
                WHERE investor_user_id = $1 AND status = 'PAID' GROUP BY project_id) pa
            ON pa.project_id = i.project_id
     WHERE i.investor_user_id = $1
     ORDER BY i.id DESC`,
    [userId]
  );

  const returnedFor = (summary, investorUserId) => {
    if (!summary || !Array.isArray(summary.returned_to_investors)) return 0;
    const row = summary.returned_to_investors.find((x) => Number(x.investor_user_id) === Number(investorUserId));
    return row ? Number(row.amount || 0) : 0;
  };

  const rows = r.rows.map((x) => {
    const invested = Number(x.invested || 0);
    const paid = Number(x.paid_total || 0);
    const refunded = x.refunded_at ? invested : 0;
    const escrowReturn = returnedFor(x.settlement_summary, x.investor_user_id);
    const received = round2(paid + refunded + escrowReturn);
    const roi = invested > 0 ? round2(((received - invested) / invested) * 100) : 0;
    const percent_funded = (x.capital_required && Number(x.capital_required) > 0)
      ? round2((Number(x.amount_raised) / Number(x.capital_required)) * 100) : 0;
    return {
      ...x,
      invested: round2(invested),
      escrow_return: round2(escrowReturn),
      received: round2(received),
      pending_total: round2(Number(x.pending_total || 0)),
      paid_total: round2(paid),
      refunded_amount: round2(refunded),
      completed: !!x.completed,
      liquidated: !!x.liquidated,
      roi_percent: roi,
      percent_funded,
      settlement_summary: undefined,
    };
  });
  const totals = rows.reduce((acc, x) => {
    acc.invested = round2(acc.invested + x.invested);
    acc.received = round2(acc.received + x.received);
    acc.escrow_return = round2(acc.escrow_return + x.escrow_return);
    acc.pending = round2(acc.pending + Number(x.pending_total || 0));
    return acc;
  }, { invested: 0, received: 0, escrow_return: 0, pending: 0 });
  totals.roi_percent = totals.invested > 0 ? round2(((totals.received - totals.invested) / totals.invested) * 100) : 0;
  return { totals, investments: rows };
}

async function exportMyPerformanceCsv(userId) {
  const perf = await getMyPerformance(userId);
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return `"${s.replace(/"/g, '""')}"`; };
  const L = ['Investment,Project,Status,Invested,Participation %,Escrow returned,Dividends paid,Refunded,Received,ROI %,Completed,Liquidated'];
  for (const i of perf.investments) {
    L.push([
      i.investment_id, esc(i.name), i.investment_status, i.invested,
      i.participation_pct, i.escrow_return, i.paid_total, i.refunded_amount,
      i.received, `${i.roi_percent}%`, i.completed ? 'yes' : 'no', i.liquidated ? 'yes' : 'no',
    ].join(','));
  }
  L.push('');
  L.push(`Totals,Invested=${perf.totals.invested},Received=${perf.totals.received},Pending=${perf.totals.pending},ROI=${perf.totals.roi_percent}%`);
  return L.join('\n');
}

// ============================================================================
// PHASE 12 — PROJECT LEDGER: AUTHORIZED TRANSACTION-LEVEL AUDIT TRAIL
// Exposes the append-only getAuditTrail provenance (approvals, disbursements,
// revenue, waterfall allocations, ledger postings) to stakeholders only:
// project owner / experts / participating (confirmed or refunded) investors.
// ============================================================================

async function getProjectLedger(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  const invRes = await pool.query(
    `SELECT 1 FROM project_investments WHERE project_id = $1 AND investor_user_id = $2 AND status IN ('CONFIRMED','REFUNDED') LIMIT 1`,
    [projectId, userId]
  );
  const isInvestor = invRes.rows.length > 0;
  if (!isOwner && !isInvestor && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya ledger ya mradi huu.', 403);
  }

  const trail = await getAuditTrail(projectId);
  const postings = Array.isArray(trail.ledger_postings) ? trail.ledger_postings : [];
  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status, owner_user_id: p.owner_user_id },
    approvals: trail.approvals || [],
    disbursements: trail.disbursements || [],
    revenue: trail.revenue || [],
    waterfall_allocations: trail.waterfall_allocations || [],
    ledger_postings: postings.map((e) => ({
      id: e.id, account_code: e.account_code, debit: e.debit, credit: e.credit,
      reference: e.reference_id || e.reference, description: e.description, posted_at: e.posted_at,
    })),
  };
}

// ============================================================================
// PHASE 13 — SCHEDULED DRAWDOWN PLAN (TRANCHE CASH MANAGEMENT)
// A commitment layer over the governed disbursement chain: the owner defines a
// plan (total + tranches: amount, milestone, purpose), then requests tranches
// in sequence. Each request materialises a project_disbursements REQUEST that
// still travels expert review -> approve -> execute with segregation of duties.
// No money moves here; release is reconciled against executed disbursements.
// ============================================================================

// ============================================================================
// PHASE 16 — PLATFORM-WIDE PROJECT-FINANCE OPERATIONS BOOK
// Ops/compliance seat across ALL projects: aggregates every append-only PF
// domain (investments, escrow, disbursements, reserve/residual releases,
// dividends, settlements, revenue, liquidations) plus an escrow-integrity
// check. The invariant: invested ≈ escrow_held + disbursed + escrow_returned
// (refunds already decrement the escrow row, so they cancel out). Any drift
// over TZS 1 is surfaced as a flag. Read-only; owner/investor data stays scoped out.
// ============================================================================

async function getPlatformPfeBook({ userId, role }) {
  if (!isExpert(role)) {
    throw new ValidityError('Huna mamlaka ya daftari la uendeshaji la fedha za miradi.', 403);
  }

  const totalRes = await pool.query(`
    SELECT
      (SELECT COALESCE(SUM(amount),0) FROM project_investments WHERE status='CONFIRMED') AS invested_confirmed,
      (SELECT COALESCE(SUM(amount),0) FROM project_investments WHERE status='REFUNDED') AS refunded,
      (SELECT COALESCE(SUM(remaining_balance),0) FROM controlled_project_accounts) AS escrow_held,
      (SELECT COALESCE(SUM(amount),0) FROM project_disbursements WHERE status='RELEASED') AS disbursed,
      (SELECT COALESCE(SUM(amount),0) FROM project_reserve_releases WHERE status='RELEASED' AND reserve_type='DISTRIBUTION_RESERVE') AS reserve_released,
      (SELECT COALESCE(SUM(amount),0) FROM project_reserve_releases WHERE status='RELEASED' AND reserve_type='OWNER_RESIDUAL') AS residual_released,
      (SELECT COALESCE(SUM(entitlement),0) FROM project_investor_payouts WHERE status='PAID') AS dividends_paid,
      (SELECT COALESCE(SUM(entitlement),0) FROM project_investor_payouts WHERE status='PENDING') AS dividends_pending,
      (SELECT COALESCE(SUM(returned_to_investors),0) FROM project_settlements) AS escrow_returned,
      (SELECT COALESCE(SUM(amount),0) FROM project_revenue) AS revenue_total,
      (SELECT COALESCE(SUM(investor_net),0) FROM project_liquidations) AS liquidation_investor_net
  `);

  const statusRes = await pool.query(`
    SELECT p.status, COUNT(*)::int AS cnt, COALESCE(SUM(pi.invested),0) AS invested
    FROM projects p
    LEFT JOIN (SELECT project_id, SUM(amount) AS invested FROM project_investments WHERE status='CONFIRMED' GROUP BY project_id) pi ON pi.project_id = p.id
    GROUP BY p.status ORDER BY p.status
  `);

  const waterfallRes = await pool.query(`
    SELECT allocation_step, COUNT(*)::int AS runs, SUM(amount)::numeric AS total
    FROM waterfall_allocation_records GROUP BY allocation_step ORDER BY allocation_step
  `);

  const projRes = await pool.query(`
    SELECT
      p.id, p.name, p.status, p.completed_at, p.capital_required, p.amount_raised,
      u.full_name AS owner_name, u.phone_number AS owner_phone,
      COALESCE(pi.invested,0) AS invested, COALESCE(pi.refunded,0) AS refunded,
      COALESCE(cpa.remaining_balance,0) AS escrow_held,
      COALESCE(pd.disbursed,0) AS disbursed,
      COALESCE(prr.reserve,0) AS reserve_released, COALESCE(prr.resid,0) AS residual_released,
      COALESCE(pay.paid,0) AS dividends_paid,
      COALESCE(s.escrow_returned,0) AS escrow_returned,
      COALESCE(liq.liquidated,0) AS liquidated, liq.liq_ref
    FROM projects p
    JOIN users u ON u.id = p.owner_user_id
    LEFT JOIN (SELECT project_id, SUM(amount) FILTER (WHERE status='CONFIRMED') AS invested,
                      SUM(amount) FILTER (WHERE status='REFUNDED') AS refunded
               FROM project_investments GROUP BY project_id) pi ON pi.project_id = p.id
    LEFT JOIN controlled_project_accounts cpa ON cpa.project_id = p.id
    LEFT JOIN (SELECT project_id, SUM(amount) AS disbursed FROM project_disbursements WHERE status='RELEASED' GROUP BY project_id) pd ON pd.project_id = p.id
    LEFT JOIN (SELECT project_id,
                      SUM(amount) FILTER (WHERE reserve_type='DISTRIBUTION_RESERVE') AS reserve,
                      SUM(amount) FILTER (WHERE reserve_type='OWNER_RESIDUAL') AS resid
               FROM project_reserve_releases WHERE status='RELEASED' GROUP BY project_id) prr ON prr.project_id = p.id
    LEFT JOIN (SELECT project_id, SUM(entitlement) FILTER (WHERE status='PAID') AS paid
               FROM project_investor_payouts GROUP BY project_id) pay ON pay.project_id = p.id
    LEFT JOIN (SELECT project_id, returned_to_investors AS escrow_returned FROM project_settlements
               UNION ALL SELECT projects.id AS project_id, 0 FROM projects WHERE NOT EXISTS (SELECT 1 FROM project_settlements s2 WHERE s2.project_id = projects.id)) s ON s.project_id = p.id
    LEFT JOIN (SELECT project_id, COUNT(*) FILTER (WHERE status='LIQUIDATED') AS liquidated,
                      MAX(CASE WHEN status='LIQUIDATED' THEN reference END) AS liq_ref
               FROM project_liquidations GROUP BY project_id) liq ON liq.project_id = p.id
    ORDER BY p.id
  `);

  const flags = [];
  const projects = [];
  for (const x of projRes.rows) {
    const breakdown = {
      escrow_held: Number(x.escrow_held || 0),
      disbursed: Number(x.disbursed || 0),
      reserve_released: Number(x.reserve_released || 0),
      residual_released: Number(x.residual_released || 0),
      escrow_returned: Number(x.escrow_returned || 0),
    };
    // Investor-capital escrow invariant. Reserve / residual / dividends come
    // from the REVENUE profit pools (waterfall allocations), never from the
    // investor escrow, so they are intentionally NOT part of this check.
    // Refunds already decremented the escrow row, so the refunded amount is
    // reflected in escrow_held and cancels out of the reconciliation.
    const variance = round2(
      Number(x.invested || 0)
      - (breakdown.escrow_held + breakdown.disbursed + breakdown.escrow_returned)
    );
    const flagged = Math.abs(variance) > 1;
    if (flagged) flags.push({ project_id: x.id, name: x.name, variance });
    projects.push({
      project_id: x.id, name: x.name, status: x.status, completed_at: x.completed_at,
      owner: { full_name: x.owner_name, phone_number: x.owner_phone },
      capital_required: Number(x.capital_required), amount_raised: Number(x.amount_raised),
      invested: round2(Number(x.invested || 0)), refunded: round2(Number(x.refunded || 0)),
      ...breakdown,
      dividends_paid: round2(Number(x.dividends_paid || 0)),
      liquidated: Number(x.liquidated || 0) > 0,
      liquidation_reference: x.liq_ref || null,
      integrity_variance: variance, integrity_ok: !flagged,
    });
  }

  const totals = totalRes.rows[0];
  const invested = Number(totals.invested_confirmed || 0);
  const out = Number(totals.disbursed || 0) + Number(totals.escrow_returned || 0);
  const platformVariance = round2(invested
    - (Number(totals.escrow_held || 0) + out));

  return {
    success: true,
    generated_at: new Date().toISOString(),
    totals: {
      invested: round2(invested),
      refunded: round2(Number(totals.refunded || 0)),
      escrow_held: round2(Number(totals.escrow_held || 0)),
      disbursed: round2(Number(totals.disbursed || 0)),
      reserve_released: round2(Number(totals.reserve_released || 0)),
      residual_released: round2(Number(totals.residual_released || 0)),
      escrow_returned: round2(Number(totals.escrow_returned || 0)),
      dividends_paid: round2(Number(totals.dividends_paid || 0)),
      dividends_pending: round2(Number(totals.dividends_pending || 0)),
      revenue_total: round2(Number(totals.revenue_total || 0)),
      liquidation_investor_net: round2(Number(totals.liquidation_investor_net || 0)),
    },
    platform_variance: platformVariance,
    by_status: statusRes.rows.map((r) => ({ status: r.status, projects: r.cnt, invested: round2(Number(r.invested)) })),
    waterfall: waterfallRes.rows.map((r) => ({ step: r.allocation_step, runs: r.runs, total: round2(Number(r.total)) })),
    projects,
    flags,
    counts: {
      projects: projRes.rows.length,
      open: projRes.rows.filter((x) => ['FUNDING', 'ACTIVE', 'PUBLISHED'].includes(x.status)).length,
      liquidated: projRes.rows.filter((x) => Number(x.liquidated || 0) > 0).length,
      integrity_flags: flags.length,
    },
  };
}

async function exportPlatformPfeBookCsv({ userId, role }) {
  const r = await getPlatformPfeBook({ userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push(`Platform variance (TZS),${r.platform_variance}`);
  L.push(`Integrity flags,${r.counts.integrity_flags}`);
  L.push('');
  L.push('Metric,Amount');
  const t = r.totals;
  L.push(`Invested confirmed,${t.invested}`);
  L.push(`Refunded,${t.refunded}`);
  L.push(`Escrow held,${t.escrow_held}`);
  L.push(`Disbursed to owner,${t.disbursed}`);
  L.push(`Reserve released,${t.reserve_released}`);
  L.push(`Residual released,${t.residual_released}`);
  L.push(`Escrow returned,${t.escrow_returned}`);
  L.push(`Dividends paid,${t.dividends_paid}`);
  L.push(`Dividends pending,${t.dividends_pending}`);
  L.push(`Revenue processed,${t.revenue_total}`);
  L.push(`Liquidation investor net,${t.liquidation_investor_net}`);
  L.push('');
  L.push('Status,#Projects,Invested');
  for (const s of r.by_status) L.push(`${esc(s.status)},${s.projects},${s.invested}`);
  L.push('');
  L.push('Waterfall step,Runs,Total');
  for (const w of r.waterfall) L.push(`${esc(w.step)},${w.runs},${w.total}`);
  L.push('');
  L.push('ProjectId,Name,Status,Owner,Invested,Refunded,EscrowHeld,Disbursed,ReserveReleased,ResidualReleased,EscrowReturned,DividendsPaid,Variance,IntegrityOK,Liquidated');
  for (const p of r.projects) {
    L.push(`${p.project_id},${esc(p.name)},${esc(p.status)},${esc(p.owner.full_name || p.owner.phone_number)},${p.invested},${p.refunded},${p.escrow_held},${p.disbursed},${p.reserve_released},${p.residual_released},${p.escrow_returned},${p.dividends_paid},${p.integrity_variance},${p.integrity_ok ? 'yes' : 'no'},${p.liquidated ? 'yes' : 'no'}`);
  }
  return L.join('\n');
}

// ============================================================================
// PHASE 17 — FUNDING CAP ENFORCEMENT + ADMIN FORCE-CLOSE + INVESTOR STATEMENT
// ============================================================================

async function forceCloseFunding(userId, role, projectId, { action } = {}) {
  if (!isExpert(role)) throw new ValidityError('Huna mamlaka ya kufunga ufadhili.', 403);
  if (!['ACTIVATE', 'REFUND'].includes(action)) throw new ValidityError('Kitendo hakijatambuliwa.');

  const pRes = await pool.query(
    'SELECT id, name, status, capital_required, amount_raised, owner_user_id FROM projects WHERE id = $1', [projectId]
  );
  if (pRes.rows.length === 0) throw new ValidityError('Mradi haupatikani.', 404);
  const p = pRes.rows[0];

  if (action === 'ACTIVATE') {
    if (p.status !== 'FUNDING') throw new ValidityError('Amilisha nguvu inaruhusu mradi wa FUNDING tu.');
    const pct = p.capital_required > 0
      ? (Number(p.amount_raised) / Number(p.capital_required)) * 100 : 0;
    if (pct < 50) throw new ValidityError(`Ufadhili ni ${Math.round(pct)}% tu; lazima uwe ≥ 50% kuanzisha mradi (hali: ACTIVE).`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE projects SET status='ACTIVE', updated_at = NOW() WHERE id = $1", [projectId]);
      await client.query(
        `UPDATE controlled_project_accounts
           SET status = 'ACTIVE', is_locked = TRUE,
               funding_target = (SELECT capital_required FROM projects WHERE id = $1),
               escrow_balance = remaining_balance, updated_at = NOW()
         WHERE project_id = $1`, [projectId]
      );
      await client.query(
        `INSERT INTO audit_log (event_type, action, entity_type, entity_id, user_id, reference_id, after_data)
         VALUES ('FORCE_CLOSE','ACTIVATE','PROJECT',$1,$2,NULL,$3)`,
        [projectId, userId, JSON.stringify({ funded_pct: Math.round(pct) })]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    createNotification(p.owner_user_id, {
      title: 'Mradi umefunguliwa kwa nguvu',
      body: `Mradi "${p.name}" umewashwa kuwa ACTIVE na meneja wa jukwaa.`,
      type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
    }).catch(() => {});

    return { success: true, status: 'ACTIVE', funded_pct: Math.round(pct) };
  }

  // REFUND action
  if (!['FUNDING', 'PUBLISHED', 'EXPIRED'].includes(p.status)) {
    throw new ValidityError('Urefu wa urejeshaji unaruhusu hali ya FUNDING/PUBLISHED/EXPIRED tu.');
  }

  const invRes = await pool.query(
    "SELECT id, investor_user_id, amount FROM project_investments WHERE project_id = $1 AND status = 'CONFIRMED'", [projectId]
  );
  if (invRes.rows.length === 0) throw new ValidityError('Hakuna uwekezaji uliothibitishwa kurejeshwa.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const inv of invRes.rows) {
      const amt = Number(inv.amount);
      const ref = generateReference('PREF');
      await client.query(
        "UPDATE project_investments SET refund_reference = $1, refunded_at = NOW(), status = 'REFUNDED' WHERE id = $2",
        [ref, inv.id]
      );
      await client.query('UPDATE projects SET amount_raised = GREATEST(amount_raised - $1, 0) WHERE id = $2', [amt, projectId]);
      await client.query(
        `UPDATE controlled_project_accounts SET remaining_balance = GREATEST(remaining_balance - $1, 0), updated_at = NOW()
         WHERE project_id = $2`, [amt, projectId]
      );
      await fin.creditWallet({ client, userId: inv.investor_user_id, amount: amt, reference: ref, fromAccount: INVESTMENT_ACCOUNT, description: 'Funding cancelled refund' });
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1,$2,$3,0,$3,'SUCCESS','PROJECT_REFUND',$4)`,
        [ref, inv.investor_user_id, amt, JSON.stringify({ project_id: projectId, investment_id: inv.id, refund_reference: ref })]
      );
      createNotification(inv.investor_user_id, {
        title: 'Uwekezaji umerudishwa',
        body: `Uwekezaji wako TZS ${amt.toLocaleString('en-US')} katika mradi umerejeshwa kwa kufuta ufadhili. Rejea: ${ref}`,
        type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
      }).catch(() => {});
    }

    await client.query("UPDATE projects SET status = 'CANCELLED', amount_raised = 0, updated_at = NOW() WHERE id = $1", [projectId]);
    await client.query("UPDATE controlled_project_accounts SET remaining_balance = 0, status = 'CLOSED', updated_at = NOW() WHERE project_id = $1", [projectId]);
    await client.query(
      `INSERT INTO audit_log (event_type, action, entity_type, entity_id, user_id, reference_id, after_data)
       VALUES ('FORCE_CLOSE','REFUND_CANCEL','PROJECT',$1,$2,NULL,$3)`,
      [projectId, userId, JSON.stringify({ refunded_count: invRes.rows.length })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return { success: true, status: 'CANCELLED', refunded_count: invRes.rows.length };
}

async function getInvestorStatement({ userId, role }, projectId) {
  const p = await getProject(projectId);
  const currencyCode = p.currency_code || 'TZS';

  const invRes = await pool.query(
    `SELECT * FROM project_investments WHERE project_id = $1 AND investor_user_id = $2 AND status IN ('CONFIRMED','REFUNDED')`,
    [projectId, userId]
  );
  const isInvestor = invRes.rows.length > 0;
  const isOwner = Number(p.owner_user_id) === Number(userId);
  if (!isInvestor && !isOwner && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya kuona taarifa hii.', 403);
  }

  const payoutRes = await pool.query(
    'SELECT * FROM project_investor_payouts WHERE project_id = $1 AND investor_user_id = $2 ORDER BY created_at',
    [projectId, userId]
  );
  const paidRows = payoutRes.rows.filter((r) => r.status === 'PAID');
  const pendingRows = payoutRes.rows.filter((r) => r.status === 'PENDING');
  const paidTotal = paidRows.reduce((a, r) => a + Number(r.entitlement || 0), 0);
  const pendingTotal = pendingRows.reduce((a, r) => a + Number(r.entitlement || 0), 0);

  const stRes = await pool.query('SELECT summary FROM project_settlements WHERE project_id = $1', [projectId]);
  const summary = stRes.rows[0]?.summary || {};
  const escrowReturned = (() => {
    if (!Array.isArray(summary.returned_to_investors)) return 0;
    const row = summary.returned_to_investors.find((x) => Number(x.investor_user_id) === Number(userId));
    return row ? Number(row.amount || 0) : 0;
  })();

  const ruleRes = await pool.query(
    `SELECT ${RULE_COLUMNS.join(', ')}
       FROM waterfall_allocation_rules WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
    [projectId]
  );
  const waterfallConfig = ruleRes.rows[0]
    ? Object.fromEntries(WATERFALL_STEPS.map((s) => [s.key, Number(ruleRes.rows[0][s.column] || 0)]))
    : {};

  const invested = invRes.rows.filter((r) => r.status === 'CONFIRMED')
    .reduce((a, r) => a + Number(r.amount || 0), 0);
  const refunded = invRes.rows.filter((r) => r.status === 'REFUNDED')
    .reduce((a, r) => a + Number(r.amount || 0), 0);
  const realized = round2(paidTotal + refunded + escrowReturned - invested);

  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status, currency_code: currencyCode, capital_required: Number(p.capital_required) },
    my_investments: invRes.rows.map((r) => ({
      investment_id: r.id, amount: Number(r.amount), participation_pct: Number(r.participation_pct),
      status: r.status, refund_reference: r.refund_reference, created_at: r.created_at,
    })),
    dividends: {
      paid_total: paidTotal,
      pending_total: pendingTotal,
      rows: payoutRes.rows.map((r) => ({
        id: r.id, entitlement: Number(r.entitlement), status: r.status,
        reference: r.payout_reference, paid_at: r.paid_at, created_at: r.created_at,
      })),
    },
    escrow_returned: escrowReturned,
    realized,
    waterfall_config: waterfallConfig,
  };
}

function exportInvestorStatementCsv({ userId, role }, projectId) {
  return getInvestorStatement({ userId, role }, projectId).then((s) => {
    const esc = (v) => { const str = v === null || v === undefined ? '' : String(v); return `"${str.replace(/"/g, '""')}"`; };
    const L = [];
    L.push('Investor Statement');
    L.push(`Project,${esc(s.project.name)},${s.project.status},${s.project.currency_code}`);
    L.push('');
    L.push('InvestmentId,Amount,Participation%,Status,RefundRef,CreatedAt');
    for (const i of s.my_investments) {
      L.push(`${i.investment_id},${i.amount},${i.participation_pct},${i.status},${i.refund_reference || ''},${i.created_at}`);
    }
    L.push('');
    L.push(`TotalInvested,${s.my_investments.filter((i) => i.status === 'CONFIRMED').reduce((a, i) => a + i.amount, 0)}`);
    L.push(`TotalRefunded,${s.my_investments.filter((i) => i.status === 'REFUNDED').reduce((a, i) => a + i.amount, 0)}`);
    L.push('');
    L.push('PayoutId,Entitlement,Status,Reference,PaidAt,CreatedAt');
    for (const d of s.dividends.rows) {
      L.push(`${d.id},${d.entitlement},${d.status},${d.reference},${d.paid_at || ''},${d.created_at}`);
    }
    L.push('');
    L.push(`DividendsPaid,${s.dividends.paid_total}`);
    L.push(`DividendsPending,${s.dividends.pending_total}`);
    L.push(`EscrowReturned,${s.escrow_returned}`);
    L.push(`RealizedNet,${s.realized}`);
    return L.join('\n');
  });
}

async function createDrawdownPlan(userId, projectId, { total_amount, tranches = [] } = {}) {
  await getOwnerOnly(projectId, userId);
  const p = await getProject(projectId);
  if (p.status !== 'ACTIVE') throw new ValidityError('Ratiba ya drawdown inatakiwa kwa mradi wa ACTIVE tu.');

  const total = round2(Number(total_amount));
  if (!total || total <= 0) throw new ValidityError('Kiasi si sahihi.');
  if (!Array.isArray(tranches) || tranches.length === 0) throw new ValidityError('Tranche zinahitajika.');

  const escrow = await pool.query('SELECT remaining_balance FROM controlled_project_accounts WHERE project_id = $1', [projectId]);
  const available = escrow.rows.length > 0 ? Number(escrow.rows[0].remaining_balance) : 0;
  if (total > available + 0.0001) throw new ValidityError(`Kiasi kinazidi escrow iliyopo (${available}).`);

  let sum = 0;
  const rows = tranches.map((t, i) => {
    const amt = round2(Number(t.amount));
    if (!amt || amt <= 0) throw new ValidityError(`Kiasi cha tranche ${i + 1} si sahihi.`);
    sum = round2(sum + amt);
    return { amount: amt, milestone_id: t.milestone_id || null, purpose: t.purpose || null, sequence: i + 1 };
  });
  if (sum !== total) throw new ValidityError('Jumla ya tranche hailingani na kiasi cha jumla.');

  const withMilestones = rows.filter((x) => x.milestone_id);
  if (withMilestones.length) {
    const m = await pool.query(
      'SELECT id FROM project_milestones WHERE project_id = $1 AND id = ANY($2::int[])',
      [projectId, withMilestones.map((x) => x.milestone_id)]
    );
    if (m.rows.length !== withMilestones.length) throw new ValidityError('Hatua (milestone) imo wapi? Haiwezi kupatikana.');
  }

  const existing = await pool.query('SELECT id FROM project_drawdown_plans WHERE project_id = $1', [projectId]);
  if (existing.rows.length) throw new ValidityError('Ratiba ya drawdown tayari ipo kwa mradi huu.', 409);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plan = await client.query(
      `INSERT INTO project_drawdown_plans (project_id, total_amount, created_by)
       VALUES ($1,$2,$3) RETURNING *`,
      [projectId, total, userId]
    );
    for (const t of rows) {
      await client.query(
        `INSERT INTO project_drawdowns (project_id, plan_id, sequence, amount, milestone_id, purpose, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [projectId, plan.rows[0].id, t.sequence, t.amount, t.milestone_id, t.purpose, userId]
      );
    }
    await logAudit({ client, eventType: 'DRAWDOWN_PLAN_CREATED', action: 'CREATE', entityType: 'DRAWDOWN_PLAN', userId, entityId: projectId, amount: total, afterData: { tranches: rows.length } });
    await client.query('COMMIT');
    return { success: true, plan_id: plan.rows[0].id, total_amount: total, tranches: rows.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Governed plan editing (Phase 15). The owner may adjust the AMOUNT / PURPOSE
 * of tranches that are still SCHEDULED (released / requested / skipped ones are
 * immutable). The plan total is recomputed as the sum of ALL tranches, so money
 * already released stays fixed, and the new lifetime total may never exceed
 * escrow remaining + released (money is only ever taken out of escrow once).
 * All changes are audit-logged; money still moves only through the governed
 * request -> review -> approve -> execute chain.
 */
async function updateDrawdownPlan(userId, projectId, { tranches = [], total_amount } = {}) {
  await getOwnerOnly(projectId, userId);
  const p = await getProject(projectId);
  if (p.status !== 'ACTIVE') throw new ValidityError('Ratiba ya drawdown inaweza kuhaririwa kwa mradi wa ACTIVE tu.');

  const planRes = await pool.query('SELECT * FROM project_drawdown_plans WHERE project_id = $1', [projectId]);
  const plan = planRes.rows[0];
  if (!plan) throw new ValidityError('Hakuna ratiba ya drawdown.', 404);
  if (plan.status !== 'ACTIVE') throw new ValidityError(`Ratiba iko '${plan.status}', haiwezi kuhaririwa.`);
  if (!Array.isArray(tranches) || tranches.length === 0) throw new ValidityError('Tranche zinahitajika kwa sasisho.');

  const all = (await pool.query(
    'SELECT * FROM project_drawdowns WHERE plan_id = $1 AND project_id = $2 ORDER BY sequence',
    [plan.id, projectId]
  )).rows;
  if (all.length === 0) throw new ValidityError('Ratiba haina tranche.');

  const byId = new Map(all.map((t) => [t.id, t]));
  const edits = new Map();
  for (const e of tranches) {
    const tid = Number(e.id);
    const cur = byId.get(tid);
    if (!cur) throw new ValidityError(`Tranche ${tid} haipatikani.`);
    if (cur.status !== 'SCHEDULED') throw new ValidityError(`Tranche ${tid} iko '${cur.status}', haiwezi kuhaririwa.`);
    const amt = e.amount === undefined || e.amount === null || e.amount === '' ? round2(Number(cur.amount)) : round2(Number(e.amount));
    if (!amt || amt <= 0) throw new ValidityError('Kiasi si sahihi.');
    edits.set(tid, {
      amount: amt,
      purpose: e.purpose === undefined ? (cur.purpose || null) : (e.purpose || null),
    });
  }

  let total = 0;
  for (const t of all) {
    const e = edits.get(t.id);
    total = round2(total + (e ? e.amount : Number(t.amount)));
  }
  if (total_amount !== undefined && total_amount !== null && total_amount !== '') {
    const want = round2(Number(total_amount));
    if (want !== total) throw new ValidityError('Jumla iliyotumwa hailingani na hesabu ya tranche.');
  }

  const escrow = await pool.query('SELECT remaining_balance FROM controlled_project_accounts WHERE project_id = $1', [projectId]);
  const available = escrow.rows.length > 0 ? Number(escrow.rows[0].remaining_balance) : 0;
  const releasedTotal = all.filter((t) => t.status === 'RELEASED').reduce((s, t) => s + Number(t.amount), 0);
  const lifetime = round2(available + releasedTotal);
  if (total > lifetime + 0.0001) {
    throw new ValidityError(`Kiasi kinazidi escrow iliyopo (${available}) baada ya malipo yaliyotolewa.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [tid, e] of edits) {
      await client.query(
        `UPDATE project_drawdowns SET amount = $1, purpose = $2
         WHERE id = $3 AND plan_id = $4 AND project_id = $5`,
        [e.amount, e.purpose, tid, plan.id, projectId]
      );
    }
    await client.query(
      'UPDATE project_drawdown_plans SET total_amount = $1 WHERE id = $2',
      [total, plan.id]
    );
    await logAudit({
      client, eventType: 'DRAWDOWN_PLAN_UPDATED', action: 'UPDATE', entityType: 'DRAWDOWN_PLAN',
      userId, entityId: projectId, amount: total,
      afterData: { edited_tranches: [...edits.keys()], total_tranches: all.length },
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return listDrawdowns(projectId, { userId, role: 'OWNER' });
}

/** Reconcile requested tranches against the governed disbursement state. */
async function syncDrawdowns(projectId) {
  await pool.query(
    `UPDATE project_drawdowns d
     SET status = 'RELEASED', released_at = COALESCE(d.released_at, pd.executed_at)
     FROM project_disbursements pd
     WHERE pd.unique_reference = d.disbursement_reference AND pd.status = 'RELEASED'
       AND d.status = 'REQUESTED' AND d.project_id = $1`,
    [projectId]
  );
  await pool.query(
    `UPDATE project_drawdowns d
     SET status = 'SCHEDULED', disbursement_reference = NULL, requested_by = NULL, requested_at = NULL
     FROM project_disbursements pd
     WHERE pd.unique_reference = d.disbursement_reference AND pd.status = 'REJECTED'
       AND d.status = 'REQUESTED' AND d.project_id = $1`,
    [projectId]
  );
  await pool.query(
    `UPDATE project_drawdown_plans sp SET status = 'COMPLETED'
     FROM (SELECT plan_id
           FROM project_drawdowns
           WHERE project_id = $1
           GROUP BY plan_id
           HAVING COUNT(*) FILTER (WHERE status NOT IN ('RELEASED','SKIPPED')) = 0) done
     WHERE sp.id = done.plan_id AND sp.status = 'ACTIVE'`,
    [projectId]
  );
}

async function listDrawdowns(projectId, { userId, role }) {
  const p = await getProject(projectId);
  if (p.owner_user_id !== userId && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya ratiba ya drawdown ya mradi huu.', 403);
  }
  await syncDrawdowns(projectId);
  const planRes = await pool.query('SELECT * FROM project_drawdown_plans WHERE project_id = $1', [projectId]);
  const plan = planRes.rows[0] || null;
  const tranches = plan
    ? (await pool.query('SELECT * FROM project_drawdowns WHERE plan_id = $1 AND project_id = $2 ORDER BY sequence', [plan.id, projectId])).rows
    : [];
  const released = tranches.filter((t) => t.status === 'RELEASED').reduce((s, t) => s + Number(t.amount), 0);
  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status },
    plan,
    tranches: tranches.map((t) => ({ ...t, amount: Number(t.amount) })),
    progress: {
      released_total: round2(released),
      pending_total: round2((plan ? Number(plan.total_amount) : 0) - released),
    },
  };
}

async function requestTranche(userId, projectId, trancheId) {
  await getOwnerOnly(projectId, userId);
  const p = await getProject(projectId);
  if (p.status !== 'ACTIVE') throw new ValidityError('Drawdown inaweza kuombwa tu kwa mradi wa ACTIVE.');

  const t = await pool.query('SELECT * FROM project_drawdowns WHERE id = $1 AND project_id = $2', [trancheId, projectId]);
  if (t.rows.length === 0) throw new ValidityError('Tranche haipatikani.');
  const tr = t.rows[0];
  if (tr.status !== 'SCHEDULED') throw new ValidityError(`Tranche iko '${tr.status}', haiwezi kuombwa.`);

  const prior = await pool.query(
    `SELECT 1 FROM project_drawdowns
     WHERE project_id = $1 AND plan_id = $2 AND sequence < $3 AND status NOT IN ('RELEASED','SKIPPED') LIMIT 1`,
    [projectId, tr.plan_id, tr.sequence]
  );
  if (prior.rows.length) throw new ValidityError('Tranche zilizotangulia hazijatolewa bado.');

  if (!tr.milestone_id) throw new ValidityError('Tranche hii haina milestone; ongeza milestone_id kabla ya kuomba.');

  const ref = `TRN-${projectId}-${tr.id}-${Date.now()}`;
  const req = await requestDisbursement(userId, projectId, { milestone_id: tr.milestone_id, amount: Number(tr.amount), unique_reference: ref });
  await pool.query(
    `UPDATE project_drawdowns SET status = 'REQUESTED', disbursement_reference = $1, requested_by = $2, requested_at = NOW() WHERE id = $3`,
    [ref, userId, trancheId]
  );
  await logAudit({ eventType: 'DRAWDOWN_REQUESTED', action: 'REQUEST', entityType: 'DRAWDOWN', userId, entityId: trancheId, referenceId: ref, amount: Number(tr.amount) });
  return { success: true, tranche_id: trancheId, status: 'REQUESTED', disbursement_request: req };
}

// ============================================================================
// PHASE 7/8 — CLOSE-OUT: FUND RELEASE + CLOSE-OUT REPORT
// After a project reaches COMPLETED (Phase 6), the accrued waterfall payout
// funds are released to the project owner via double-entry (DR <project
// sub-account> / CR CUSTOMER_WALLET), following the same convention as Phase 4
// dividend payouts. Each release is recorded append-only and idempotent.
// ============================================================================

const CLOSE_OUT_FUNDS = {
  RESERVE: {
    step: 'RESERVE',
    account: ACCOUNTS.RESERVE,
    reserveType: 'DISTRIBUTION_RESERVE',
    fundLabel: 'akiba',
    txType: 'PROJECT_RESERVE_RELEASE',
    eventType: 'PROJECT_RESERVE_RELEASED',
    description: 'Project close-out reserve release',
    title: 'Akiba ya mradi imetolewa',
    body: (name, amount) => `Akiba ya mradi "${name}" (TZS ${amount}) imetolewa kwako kwenye wallet yako.`,
  },
  OWNER_RESIDUAL: {
    step: 'OWNER_RESIDUAL',
    account: ACCOUNTS.OWNER_RESIDUAL,
    reserveType: 'OWNER_RESIDUAL',
    fundLabel: 'faida iliyosalia',
    txType: 'PROJECT_RESIDUAL_RELEASE',
    eventType: 'PROJECT_RESIDUAL_RELEASED',
    description: 'Project close-out owner residual release',
    title: 'Faida ya mradi (residual) imetolewa',
    body: (name, amount) => `Faida iliyosalia ya mradi "${name}" (TZS ${amount}) imetolewa kwako kwenye wallet yako.`,
  },
};

async function getAccruedCloseOutTotal(projectId, step, client = pool) {
  const r = await client.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS total
     FROM waterfall_allocation_records
     WHERE project_id = $1 AND allocation_step = $2`,
    [projectId, step]
  );
  return Number(r.rows[0].total || 0);
}

async function getReleasedCloseOutTotal(projectId, reserveType, client = pool) {
  const r = await client.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS total
     FROM project_reserve_releases WHERE project_id = $1 AND reserve_type = $2 AND status = 'RELEASED'`,
    [projectId, reserveType]
  );
  return Number(r.rows[0].total || 0);
}

/**
 * Release the remaining accrued close-out fund (RESERVE or OWNER_RESIDUAL) to
 * the project owner. Idempotent: once fully released, further calls return a
 * no-op (already_released) instead of moving money again.
 */
/**
 * Best-effort lifecycle notification to every confirmed investor of a project
 * (used for close-out fund releases and liquidation). Never throws: money
 * movement must not roll back because a notification write failed.
 */
async function notifyProjectInvestors(projectId, { title, body }) {
  try {
    const r = await pool.query(
      `SELECT DISTINCT investor_user_id FROM project_investments
       WHERE project_id = $1 AND status = 'CONFIRMED'`,
      [projectId]
    );
    for (const row of r.rows) {
      await createNotification(row.investor_user_id, {
        title, body, type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
      });
    }
  } catch (e) {
    // best-effort; notifications are not financial operations.
  }
}

async function releaseCloseOutFund({ projectId, actorUserId, actorRole, fundType }) {
  const meta = CLOSE_OUT_FUNDS[fundType];
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === actorUserId;
  if (!isOwner && !isExpert(actorRole)) {
    throw new ValidityError('Huna mamlaka ya kutoa fedha za ukomo wa mradi huu.', 403);
  }
  if (p.status !== 'COMPLETED') throw new ValidityError(`Fedha za ukomo hutolewa baada ya mradi kuwa COMPLETED. (sasa: ${p.status})`);

  const settlementRes = await pool.query('SELECT * FROM project_settlements WHERE project_id = $1', [projectId]);
  if (settlementRes.rows.length === 0) throw new ValidityError('Hakuna settlement ya mradi huu.', 409);

  const accrued = await getAccruedCloseOutTotal(projectId, meta.step);
  const released = await getReleasedCloseOutTotal(projectId, meta.reserveType);
  const amount = round2(accrued - released);
  if (amount <= 0.01) {
    return {
      success: true, already_released: true,
      project_id: projectId, fund: fundType, accrued, released: Math.min(accrued, released), amount: 0,
    };
  }

  const ref = `${fundType === 'RESERVE' ? 'RESVA' : 'RESID'}-${projectId}-${Date.now()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // creditWallet owns the idempotency claim (financial_operations UNIQUE on
    // reference_id) and performs the double-entry release.
    await fin.creditWallet({
      client, userId: p.owner_user_id, amount, reference: `${ref}-ow`,
      fromAccount: meta.account,
      description: meta.description,
      productType: 'PROJECT', productRef: String(projectId),
    });

    await client.query(
      `INSERT INTO project_reserve_releases
         (project_id, settlement_id, reserve_type, amount, released_to, reference, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'RELEASED',$7)`,
      [projectId, settlementRes.rows[0].id, meta.reserveType, amount, p.owner_user_id, ref, actorUserId]
    );
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1,$2,$3,0,$3,'SUCCESS',$4,$5)`,
      [`${ref}-ow`, p.owner_user_id, amount, meta.txType, JSON.stringify({ project_id: projectId, reference: ref, fund: fundType, reason: 'close_out' })]
    );

    await logAudit({
      eventType: meta.eventType, action: 'RELEASE', entityType: 'PROJECT',
      userId: actorUserId, entityId: projectId, referenceId: ref,
      afterData: { fund: fundType, amount, accrued, released_before: released, released_to: p.owner_user_id },
      // Run inside the same transaction: creditWallet holds a FOR UPDATE lock
      // on the owner's wallet row, so an audit FK-check from another connection
      // (users(id)) would block/abort on the conflicting FOR KEY SHARE.
      client,
    });

    await client.query('COMMIT');

    await createNotification(p.owner_user_id, {
      title: meta.title,
      body: meta.body(p.name, amount),
      type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
    });
    await notifyProjectInvestors(projectId, {
      title: meta.title,
      body: `Fedha za ${meta.fundLabel} za mradi "${p.name}" zimetolewa. Kiasi: TZS ${Number(amount).toLocaleString('en-US')}.`,
    });
    await enqueueOutbox({
      eventType: meta.eventType,
      aggregateId: String(projectId),
      payload: { projectId, name: p.name, fund: fundType, amount, reference: ref },
      reference: `${ref}-outbox`,
    }).catch(() => {});

    return { success: true, project_id: projectId, fund: fundType, amount, reference: ref, accrued, released_now: amount };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e.message || '').toLowerCase().includes('duplicate key')) {
      const s = await pool.query(
        'SELECT * FROM project_reserve_releases WHERE project_id = $1 AND reserve_type = $2',
        [projectId, meta.reserveType]
      );
      if (s.rows.length > 0) {
        return { success: true, already_released: true, project_id: projectId, fund: fundType, amount: Number(s.rows[0].amount) };
      }
    }
    throw e;
  } finally {
    client.release();
  }
}

async function releaseOwnerReserve({ projectId, actorUserId, actorRole }) {
  return releaseCloseOutFund({ projectId, actorUserId, actorRole, fundType: 'RESERVE' });
}

async function releaseOwnerResidual({ projectId, actorUserId, actorRole }) {
  return releaseCloseOutFund({ projectId, actorUserId, actorRole, fundType: 'OWNER_RESIDUAL' });
}

/**
 * Close-out report for a COMPLETED project. Realized cash in/out for the owner
 * and each investor, waterfall break-out, dividends, and milestone status.
 */
async function getCloseOutReport(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  const invRes = await pool.query(
    `SELECT 1 FROM project_investments WHERE project_id = $1 AND investor_user_id = $2 AND status IN ('CONFIRMED','REFUNDED') LIMIT 1`,
    [projectId, userId]
  );
  const isInvestor = invRes.rows.length > 0;
  if (!isOwner && !isInvestor && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya ripoti ya kufunga mradi huu.', 403);
  }

  const s = await pool.query('SELECT * FROM project_settlements WHERE project_id = $1', [projectId]);
  const settlement = s.rows[0] || null;

  const disbursed = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM project_disbursements WHERE project_id = $1 AND status = 'RELEASED'`,
    [projectId]
  );
  const reserveRel = await pool.query(
    `SELECT reserve_type, COALESCE(SUM(amount),0)::numeric AS total
     FROM project_reserve_releases WHERE project_id = $1 AND status = 'RELEASED'
     GROUP BY reserve_type`,
    [projectId]
  );
  const releasedByType = {};
  let reserveTotal = 0;
  let residualTotal = 0;
  for (const row of reserveRel.rows) {
    releasedByType[row.reserve_type] = Number(row.total || 0);
    if (row.reserve_type === 'DISTRIBUTION_RESERVE') reserveTotal = Number(row.total || 0);
    if (row.reserve_type === 'OWNER_RESIDUAL') residualTotal = Number(row.total || 0);
  }
  const divPaid = await pool.query(
    `SELECT COALESCE(SUM(entitlement),0)::numeric AS total FROM project_investor_payouts WHERE project_id = $1 AND status = 'PAID'`,
    [projectId]
  );
  const divPending = await pool.query(
    `SELECT COALESCE(SUM(entitlement),0)::numeric AS total FROM project_investor_payouts WHERE project_id = $1 AND status = 'PENDING'`,
    [projectId]
  );
  const waterfall = await pool.query(
    `SELECT allocation_step, COUNT(*)::int AS runs, SUM(amount)::numeric AS total
     FROM waterfall_allocation_records WHERE project_id = $1 GROUP BY allocation_step ORDER BY allocation_step`,
    [projectId]
  );
  const milestones = await pool.query(
    `SELECT phase, name, status, budget FROM project_milestones WHERE project_id = $1 ORDER BY id`,
    [projectId]
  );
  const investors = await pool.query(
    `SELECT i.investor_user_id, u.full_name, u.phone_number, i.amount AS invested, i.participation_pct,
            i.status AS investment_status, i.refund_reference,
            COALESCE(pa.paid,0)::numeric AS dividends_paid,
            COALESCE(pn.pending,0)::numeric AS dividends_pending
     FROM project_investments i
     JOIN users u ON u.id = i.investor_user_id
     LEFT JOIN (SELECT investor_user_id, SUM(entitlement)::numeric AS paid FROM project_investor_payouts
                WHERE project_id = $1 AND status = 'PAID' GROUP BY investor_user_id) pa ON pa.investor_user_id = i.investor_user_id
     LEFT JOIN (SELECT investor_user_id, SUM(entitlement)::numeric AS pending FROM project_investor_payouts
                WHERE project_id = $1 AND status = 'PENDING' GROUP BY investor_user_id) pn ON pn.investor_user_id = i.investor_user_id
     WHERE i.project_id = $1 ORDER BY i.id`,
    [projectId]
  );

  // Per-investor escrow return from the append-only settlement snapshot.
  const returnedMap = {};
  let returnedTotal = 0;
  if (settlement && settlement.summary && Array.isArray(settlement.summary.returned_to_investors)) {
    for (const d of settlement.summary.returned_to_investors) {
      returnedMap[d.investor_user_id] = Number(d.amount || 0);
      returnedTotal += Number(d.amount || 0);
    }
  }

  const investorPositions = investors.rows.map((x) => {
    const invested = Number(x.invested || 0);
    const escrowReturn = Number(returnedMap[x.investor_user_id] || 0);
    const dividendsPaid = Number(x.dividends_paid || 0);
    const refunded = x.refund_reference ? invested : 0;
    const received = round2(escrowReturn + dividendsPaid + refunded);
    const roi = invested > 0 ? round2(((received - invested) / invested) * 100) : 0;
    return {
      investor_user_id: x.investor_user_id, full_name: x.full_name, phone_number: x.phone_number,
      invested: round2(invested), escrow_return: round2(escrowReturn), dividends_paid: round2(dividendsPaid),
      dividends_pending: round2(Number(x.dividends_pending || 0)),
      refunded: round2(refunded), received, roi_percent: roi, investment_status: x.investment_status,
    };
  });

  const disbursedTotal = Number(disbursed.rows[0].total || 0);
  const closeOutPaid = round2(reserveTotal + residualTotal);
  const ownerReceived = round2(disbursedTotal + closeOutPaid);

  // Privacy: a plain investor only sees their own position, never the
  // cap table / P&L of other investors. Owner and experts see everyone.
  const scopedInvestors = (!isOwner && !isExpert(role) && isInvestor)
    ? investorPositions.filter((x) => x.investor_user_id === userId)
    : investorPositions;

  return {
    project: { id: p.id, name: p.name, status: p.status, completed_at: p.completed_at, capital_required: p.capital_required, amount_raised: p.amount_raised },
    completed: !!settlement,
    settlement,
    funds_out: {
      escrow_returned_to_investors: round2(returnedTotal),
      disbursed_to_owner: round2(disbursedTotal),
      reserve_released_to_owner: round2(reserveTotal),
      residual_released_to_owner: round2(residualTotal),
      close_out_paid_to_owner: closeOutPaid,
      dividends_paid_to_investors: round2(Number(divPaid.rows[0].total || 0)),
      dividends_pending: round2(Number(divPending.rows[0].total || 0)),
    },
    owner_position: { total_received: ownerReceived, from_disbursements: round2(disbursedTotal), from_reserve: round2(reserveTotal), from_residual: round2(residualTotal) },
    investors: scopedInvestors,
    waterfall: waterfall.rows,
    milestones: milestones.rows,
    milestone_total: milestones.rows.length,
    milestone_completed: milestones.rows.filter((m) => m.status === 'COMPLETED').length,
  };
}

/**
 * Per-stakeholder financial statement for a project in ANY state: sums up the
 * whole lifecycle (invested, escrow, disbursements, dividends, refunds,
 * close-out releases) into a single consolidated view for the owner, confirmed
 * investors, or experts. Mirrors the close-out break-down once completed.
 */
// ============================================================================
// PHASE 10 — LIQUIDATION & FINAL CLOSE
// Terminal lifecycle step. A COMPLETED project may be liquidated only once its
// close-out is fully settled (reserve + residual released, dividends paid,
// escrow returned). Liquidation archives the project as LIQUIDATED and takes a
// durable P&L snapshot that survives independent of the live ledger.
// ============================================================================

async function getLiquidationReport(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  if (!isOwner && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya taarifa ya ufilisi wa mradi huu.', 403);
  }

  const liq = await pool.query('SELECT * FROM project_liquidations WHERE project_id = $1', [projectId]);
  const existing = liq.rows[0] || null;

  const st = await getProjectStatement(projectId, { userId, role });
  const f = st.funds;
  const investorReceivedTotal = round2(st.investors.reduce((a, x) => a + x.received, 0));
  const investorInvestedTotal = round2(f.invested_confirmed);
  const investorNet = round2(investorReceivedTotal - investorInvestedTotal);
  const investorNetPct = investorInvestedTotal > 0 ? round2((investorNet / investorInvestedTotal) * 100) : 0;
  const ownerReceivedTotal = round2(f.disbursed_to_owner + f.reserve_released_to_owner + f.residual_released_to_owner);

  const missing = [];
  if (Number(f.dividends_pending) > 0) missing.push('dividends_pending');
  if (Number(f.escrow_held) > Number(f.escrow_returned_to_investors) + 0.01) missing.push('escrow');
  const accruedReserve = await getAccruedCloseOutTotal(projectId, 'RESERVE', pool);
  const accruedResidual = await getAccruedCloseOutTotal(projectId, 'OWNER_RESIDUAL', pool);
  if (Number(f.reserve_released_to_owner) < accruedReserve - 0.01) missing.push('reserve');
  if (Number(f.residual_released_to_owner) < accruedResidual - 0.01) missing.push('residual');

  const ready = !existing && missing.length === 0;
  return {
    success: true,
    project: st.project,
    liquidated: !!existing,
    ready,
    missing,
    liquidation: existing,
    snapshot: {
      funds: f,
      investors: st.investors,
      investor_received_total: investorReceivedTotal,
      investor_invested_total: investorInvestedTotal,
      investor_net: investorNet,
      investor_net_pct: investorNetPct,
      owner_received_total: ownerReceivedTotal,
    },
  };
}

async function liquidateProject(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  if (!isOwner && !isExpert(role)) {
    throw new ValidityError('Huna mamlaka ya kufilisi mradi huu.', 403);
  }
  const liqBefore = await pool.query('SELECT * FROM project_liquidations WHERE project_id = $1', [projectId]);
  if (liqBefore.rows.length > 0) {
    return { success: true, already_liquidated: true, project_id: projectId, reference: liqBefore.rows[0].reference };
  }
  if (p.status !== 'COMPLETED') {
    throw new ValidityError(`Ufilisi hufanyika baada ya mradi kuwa COMPLETED. (sasa: ${p.status})`);
  }

  const report = await getLiquidationReport(projectId, { userId, role });
  if (report.liquidated) {
    return { success: true, already_liquidated: true, project_id: projectId, reference: report.liquidation.reference };
  }
  if (!report.ready) {
    throw new ValidityError(`Mradi haujafikia hali ya kufilisiwa: hatua zifuatazo hazijakamilika - ${report.missing.join(', ')}.`, 409);
  }

  const s = report.snapshot;
  const settlementRes = await pool.query('SELECT * FROM project_settlements WHERE project_id = $1', [projectId]);
  const ref = `LIQD-${projectId}-${Date.now()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO project_liquidations
         (project_id, settlement_id, reference, status,
          funds_invested_total, revenue_total, disbursed_to_owner,
          dividends_paid_to_investors, escrow_returned_to_investors,
          reserve_released_to_owner, residual_released_to_owner,
          owner_received_total, investor_received_total, investor_net, investor_net_pct,
          summary, created_by)
       VALUES ($1,$2,$3,'LIQUIDATED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        projectId,
        settlementRes.rows[0]?.id || null,
        ref,
        s.funds.invested_confirmed, s.funds.revenue_total, s.funds.disbursed_to_owner,
        s.funds.dividends_paid_to_investors, s.funds.escrow_returned_to_investors,
        s.funds.reserve_released_to_owner, s.funds.residual_released_to_owner,
        s.owner_received_total, s.investor_received_total, s.investor_net, s.investor_net_pct,
        JSON.stringify({ funds: s.funds, investors: s.investors, reference: ref }),
        userId,
      ]
    );
    await client.query(`UPDATE projects SET status = 'LIQUIDATED', updated_at = NOW() WHERE id = $1`, [projectId]);
    await logAudit({
      eventType: 'PROJECT_LIQUIDATED', action: 'CREATE', entityType: 'PROJECT',
      userId, entityId: projectId, referenceId: ref,
      afterData: { funds_invested_total: s.funds.invested_confirmed, owner_received_total: s.owner_received_total, investor_received_total: s.investor_received_total, missing: report.missing },
      client,
    });
    await client.query('COMMIT');

    await createNotification(p.owner_user_id, {
      title: 'Mradi umefilisiwa',
      body: `Mradi "${p.name}" umefilisiwa (zimefungwa). Rejea: ${ref}`,
      type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
    });
    await notifyProjectInvestors(projectId, {
      title: 'Mradi umefilisiwa',
      body: `Mradi "${p.name}" umefilisiwa na malipo yote yamekamilika. Rejea ya ufilisi: ${ref}`,
    });
    await enqueueOutbox({
      eventType: 'PROJECT_LIQUIDATED',
      aggregateId: String(projectId),
      payload: { projectId, name: p.name, reference: ref, owner_received_total: s.owner_received_total, investor_received_total: s.investor_received_total },
      reference: `${ref}-outbox`,
    }).catch(() => {});

    return { success: true, project_id: projectId, reference: ref, liquidation: ins.rows[0] };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e.message || '').toLowerCase().includes('duplicate key')) {
      const existing = await pool.query('SELECT * FROM project_liquidations WHERE project_id = $1', [projectId]);
      if (existing.rows.length > 0) {
        return { success: true, already_liquidated: true, project_id: projectId, reference: existing.rows[0].reference };
      }
    }
    throw e;
  } finally {
    client.release();
  }
}

async function getProjectStatement(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  const invRes = await pool.query(
    `SELECT 1 FROM project_investments WHERE project_id = $1 AND investor_user_id = $2 AND status IN ('CONFIRMED','REFUNDED') LIMIT 1`,
    [projectId, userId]
  );
  const isInvestor = invRes.rows.length > 0;
  if (!isOwner && !isInvestor && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya taarifa ya mradi huu.', 403);
  }

  const settled = await pool.query('SELECT * FROM project_settlements WHERE project_id = $1', [projectId]);
  const settlement = settled.rows[0] || null;
  const completed = !!settlement;

  const agg = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN i.status='CONFIRMED' THEN i.amount END),0)::numeric AS invested_confirmed,
       COALESCE(SUM(CASE WHEN i.status='REFUNDED' THEN i.amount END),0)::numeric AS invested_refunded
     FROM project_investments i WHERE i.project_id = $1`,
    [projectId]
  );
  const disbursed = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM project_disbursements WHERE project_id = $1 AND status='RELEASED'`,
    [projectId]
  );
  const divPaid = await pool.query(
    `SELECT COALESCE(SUM(entitlement),0)::numeric AS total FROM project_investor_payouts WHERE project_id=$1 AND status='PAID'`,
    [projectId]
  );
  const divPending = await pool.query(
    `SELECT COALESCE(SUM(entitlement),0)::numeric AS total FROM project_investor_payouts WHERE project_id=$1 AND status='PENDING'`,
    [projectId]
  );
  const revenue = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM waterfall_allocation_records WHERE project_id=$1`,
    [projectId]
  );
  const waterfall = await pool.query(
    `SELECT allocation_step, COUNT(*)::int AS runs, SUM(amount)::numeric AS total
     FROM waterfall_allocation_records WHERE project_id = $1 GROUP BY allocation_step ORDER BY allocation_step`,
    [projectId]
  );
  const releases = await pool.query(
    `SELECT reserve_type, amount, released_to, reference, status, created_at
     FROM project_reserve_releases WHERE project_id = $1 ORDER BY id`,
    [projectId]
  );
  const milestones = await pool.query(
    `SELECT phase, name, status, budget FROM project_milestones WHERE project_id = $1 ORDER BY id`,
    [projectId]
  );
  const consultation = await pool.query(
    `SELECT id, amount, status, unique_reference AS payment_reference FROM project_consultations WHERE project_id = $1 ORDER BY id DESC LIMIT 1`,
    [projectId]
  );
  const investors = await pool.query(
    `SELECT i.investor_user_id, u.full_name, u.phone_number, i.amount AS invested, i.participation_pct,
            i.status AS investment_status, i.refund_reference, i.refunded_at,
            COALESCE(pa.paid,0)::numeric AS dividends_paid,
            COALESCE(pn.pending,0)::numeric AS dividends_pending
     FROM project_investments i
     JOIN users u ON u.id = i.investor_user_id
     LEFT JOIN (SELECT investor_user_id, SUM(entitlement)::numeric AS paid FROM project_investor_payouts
                WHERE project_id = $1 AND status='PAID' GROUP BY investor_user_id) pa ON pa.investor_user_id = i.investor_user_id
     LEFT JOIN (SELECT investor_user_id, SUM(entitlement)::numeric AS pending FROM project_investor_payouts
                WHERE project_id = $1 AND status='PENDING' GROUP BY investor_user_id) pn ON pn.investor_user_id = i.investor_user_id
     WHERE i.project_id = $1 ORDER BY i.id`,
    [projectId]
  );

  const returnedMap = {};
  let returnedTotal = 0;
  if (settlement && settlement.summary && Array.isArray(settlement.summary.returned_to_investors)) {
    for (const x of settlement.summary.returned_to_investors) {
      returnedMap[x.investor_user_id] = Number(x.amount || 0);
    }
    returnedTotal = Number(settlement.summary.returned_to_investors_total || 0);
    if (!(returnedTotal > 0)) {
      returnedTotal = Object.values(returnedMap).reduce((a, b) => a + b, 0);
    }
  }

  const investedConfirmed = Number(agg.rows[0].invested_confirmed || 0);
  const investedRefunded = Number(agg.rows[0].invested_refunded || 0);
  const disbursedTotal = Number(disbursed.rows[0].total || 0);
  const escrowHeld = completed
    ? Number(settlement.escrow_balance || 0)
    : Math.max(0, investedConfirmed - disbursedTotal);

  const investorPositions = investors.rows.map((x) => {
    const invested = Number(x.invested || 0);
    const dividendsPaid = Number(x.dividends_paid || 0);
    const dividendsPending = Number(x.dividends_pending || 0);
    const refunded = x.refunded_at ? invested : 0;
    const escrowReturn = returnedMap[x.investor_user_id] || 0;
    const received = round2(escrowReturn + dividendsPaid + refunded);
    const roi = invested > 0 ? round2(((received - invested) / invested) * 100) : 0;
    return {
      investor_user_id: x.investor_user_id, full_name: x.full_name, phone_number: x.phone_number,
      invested: round2(invested), participation_pct: Number(x.participation_pct || 0),
      escrow_return: round2(escrowReturn), dividends_paid: round2(dividendsPaid),
      dividends_pending: round2(dividendsPending), refunded: round2(refunded),
      received, roi_percent: roi, investment_status: x.investment_status,
    };
  });

  const releaseRows = releases.rows.map((r) => ({
    reserve_type: r.reserve_type, amount: Number(r.amount || 0), released_to: r.released_to,
    reference: r.reference, status: r.status, created_at: r.created_at,
  }));

  // Privacy: a plain investor only sees their own position, never the
  // cap table / P&L of other investors. Owner and experts see everyone.
  const scopedInvestors = (!isOwner && !isExpert(role) && isInvestor)
    ? investorPositions.filter((x) => x.investor_user_id === userId)
    : investorPositions;

  return {
    project: { id: p.id, name: p.name, status: p.status, current_stage: p.current_stage, completed_at: p.completed_at, capital_required: p.capital_required, amount_raised: p.amount_raised },
    completed,
    settlement,
    funds: {
      invested_confirmed: round2(investedConfirmed),
      invested_refunded: round2(investedRefunded),
      escrow_held: round2(escrowHeld),
      disbursed_to_owner: round2(disbursedTotal),
      dividends_paid_to_investors: round2(Number(divPaid.rows[0].total || 0)),
      dividends_pending: round2(Number(divPending.rows[0].total || 0)),
      escrow_returned_to_investors: completed ? round2(returnedTotal) : 0,
      reserve_released_to_owner: round2(releaseRows.filter((r) => r.reserve_type === 'DISTRIBUTION_RESERVE').reduce((a, r) => a + r.amount, 0)),
      residual_released_to_owner: round2(releaseRows.filter((r) => r.reserve_type === 'OWNER_RESIDUAL').reduce((a, r) => a + r.amount, 0)),
      revenue_total: round2(Number(revenue.rows[0].total || 0)),
    },
    investors: scopedInvestors,
    releases: releaseRows,
    waterfall: waterfall.rows,
    milestones: milestones.rows,
    milestone_total: milestones.rows.length,
    milestone_completed: milestones.rows.filter((m) => m.status === 'COMPLETED').length,
    consultation: consultation.rows[0] || null,
  };
}

/** Build a CSV export of the project statement. */
async function exportProjectStatementCsv(projectId, opts) {
  const st = await getProjectStatement(projectId, opts);
  const L = [];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  L.push(`Project Statement: ${st.project.name} (id ${st.project.id})`);
  L.push(`Status,${esc(st.project.status)},Completed,${st.completed ? 'yes' : 'no'}`);
  const f = st.funds;
  L.push('Summary');
  const summaryKeys = [
    ['invested_confirmed', 'Invested (confirmed)'],
    ['invested_refunded', 'Invested (refunded)'],
    ['escrow_held', 'Escrow held'],
    ['disbursed_to_owner', 'Disbursed to owner'],
    ['dividends_paid_to_investors', 'Dividends paid'],
    ['dividends_pending', 'Dividends pending'],
    ['escrow_returned_to_investors', 'Escrow returned to investors'],
    ['reserve_released_to_owner', 'Reserve released to owner'],
    ['residual_released_to_owner', 'Residual released to owner'],
    ['revenue_total', 'Total revenue processed'],
  ];
  for (const [k, label] of summaryKeys) L.push(`${label},${esc(f[k])}`);
  L.push('');
  L.push('Investors');
  L.push('Investor,Invested,Participation %,Escrow return,Dividends paid,Refunded,Total received,ROI %,Status');
  for (const inv of st.investors) {
    L.push([
      esc(inv.full_name || `+${inv.phone_number}`), inv.invested, inv.participation_pct,
      inv.escrow_return, inv.dividends_paid, inv.refunded, inv.received, `${inv.roi_percent}%`,
      esc(inv.investment_status),
    ].join(','));
  }
  return L.join('\n');
}

// ============================================================================
// PHASE 11 — PERSONAL STAKEHOLDER RECEIPT
// A single-user documentary receipt for the owner or a confirmed/refunded
// investor: their own position in a completed/liquidated project plus the
// settlement / liquidation references. Also the CSV form for record-keeping.
// ============================================================================

async function getPersonalReceipt(projectId, { userId }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  const invRes = await pool.query(
    `SELECT id, amount, participation_pct, status FROM project_investments
     WHERE project_id = $1 AND investor_user_id = $2 AND status IN ('CONFIRMED','REFUNDED') LIMIT 1`,
    [projectId, userId]
  );
  const investment = invRes.rows[0] || null;
  if (!isOwner && !investment) {
    throw new ValidityError('Huna ruhusa ya risiti ya mradi huu.', 403);
  }

  const st = await getProjectStatement(projectId, { userId, role: isOwner ? 'OWNER' : 'INVESTOR' });
  const liq = await pool.query('SELECT * FROM project_liquidations WHERE project_id = $1', [projectId]);
  const liquidation = liq.rows[0] || null;
  const f = st.funds;

  const position = isOwner
    ? {
        role: 'OWNER',
        received_total: round2(f.disbursed_to_owner + f.reserve_released_to_owner + f.residual_released_to_owner),
        from_disbursements: round2(f.disbursed_to_owner),
        from_reserve: round2(f.reserve_released_to_owner),
        from_residual: round2(f.residual_released_to_owner),
      }
    : {
        role: 'INVESTOR',
        invested: round2(Number(investment.amount || 0)),
        participation_pct: Number(investment.participation_pct || 0),
        escrow_return: st.investors.length > 0 ? st.investors[0].escrow_return : 0,
        dividends_paid: st.investors.length > 0 ? st.investors[0].dividends_paid : 0,
        dividends_pending: st.investors.length > 0 ? st.investors[0].dividends_pending : 0,
        refunded: st.investors.length > 0 ? st.investors[0].refunded : 0,
        received: st.investors.length > 0 ? st.investors[0].received : 0,
        roi_percent: st.investors.length > 0 ? st.investors[0].roi_percent : 0,
        investment_status: investment.status,
      };

  const receipt_reference = `RC-${projectId}-${userId}-${Date.now()}`;
  return {
    success: true,
    receipt_reference,
    generated_at: new Date().toISOString(),
    project: st.project,
    state: {
      completed: !!st.settlement,
      liquidated: !!liquidation,
      settlement_reference: st.settlement && st.settlement.summary ? (st.settlement.summary.reference || null) : null,
      liquidation_reference: liquidation ? liquidation.reference : null,
    },
    funds: f,
    position,
  };
}

async function exportPersonalReceiptCsv(projectId, { userId }) {
  const r = await getPersonalReceipt(projectId, { userId });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = (label) => esc(label);
  const L = [];
  L.push(`Receipt: ${r.receipt_reference}`);
  L.push(`Project,${header(r.project.name)}`);
  L.push(`Status,${header(r.project.status)}`);
  L.push(`Completed,${r.state.completed ? 'yes' : 'no'}`);
  L.push(`Liquidated,${r.state.liquidated ? 'yes' : 'no'}`);
  L.push(`Settlement ref,${header(r.state.settlement_reference || '')}`);
  L.push(`Liquidation ref,${header(r.state.liquidation_reference || '')}`);
  L.push(`Role,${r.position.role}`);
  L.push(`Generated at,${header(r.generated_at)}`);
  L.push('');
  L.push('Item,Amount');
  if (r.position.role === 'OWNER') {
    L.push(`Disbursed to owner,${r.position.from_disbursements}`);
    L.push(`Reserve released,${r.position.from_reserve}`);
    L.push(`Residual released,${r.position.from_residual}`);
    L.push(`Total received,${r.position.received_total}`);
  } else {
    L.push(`Invested,${r.position.invested}`);
    L.push(`Participation %,${r.position.participation_pct}`);
    L.push(`Escrow returned,${r.position.escrow_return}`);
    L.push(`Dividends paid,${r.position.dividends_paid}`);
    L.push(`Dividends pending,${r.position.dividends_pending}`);
    L.push(`Refunded,${r.position.refunded}`);
    L.push(`Total received,${r.position.received}`);
    L.push(`ROI %,${r.position.roi_percent}%`);
    L.push(`Status,${header(r.position.investment_status)}`);
  }
  return L.join('\n');
}

async function exportCloseOutReportCsv(projectId, { userId, role }) {
  const r = await getCloseOutReport(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  const p = r.project;
  L.push('Project')
  L.push(`Name,${esc(p.name)}`)
  L.push(`Status,${esc(p.status)}`)
  L.push(`Completed at,${esc(p.completed_at || '')}`)
  L.push(`Capital required,${p.capital_required}`)
  L.push(`Amount raised,${p.amount_raised}`)
  L.push('')
  L.push('Funds out,Amount')
  L.push(`Escrow returned to investors,${r.funds_out.escrow_returned_to_investors}`)
  L.push(`Disbursed to owner,${r.funds_out.disbursed_to_owner}`)
  L.push(`Reserve released to owner,${r.funds_out.reserve_released_to_owner}`)
  L.push(`Residual released to owner,${r.funds_out.residual_released_to_owner}`)
  L.push(`Close-out paid to owner,${r.funds_out.close_out_paid_to_owner}`)
  L.push(`Dividends paid to investors,${r.funds_out.dividends_paid_to_investors}`)
  L.push(`Dividends pending,${r.funds_out.dividends_pending}`)
  L.push('')
  L.push('Owner position,Amount')
  L.push(`Total received,${r.owner_position.total_received}`)
  L.push(`From disbursements,${r.owner_position.from_disbursements}`)
  L.push(`From reserve,${r.owner_position.from_reserve}`)
  L.push(`From residual,${r.owner_position.from_residual}`)
  L.push('')
  L.push('Investor,invested,escrow_return,dividends_paid,dividends_pending,refunded,received,roi_pct,status')
  for (const x of r.investors) {
    L.push(`${esc(x.full_name || x.investor_user_id)},${x.invested},${x.escrow_return},${x.dividends_paid},${x.dividends_pending},${x.refunded},${x.received},${x.roi_percent},${esc(x.investment_status)}`);
  }
  L.push('')
  L.push('Milestone,Status')
  for (const m of r.milestones) L.push(`${esc(m.name)} (${esc(m.phase)}),${esc(m.status)}`);
  return L.join('\n');
}

async function exportLiquidationCsv(projectId, { userId, role }) {
  const r = await getLiquidationReport(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const pr = r.project;
  const f = r.snapshot.funds;
  const L = [];
  L.push(`Project: ${esc(pr.name)}`);
  L.push(`Status,${esc(pr.status)}`);
  L.push(`Liquidated,${r.liquidated ? 'yes' : 'no'}`);
  if (r.liquidation) {
    L.push(`Liquidation ref,${esc(r.liquidation.reference)}`);
    L.push(`Liquidation status,${esc(r.liquidation.status)}`);
  }
  L.push(`Ready,${r.ready ? 'yes' : 'no'}`);
  L.push(`Missing steps,${esc((r.missing || []).join(' | '))}`);
  L.push('');
  L.push('Funds,Amount');
  L.push(`Invested confirmed,${f.invested_confirmed}`);
  L.push(`Revenue total,${f.revenue_total}`);
  L.push(`Escrow returned to investors,${f.escrow_returned_to_investors}`);
  L.push(`Escrow held,${f.escrow_held}`);
  L.push(`Disbursed to owner,${f.disbursed_to_owner}`);
  L.push(`Reserve released to owner,${f.reserve_released_to_owner}`);
  L.push(`Residual released to owner,${f.residual_released_to_owner}`);
  L.push(`Dividends paid to investors,${f.dividends_paid_to_investors}`);
  L.push(`Dividends pending,${f.dividends_pending}`);
  L.push('');
  L.push('Investor,invested,escrow_return,dividends_paid,dividends_pending,refunded,received,roi_pct');
  for (const x of r.snapshot.investors) {
    L.push(`${esc(x.full_name || x.investor_user_id)},${x.invested},${x.escrow_return},${x.dividends_paid},${x.dividends_pending},${x.refunded},${x.received},${x.roi_percent}`);
  }
  L.push('');
  L.push('Summary,Amount');
  L.push(`Investor received total,${r.snapshot.investor_received_total}`);
  L.push(`Investor invested total,${r.snapshot.investor_invested_total}`);
  L.push(`Investor net,${r.snapshot.investor_net}`);
  L.push(`Investor net %,${r.snapshot.investor_net_pct}`);
  L.push(`Owner received total,${r.snapshot.owner_received_total}`);
  return L.join('\n');
}

// ============================================================================
// PHASE 19 — INVESTOR CLOSE-OUT DOCUMENTS (PDF: SETTLEMENT + RECEIPT)
// ============================================================================

async function prepareSettlementPdf(projectId, { userId, role }) {
  const report = await getSettlementReport(projectId, { userId, role });
  if (!report.completed || !report.settlement) {
    throw new ValidityError('Mradi huu bado hauna ripoti ya ukomo (settlement).', 409);
  }
  const p = await getProject(projectId);
  const s = report.settlement;
  const summary = s.summary || {};
  let returned = Array.isArray(summary.returned_to_investors)
    ? summary.returned_to_investors
    : (Array.isArray(s.returned_to_investors) ? s.returned_to_investors : []);
  let investorRows = returned;
  if (investorRows.length && !('full_name' in investorRows[0])) {
    const names = await pool.query(
      'SELECT id, full_name FROM users WHERE id = ANY($1::int[])',
      [investorRows.map((x) => Number(x.investor_user_id))]
    );
    const nm = new Map(names.rows.map((row) => [Number(row.id), row.full_name]));
    investorRows = investorRows.map((x) => ({ ...x, full_name: nm.get(Number(x.investor_user_id)) || 'Investor' }));
  }
  return {
    document_reference: summary.reference || `SETTLE-${projectId}`,
    generated_at: new Date().toISOString(),
    currency: p.currency_code || 'TZS',
    project: { id: p.id, name: p.name, status: p.status, completed_at: p.completed_at },
    funds: {
      invested_total: Number(s.invested_total || 0),
      escrow_balance: Number(s.escrow_balance || 0),
      returned_to_investors_total: investorRows.reduce((a, x) => round2(a + Number(x.amount || 0)), 0),
      owner_received: Number(s.owner_received || 0),
      reserve_released: Number(s.reserve_released || 0),
      revenue_total: Number(s.revenue_total || 0),
      dividend_allocated: Number(s.dividend_allocated || 0),
      dividend_pending: Number(s.dividend_pending || 0),
      milestone_total: Number(s.milestone_total || 0),
      milestone_completed: Number(s.milestone_completed || 0),
    },
    investor_rows: investorRows,
  };
}

function renderSettlementReportPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('RIPOTI YA UKOMO WA MRADI (Settlement Report)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`Ref: ${v.document_reference}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Mradi / Project');
  voucherField(doc, 'Jina', `${v.project.name} (${v.project.status})`);
  voucherField(doc, 'Ilikamilishwa / Completed at', v.project.completed_at ? new Date(v.project.completed_at).toISOString() : '—');
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor(G).text('Ukomo wa Fedha / Settlement Funds');
  vline(doc, doc.y + 2);
  [
    ['Fedha zilizowekezwa / Invested total', v.funds.invested_total],
    ['Fedha zilizobaki escrow / Escrow balance', v.funds.escrow_balance],
    ['Kurudishiwa wawekezaji / Returned to investors', v.funds.returned_to_investors_total],
    ['Mwenye mradi alipokea / Owner received', v.funds.owner_received],
    ['Hifadhi iliyotolewa / Reserve released', v.funds.reserve_released],
    ['Mapato / Revenue total', v.funds.revenue_total],
    ['Michango ya dividendi / Dividend allocated', v.funds.dividend_allocated],
    ['Dividendi zilizosubiri / Dividend pending', v.funds.dividend_pending],
  ].forEach(([label, val]) => voucherField(doc, label, m(val)));
  doc.moveDown(0.4);

  if (v.investor_rows.length) {
    doc.fontSize(10).fillColor(G).text('Wawekezaji / Investors');
    vline(doc, doc.y + 2);
    doc.fontSize(9).fillColor('#333').text(`Jumla: ${v.investor_rows.length}  ·  Milestone: ${v.funds.milestone_completed}/${v.funds.milestone_total}`);
    v.investor_rows.forEach((row) => {
      doc.fontSize(9).fillColor('#111').text(`${row.full_name || 'Investor'}  (#${row.investor_user_id})  —  ${m(row.amount)}`);
    });
    doc.moveDown(0.6);
  }
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  ['Mwenye Mradi (Owner)', 'Mkaguzi Mkuu (Reviewer)', 'Msajili (Registrar)'].forEach((label) => {
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 180, lineBreak: false });
  });
  doc.moveDown(1.6);
  ['Mwenye Mradi (Owner)', 'Mkaguzi Mkuu (Reviewer)', 'Msajili (Registrar)'].forEach((label) => {
    doc.moveTo(50, doc.y).lineTo(190, doc.y).stroke('#aaa');
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 180, lineBreak: false });
  });
  doc.end();
  return doc;
}

function renderPersonalReceiptPdf(r, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const cur = r.project.currency_code || 'TZS';
  const m = (n) => `${formatMoney(n)} ${cur}`;

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('RISITI YA UWEKEZAJI (Investment Receipt)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`Ref: ${r.receipt_reference}  ·  Imetolewa: ${new Date(r.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Mradi / Project');
  voucherField(doc, 'Jina', `${r.project.name} (${r.project.status})`);
  voucherField(doc, 'Imekamilika / Completed', r.state.completed ? 'Ndiyo / Yes' : 'La / No');
  voucherField(doc, 'Imeondolewa / Liquidated', r.state.liquidated ? 'Ndiyo / Yes' : 'La / No');
  voucherField(doc, 'Settlement ref', r.state.settlement_reference || '—');
  voucherField(doc, 'Liquidation ref', r.state.liquidation_reference || '—');
  voucherField(doc, 'Nafasi / Role', r.position.role);
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor(G).text('Fedha / Position');
  vline(doc, doc.y + 2);
  if (r.position.role === 'OWNER') {
    voucherField(doc, 'Malipo kwa mwenye mradi / Disbursed to owner', m(r.position.from_disbursements));
    voucherField(doc, 'Hifadhi iliyotolewa / Reserve released', m(r.position.from_reserve));
    voucherField(doc, 'Baki la mwisho / Residual released', m(r.position.from_residual));
    voucherField(doc, 'Jumla alizopokea / Total received', m(r.position.received_total));
  } else {
    voucherField(doc, 'Kilichowekezwa / Invested', m(r.position.invested));
    voucherField(doc, 'Asilimia / Participation %', `${r.position.participation_pct}%`);
    voucherField(doc, 'Escrow ilirudishwa / Escrow returned', m(r.position.escrow_return));
    voucherField(doc, 'Dividendi zilizolipwa / Dividends paid', m(r.position.dividends_paid));
    voucherField(doc, 'Dividendi zinazosubiri / Dividends pending', m(r.position.dividends_pending));
    voucherField(doc, 'Kurudishwa / Refunded', m(r.position.refunded));
    voucherField(doc, 'Jumla / Received', m(r.position.received));
    voucherField(doc, 'ROI', `${r.position.roi_percent}%`);
    voucherField(doc, 'Hali / Status', r.position.investment_status);
  }
  doc.moveDown(0.6);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  ['Mwenye Mradi (Owner)', 'Wawekezaji (Investor)', 'Mtoa Fedha (Executor)'].forEach((label) => {
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 180, lineBreak: false });
  });
  doc.moveDown(1.6);
  ['Mwenye Mradi (Owner)', 'Wawekezaji (Investor)', 'Mtoa Fedha (Executor)'].forEach((label) => {
    doc.moveTo(50, doc.y).lineTo(190, doc.y).stroke('#aaa');
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 180, lineBreak: false });
  });
  doc.end();
  return doc;
}

// ============================================================================
// PHASE 18 — DISBURSEMENT PAYMENT VOUCHER (AUDIT-GRADE PDF)
// ============================================================================

function voucherCanonical(d) {
  return [
    d.id,
    d.unique_reference,
    d.amount,
    d.status,
    d.executed_by || '',
    d.executed_at ? new Date(d.executed_at).toISOString() : '',
    d.milestone_id || '',
  ].join('|');
}

/**
 * Owner or expert requests the payment voucher for a RELEASED disbursement.
 * Only executed money movements have a voucher - proof of the governed chain:
 * request -> review -> authorize -> release. Includes a deterministic document
 * hash so a voucher can be externally verified against its reference.
 */
async function getDisbursementVoucher(projectId, { userId, role }, reference) {
  const p = await getProject(projectId);
  if (p.owner_user_id !== userId && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya vocha ya malipo ya mradi huu.', 403);
  }

  const r = await pool.query(
    `SELECT d.*, m.name AS milestone_name,
            req.full_name AS requested_by_name,
            rev.full_name AS reviewed_by_name,
            aut.full_name AS authorized_by_name,
            exe.full_name AS executed_by_name
     FROM project_disbursements d
     LEFT JOIN project_milestones m ON m.id = d.milestone_id
     LEFT JOIN users req ON req.id = d.requested_by
     LEFT JOIN users rev ON rev.id = d.reviewed_by
     LEFT JOIN users aut ON aut.id = d.authorized_by
     LEFT JOIN users exe ON exe.id = d.executed_by
     WHERE d.project_id = $1 AND d.unique_reference = $2`,
    [projectId, reference]
  );
  if (r.rows.length === 0) throw new ValidityError('Vocha haipatikani.', 404);
  const d = r.rows[0];
  if (d.status !== 'RELEASED') {
    throw new ValidityError(`Vocha hutolewa tu kwa malipo ambayo yamekwisha tolewa (sasa: ${d.status}).`, 409);
  }

  const esc = await pool.query(
    'SELECT remaining_balance, disbursed_total FROM controlled_project_accounts WHERE project_id = $1',
    [projectId]
  );
  const escrow = esc.rows[0] || { remaining_balance: 0, disbursed_total: 0 };
  const proj = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'RELEASED' THEN amount ELSE 0 END), 0) AS released_total,
            COUNT(*) FILTER (WHERE status = 'RELEASED') AS released_count
     FROM project_disbursements WHERE project_id = $1`,
    [projectId]
  );
  const milestoneSpent = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'RELEASED' THEN amount ELSE 0 END), 0) AS spent
     FROM project_disbursements WHERE project_id = $1 AND milestone_id = $2`,
    [projectId, d.milestone_id]
  );
  const txn = await pool.query(
    `SELECT wallet_amount FROM transactions
     WHERE reference_id = $1 AND status = 'SUCCESS' ORDER BY id LIMIT 1`,
    [d.unique_reference]
  );

  const voucher = {
    project: p,
    currency: p.currency_code || 'TZS',
    voucher_number: `DV-${String(d.id).padStart(6, '0')}`,
    reference: d.unique_reference,
    amount: Number(d.amount),
    status: d.status,
    milestone_id: d.milestone_id,
    milestone_name: d.milestone_name,
    reason: d.reason,
    expert_comment: d.expert_comment,
    requested_by: d.requested_by_name,
    reviewed_by: d.reviewed_by_name,
    authorized_by: d.authorized_by_name,
    executed_by: d.executed_by_name,
    requested_at: d.created_at,
    reviewed_at: d.reviewed_at,
    authorized_at: d.approved_at,
    executed_at: d.executed_at,
    txn_amount: txn.rows.length > 0 ? Number(txn.rows[0].wallet_amount) : null,
    escrow_remaining: Number(escrow.remaining_balance),
    escrow_disbursed_total: Number(escrow.disbursed_total),
    released_total: Number(proj.rows[0].released_total),
    released_count: Number(proj.rows[0].released_count),
    milestone_spent: Number(milestoneSpent.rows[0].spent),
    document_hash: crypto.createHash('sha256').update(voucherCanonical(d)).digest('hex').slice(0, 16).toUpperCase(),
  };
  return voucher;
}

function voucherField(doc, label, value, fontSize = 9) {
  doc.fontSize(fontSize).fillColor('#555').text(label, { continued: true });
  doc.fillColor('#111').text(`  ${value}`);
}

function vline(doc, y, maxX = 552) {
  doc.moveTo(40, y).lineTo(maxX, y).stroke('#bbb');
}

function renderDisbursementVoucherPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);

  const G = '#0B5D1E';

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('VOCHA YA MALIPO (Disbursement Voucher)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`Inaweza kuthibitishwa kwa namba ya vocha kwenye mfumo.`, { align: 'center', italic: true });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Vocha Namba / Voucher No.', { continued: true });
  doc.fillColor('#111').text(`  #${v.voucher_number}   ·   Ref: ${v.reference}  ·   Hash: ${v.document_hash}`, { width: 500 });
  doc.moveDown(0.3);

  doc.fontSize(20).fillColor('#111').text(`${formatMoney(v.amount)} ${v.currency}`, { align: 'center' });
  doc.fontSize(9).fillColor('#666').text('Kiasi kilichotolewa / Amount disbursed', { align: 'center' });
  doc.moveDown(0.5);

  doc.fontSize(10).fillColor(G).text('Maelezo ya Mradi / Project Details');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Mradi', `${v.project.name} (${v.project.status})`);
  voucherField(doc, 'Hatua / Milestone', `${v.milestone_id ? `#${v.milestone_id} ` : ''}${v.milestone_name || '—'}`);
  voucherField(doc, 'Sababu / Purpose', v.reason || '—');
  if (v.expert_comment) voucherField(doc, 'Maoni ya Mkaguzi', v.expert_comment);
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor(G).text('Msururu wa Idhini / Approval Chain (Segregation of Duties)');
  vline(doc, doc.y + 2);
  const chain = [
    ['Aliyeomba / Requested by', v.requested_by, v.requested_at],
    ['Mkaguzi / Reviewed by', v.reviewed_by, v.reviewed_at],
    ['Muidhinishaji / Authorized by', v.authorized_by, v.authorized_at],
    ['Mtoa Fedha / Executed by', v.executed_by, v.executed_at],
  ];
  const t = (dt) => (dt ? new Date(dt).toLocaleString('en-GB', { timeZone: 'UTC' }) : '—');
  chain.forEach(([label, who, when]) => voucherField(doc, label, `${who || '—'}   (${t(when)})`));
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor(G).text('Hali ya Escrow / Escrow Position');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Jumla ya fedha zilizotolewa / Disbursed total', `${formatMoney(v.escrow_disbursed_total)} ${v.currency}`);
  voucherField(doc, 'Fedha zilizobaki kwenye escrow / Escrow remaining', `${formatMoney(v.escrow_remaining)} ${v.currency}`);
  voucherField(doc, 'Malipo yote juu ya mradi / All project releases', `${v.released_count} tranche(s) = ${formatMoney(v.released_total)} ${v.currency}`);
  voucherField(doc, 'Fedha za hatua hii / This milestone', `${formatMoney(v.milestone_spent)} ${v.currency}`);
  voucherField(doc, 'Rekodi ya mfumo / Ledger post', v.txn_amount != null ? `${formatMoney(v.txn_amount)} ${v.currency}` : '—');
  doc.moveDown(0.6);

  vline(doc, doc.y + 4);
  doc.moveDown(0.6);
  const sig = ['Mwenye Mradi (Owner)', 'Mkaguzi (Reviewer)', 'Muidhinishaji (Authorizer)', 'Mtoa Fedha (Executor)'];
  sig.forEach((label) => {
    doc.fontSize(9).fillColor('#333').text(label, { align: 'center', width: 130, lineBreak: false });
  });
  doc.moveDown(2);
  sig.forEach((label) => {
    doc.moveTo(60, doc.y).lineTo(160, doc.y).stroke('#aaa');
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 130, lineBreak: false });
  });

  doc.end();
  return doc;
}

// ============================================================================
// PHASE 20 — LIQUIDATION + CLOSE-OUT DOCUMENTS (PDF)
// ============================================================================

async function prepareLiquidationPdf(projectId, { userId, role }) {
  const r = await getLiquidationReport(projectId, { userId, role });
  if (!r.liquidated) {
    throw new ValidityError('Mradi huu bado haujafilisiwa; hakuna taarifa ya ufilisi.', 409);
  }
  const p = await getProject(projectId);
  const summary = r.liquidation && r.liquidation.summary ? r.liquidation.summary : {};
  const funds = summary.funds || r.snapshot.funds || {};
  const investors = Array.isArray(summary.investors) ? summary.investors : (r.snapshot.investors || []);
  return {
    reference: (r.liquidation && r.liquidation.reference) || `LIQD-${projectId}`,
    generated_at: new Date().toISOString(),
    currency: p.currency_code || 'TZS',
    project: { id: p.id, name: p.name, status: p.status, completed_at: p.completed_at },
    funds,
    investor_received_total: Number(summary.investor_received_total ?? r.snapshot.investor_received_total ?? 0),
    investor_net: Number(summary.investor_net ?? r.snapshot.investor_net ?? 0),
    investor_net_pct: Number(summary.investor_net_pct ?? r.snapshot.investor_net_pct ?? 0),
    owner_received_total: Number(summary.owner_received_total ?? r.snapshot.owner_received_total ?? 0),
    investors,
  };
}

function renderLiquidationReportPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('RIPOTI YA UFILISI WA MRADI (Liquidation Report)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`Ref: ${v.reference}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Mradi / Project');
  voucherField(doc, 'Jina', `${v.project.name} (${v.project.status})`);
  if (v.project.completed_at) voucherField(doc, 'Ilikamilishwa / Completed at', new Date(v.project.completed_at).toISOString());
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor(G).text('Hali ya Fedha / Fund Position');
  vline(doc, doc.y + 2);
  const f = v.funds;
  [
    ['Fedha zilizowekezwa / Invested confirmed', f.invested_confirmed],
    ['Malipo kwa mwenye mradi / Disbursed to owner', f.disbursed_to_owner],
    ['Dividendi zilizolipwa / Dividends paid', f.dividends_paid_to_investors],
    ['Escrow iliyorudishwa / Escrow returned', f.escrow_returned_to_investors],
    ['Hifadhi released / Reserve released', f.reserve_released_to_owner],
    ['Baki ya mwisho / Residual released', f.residual_released_to_owner],
    ['Mapato / Revenue total', f.revenue_total],
  ].forEach(([label, val]) => { if (val !== undefined) voucherField(doc, label, m(val || 0)); });
  voucherField(doc, 'Wawekezaji walipokea / Investor received', m(v.investor_received_total));
  voucherField(doc, 'Mwenye mradi alipokea / Owner received', m(v.owner_received_total));
  voucherField(doc, 'Mtandao wa wawekezaji / Investor net', `${m(v.investor_net)}  (${v.investor_net_pct}%)`);
  doc.moveDown(0.4);

  if (v.investors.length) {
    doc.fontSize(10).fillColor(G).text('Wawekezaji / Investors');
    vline(doc, doc.y + 2);
    v.investors.forEach((row) => {
      const name = row.full_name || row.name || 'Investor';
      doc.fontSize(9).fillColor('#111').text(`${name}  —  invested ${m(row.invested)}  ·  received ${m(row.received)}  ·  ROI ${row.roi_percent || 0}%`);
    });
    doc.moveDown(0.6);
  }
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  ['Mwenye Mradi (Owner)', 'Mkaguzi Mkuu (Reviewer)', 'Msajili (Registrar)'].forEach((label) => {
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 180, lineBreak: false });
  });
  doc.moveDown(1.6);
  ['Mwenye Mradi (Owner)', 'Mkaguzi Mkuu (Reviewer)', 'Msajili (Registrar)'].forEach((label) => {
    doc.moveTo(50, doc.y).lineTo(190, doc.y).stroke('#aaa');
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 180, lineBreak: false });
  });
  doc.end();
  return doc;
}

async function prepareCloseOutPdf(projectId, { userId, role }) {
  const r = await getCloseOutReport(projectId, { userId, role });
  if (!r.completed) {
    throw new ValidityError('Mradi huu bado haujakamilika; hakuna ripoti ya kufunga.', 409);
  }
  const p = await getProject(projectId);
  const settlementRef = r.settlement && r.settlement.summary ? (r.settlement.summary.reference || null) : null;
  return {
    generated_at: new Date().toISOString(),
    currency: p.currency_code || 'TZS',
    project: r.project,
    settlement_reference: settlementRef,
    funds_out: r.funds_out,
    owner_position: r.owner_position,
    investors: r.investors,
    waterfall: r.waterfall || [],
    milestone_total: r.milestone_total,
    milestone_completed: r.milestone_completed,
  };
}

function renderCloseOutReportPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('RIPOTI YA KUFUNGA MRADI (Close-Out Report)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`Settlement: ${v.settlement_reference || '—'}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Mradi / Project');
  voucherField(doc, 'Jina', `${v.project.name} (${v.project.status})`);
  voucherField(doc, 'Mtaji uliotakiwa / Capital required', m(v.project.capital_required));
  voucherField(doc, 'Kilichokusanywa / Amount raised', m(v.project.amount_raised));
  voucherField(doc, 'Milestones', `${v.milestone_completed}/${v.milestone_total}`);
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor(G).text('Fedha Zilizotoka / Funds Out');
  vline(doc, doc.y + 2);
  const o = v.funds_out;
  [
    ['Escrow kurudishiwa wawekezaji / Escrow returned', o.escrow_returned_to_investors],
    ['Dividendi zilizolipwa / Dividends paid', o.dividends_paid_to_investors],
    ['Dividendi zinazosubiri / Dividends pending', o.dividends_pending],
    ['Malipo kwa mwenye mradi / Disbursed to owner', o.disbursed_to_owner],
    ['Hifadhi released / Reserve released', o.reserve_released_to_owner],
    ['Baki released / Residual released', o.residual_released_to_owner],
  ].forEach(([label, val]) => voucherField(doc, label, m(val)));
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor(G).text('Mwenye Mradi / Owner Position');
  voucherField(doc, 'Jumla alizopokea / Total received', m(v.owner_position.total_received));
  doc.moveDown(0.4);

  if (v.investors.length) {
    doc.fontSize(10).fillColor(G).text('Wawekezaji / Investors');
    vline(doc, doc.y + 2);
    v.investors.forEach((row) => {
      const name = row.full_name || 'Investor';
      doc.fontSize(9).fillColor('#111').text(`${name}  —  invested ${m(row.invested)}  ·  escrow ${m(row.escrow_return)}  ·  div ${m(row.dividends_paid)}  ·  received ${m(row.received)}  ·  ROI ${row.roi_percent || 0}%`);
    });
    doc.moveDown(0.6);
  }

  if (v.waterfall.length) {
    doc.fontSize(10).fillColor(G).text('Waterfall Allocations');
    vline(doc, doc.y + 2);
    v.waterfall.forEach((w) => voucherField(doc, w.allocation_step, `${w.runs}×  ${m(w.total)}`));
    doc.moveDown(0.6);
  }

  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  ['Mwenye Mradi (Owner)', 'Mkaguzi Mkuu (Reviewer)', 'Msajili (Registrar)'].forEach((label) => {
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 180, lineBreak: false });
  });
  doc.moveDown(1.6);
  ['Mwenye Mradi (Owner)', 'Mkaguzi Mkuu (Reviewer)', 'Msajili (Registrar)'].forEach((label) => {
    doc.moveTo(50, doc.y).lineTo(190, doc.y).stroke('#aaa');
    doc.fontSize(8).fillColor('#888').text(label, { align: 'center', width: 180, lineBreak: false });
  });
  doc.end();
  return doc;
}

// ============================================================================
// PHASE 21 — PLATFORM OPS BOOK PDF + WATERFALL EXECUTION LEDGER
// ============================================================================

async function prepareOpsBookPdf({ userId, role }) {
  const r = await getPlatformPfeBook({ userId, role });
  return {
    generated_at: r.generated_at,
    currency: 'TZS',
    totals: r.totals,
    platform_variance: r.platform_variance,
    by_status: r.by_status,
    waterfall: r.waterfall,
    projects: r.projects,
    flags: r.flags,
    counts: r.counts,
  };
}

function renderOpsBookPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;
  const ensure = () => { if (doc.y > 760) doc.addPage(); };

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('DAFTARI LA UENDESHAJI WA FEDHA ZA MIRADI (Platform PFE Ops Book)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`Imetolewa: ${new Date(v.generated_at).toISOString()}  ·  Sarafu: ${v.currency}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Hali ya Uadilifu wa Mfumo / Platform Integrity');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Tofauti ya uadilifu / Platform variance', m(v.platform_variance));
  voucherField(doc, 'Alama za uadilifu / Integrity flags', String((v.flags || []).length));
  voucherField(doc, 'Miradi / Projects', `${v.counts.projects}  (wazi ${v.counts.open} · zilizofilisiwa ${v.counts.liquidated})`);
  if (v.flags.length) {
    doc.fontSize(8).fillColor('#dc2626').text(`Flags: ${v.flags.map((f) => `${f.name} (${m(f.variance)})`).join(' · ')}`);
  }
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text('Jumla / Platform Totals');
  vline(doc, doc.y + 2);
  const t = v.totals;
  [
    ['Fedha zilizowekezwa / Invested confirmed', t.invested],
    ['Kurudishiwa / Refunded', t.refunded],
    ['Escrow inayoshikiliwa / Escrow held', t.escrow_held],
    ['Malipo kwa wamiliki / Disbursed to owners', t.disbursed],
    ['Hifadhi released / Reserve released', t.reserve_released],
    ['Baki released / Residual released', t.residual_released],
    ['Escrow iliyorudishwa / Escrow returned', t.escrow_returned],
    ['Dividendi zilizolipwa / Dividends paid', t.dividends_paid],
    ['Dividendi zinazosubiri / Dividends pending', t.dividends_pending],
    ['Mapato / Revenue total', t.revenue_total],
    ['Mtandao wa ufilisi / Liquidation investor net', t.liquidation_investor_net],
  ].forEach(([label, val]) => voucherField(doc, label, m(val || 0)));
  doc.moveDown(0.3);

  if (v.by_status.length) {
    doc.fontSize(10).fillColor(G).text('Miradi Kwa Hali / Projects By Status');
    vline(doc, doc.y + 2);
    v.by_status.forEach((s) => voucherField(doc, s.status, `${s.projects}  ·  ${m(s.invested || 0)}`));
    doc.moveDown(0.3);
  }

  if (v.waterfall.length) {
    doc.fontSize(10).fillColor(G).text('Waterfall Executions');
    vline(doc, doc.y + 2);
    v.waterfall.forEach((w) => voucherField(doc, w.step, `${w.runs}×  ${m(w.total)}`));
    doc.moveDown(0.3);
  }

  doc.fontSize(10).fillColor(G).text('Miradi / Per-Project Ledger');
  vline(doc, doc.y + 2);
  doc.fontSize(8).fillColor('#444').text('#  Jina  ·  Hali  ·  Mwenye  ·  Invest  ·  Escrow  ·  Disb  ·  Div  ·  Var', { continued: false });
  for (const p of v.projects) {
    ensure();
    doc.fontSize(7.5).fillColor(p.integrity_ok ? '#111' : '#dc2626')
      .text(`${p.project_id}  ${p.name}`.slice(0, 42) + `  ·  ${p.status}  ·  ${p.owner.full_name || p.owner.phone_number}`.slice(0, 30)
        + `  ·  ${m(p.invested)}  ${m(p.escrow_held)}  ${m(p.disbursed)}  ${m(p.dividends_paid)}  ${m(p.integrity_variance)}`);
  }

  ensure();
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.moveDown(1.6);
  doc.moveTo(120, doc.y).lineTo(320, doc.y).stroke('#aaa');
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.end();
  return doc;
}

async function getWaterfallLedger(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  if (!isOwner && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya kumbukumbu za utekelezaji wa waterfall wa mradi huu.', 403);
  }
  const rec = await pool.query(
    `SELECT w.* FROM waterfall_allocation_records w
     WHERE w.project_id = $1 ORDER BY w.id`, [projectId]
  );
  const summary = await pool.query(
    `SELECT allocation_step, COUNT(*)::int AS runs, SUM(amount)::numeric AS total, SUM(percentage) AS avg_pct
     FROM waterfall_allocation_records WHERE project_id = $1
     GROUP BY allocation_step ORDER BY MIN(id)`, [projectId]
  );
  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status },
    generated_at: new Date().toISOString(),
    summary: summary.rows.map((r) => ({ step: r.allocation_step, runs: r.runs, total: round2(Number(r.total || 0)) })),
    records: rec.rows.map((r) => ({
      id: r.id,
      rule_version: r.rule_version,
      step: r.allocation_step,
      priority: r.priority,
      revenue_reference: r.revenue_reference,
      source_account_code: r.source_account_code,
      destination_account_code: r.destination_account_code,
      calculation_basis: r.calculation_basis,
      percentage: r.percentage,
      amount: round2(Number(r.amount || 0)),
      currency: r.currency || 'TZS',
      ledger_group_id: r.ledger_group_id,
      reconciliation_status: r.reconciliation_status,
      created_at: r.created_at,
    })),
  };
}

async function exportWaterfallLedgerCsv(projectId, { userId, role }) {
  const r = await getWaterfallLedger(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Project,${esc(r.project.name)} (${r.project.id})`);
  L.push(`Status,${r.project.status}`);
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push('');
  L.push('Step,Total');
  r.summary.forEach((s) => L.push(`${esc(s.step)},${s.total}`));
  L.push('');
  L.push('id,created_at,step,priority,pct,amount,currency,revenue_reference,source_account,destination_account,rule_version,ledger_group_id,status');
  for (const x of r.records) {
    L.push([x.id, esc(x.created_at), esc(x.step), x.priority, x.percentage, x.amount, esc(x.currency),
            esc(x.revenue_reference), esc(x.source_account_code), esc(x.destination_account_code),
            x.rule_version, x.ledger_group_id, esc(x.reconciliation_status)].join(','));
  }
  return L.join('\n');
}

async function prepareWaterfallLedgerPdf(projectId, { userId, role }) {
  const r = await getWaterfallLedger(projectId, { userId, role });
  return { ...r, currency: r.records.length ? (r.records[0].currency || 'TZS') : 'TZS' };
}

function renderWaterfallLedgerPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;
  const ensure = () => { if (doc.y > 760) doc.addPage(); };

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('KUMBUKUMBU ZA UTEKELEZAJI WA WATERFALL (Waterfall Execution Ledger)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`${v.project.name}  (${v.project.id})  ·  ${v.project.status}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  if (v.summary.length) {
    doc.fontSize(10).fillColor(G).text('Muhtasari / Summary');
    vline(doc, doc.y + 2);
    v.summary.forEach((s) => voucherField(doc, s.step, `${s.runs}×  ${m(s.total)}`));
    doc.moveDown(0.3);
  }

  doc.fontSize(10).fillColor(G).text(`Rekodi / Records (${v.records.length})`);
  vline(doc, doc.y + 2);
  for (const x of v.records) {
    ensure();
    doc.fontSize(8).fillColor('#111').text(
      `#${x.id}  ·  ${x.step}  ·  ${x.priority}  ·  ${x.percentage}%  ·  ${m(x.amount)}`);
    doc.fontSize(7).fillColor('#555').text(
      `   ref ${x.revenue_reference || '—'}  ·  ${x.source_account_code} → ${x.destination_account_code}  ·  rule v${x.rule_version || '—'}  ·  leg ${x.ledger_group_id || '—'}  ·  ${x.reconciliation_status}  ·  ${new Date(x.created_at).toISOString()}`, { lineBreak: true });
  }

  ensure();
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.moveDown(1.6);
  doc.moveTo(120, doc.y).lineTo(320, doc.y).stroke('#aaa');
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.end();
  return doc;
}

// ============================================================================
// PHASE 22 — DIVIDEND PAYOUT REGISTER + ESCROW/DRAWDOWN PROJECTION
// ============================================================================

async function getPayoutRegister(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  if (!isOwner && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya rejesta ya dividend za mradi huu.', 403);
  }
  const pay = await pool.query(
    `SELECT pa.*, u.full_name, u.phone_number
     FROM project_investor_payouts pa
     JOIN users u ON u.id = pa.investor_user_id
     WHERE pa.project_id = $1 ORDER BY pa.id`, [projectId]
  );
  const paidTotal = round2(pay.rows.filter((x) => x.status === 'PAID').reduce((s, x) => s + Number(x.entitlement), 0));
  const pendingTotal = round2(pay.rows.filter((x) => x.status === 'PENDING').reduce((s, x) => s + Number(x.entitlement), 0));
  const byInvestorRes = await pool.query(
    `SELECT pa.investor_user_id, u.full_name, u.phone_number,
            COALESCE(SUM(pa.entitlement) FILTER (WHERE pa.status='PAID'),0)::numeric AS paid,
            COALESCE(SUM(pa.entitlement) FILTER (WHERE pa.status='PENDING'),0)::numeric AS pending
     FROM project_investor_payouts pa JOIN users u ON u.id = pa.investor_user_id
     WHERE pa.project_id = $1 GROUP BY pa.investor_user_id, u.full_name, u.phone_number
     ORDER BY u.full_name`, [projectId]
  );
  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status },
    generated_at: new Date().toISOString(),
    totals: { paid: paidTotal, pending: pendingTotal, count: pay.rows.length },
    per_investor: byInvestorRes.rows.map((x) => ({ investor_user_id: x.investor_user_id, full_name: x.full_name, phone_number: x.phone_number, paid: round2(Number(x.paid || 0)), pending: round2(Number(x.pending || 0)) })),
    payouts: pay.rows.map((x) => ({
      id: x.id,
      investor_user_id: x.investor_user_id,
      full_name: x.full_name,
      phone_number: x.phone_number,
      entitlement: round2(Number(x.entitlement || 0)),
      status: x.status,
      payout_reference: x.payout_reference,
      payout_setting_reference: x.payout_setting_reference,
      paid_at: x.paid_at,
      allocation_id: x.allocation_id,
      created_at: x.created_at,
    })),
  };
}

async function exportPayoutRegisterCsv(projectId, { userId, role }) {
  const r = await getPayoutRegister(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Project,${esc(r.project.name)} (${r.project.id})`);
  L.push(`Status,${r.project.status}`);
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push(`Dividends paid total,${r.totals.paid}`);
  L.push(`Dividends pending total,${r.totals.pending}`);
  L.push('');
  L.push('id,investor,phone,entitlement,status,payout_reference,paid_at,created_at');
  for (const x of r.payouts) {
    L.push([x.id, esc(x.full_name), esc(x.phone_number), x.entitlement, esc(x.status),
            esc(x.payout_reference || ''), esc(x.paid_at || ''), esc(x.created_at)].join(','));
  }
  return L.join('\n');
}

async function preparePayoutRegisterPdf(projectId, { userId, role }) {
  const r = await getPayoutRegister(projectId, { userId, role });
  return { ...r, currency: 'TZS' };
}

function renderPayoutRegisterPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;
  const ensure = () => { if (doc.y > 760) doc.addPage(); };

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('REJESTA YA DIVIDEND ZA WAWEKEZAJI (Dividend Payout Register)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`${v.project.name}  (${v.project.id})  ·  ${v.project.status}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Jumla / Totals');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Dividendi zilizolipwa / Dividends paid', m(v.totals.paid));
  voucherField(doc, 'Dividendi zinazosubiri / Dividends pending', m(v.totals.pending));
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text('Kwa Mwekezaji / Per Investor');
  vline(doc, doc.y + 2);
  v.per_investor.forEach((x) => voucherField(doc, x.full_name, `paid ${m(x.paid)}  ·  pending ${m(x.pending)}`));
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text(`Malipo / Payouts (${v.payouts.length})`);
  vline(doc, doc.y + 2);
  for (const x of v.payouts) {
    ensure();
    doc.fontSize(8).fillColor('#111').text(`#${x.id}  ·  ${x.full_name}  ·  ${m(x.entitlement)}  ·  ${x.status}${x.paid_at ? '  ·  ' + new Date(x.paid_at).toISOString() : ''}`);
    doc.fontSize(7).fillColor('#555').text(`   ref ${x.payout_reference || '—'}  ·  allocation ${x.allocation_id || '—'}`);
  }

  ensure();
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.moveDown(1.6);
  doc.moveTo(120, doc.y).lineTo(320, doc.y).stroke('#aaa');
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.end();
  return doc;
}

async function getEscrowProjection(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  if (!isOwner && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya makisio ya escrow ya mradi huu.', 403);
  }
  await syncDrawdowns(projectId);
  const escrowRes = await pool.query(
    `SELECT COALESCE(remaining_balance,0)::numeric AS balance FROM controlled_project_accounts WHERE project_id = $1`, [projectId]
  );
  const escrow = round2(Number(escrowRes.rows[0]?.balance || 0));
  const planRes = await pool.query('SELECT * FROM project_drawdown_plans WHERE project_id = $1', [projectId]);
  const plan = planRes.rows[0] || null;
  const trs = plan
    ? (await pool.query('SELECT status, amount FROM project_drawdowns WHERE plan_id = $1 AND project_id = $2', [plan.id, projectId])).rows
    : [];
  let released = 0, committed = 0, scheduled = 0;
  for (const t of trs) {
    const amt = Number(t.amount || 0);
    if (t.status === 'RELEASED') released += amt;
    else if (['REQUESTED', 'REVIEWED', 'AUTHORIZED'].includes(t.status)) committed += amt;
    else if (t.status === 'SCHEDULED') scheduled += amt;
  }
  released = round2(released); committed = round2(committed); scheduled = round2(scheduled);
  const outstanding = round2(committed + scheduled);
  const projected_remaining = round2(escrow - outstanding);
  const shortfall = Math.max(0, round2(outstanding - escrow));
  const mode = !plan ? 'NO_PLAN'
    : (shortfall > 0 ? 'SHORTFALL'
      : (committed > 0 ? 'COMMITTED'
        : (scheduled > 0 ? 'FUNDED' : 'FUNDED')));
  const st = await getProjectStatement(projectId, { userId, role });
  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status },
    generated_at: new Date().toISOString(),
    currency: p.currency_code || 'TZS',
    escrow_held: escrow,
    invested_confirmed: round2(st.funds.invested_confirmed),
    plan: plan ? { id: plan.id, total_amount: round2(Number(plan.total_amount)), status: plan.status } : null,
    tranche_state: { released, committed, scheduled },
    outstanding_total: outstanding,
    projected_remaining: projected_remaining,
    shortfall: shortfall,
    mode,
    dividends_pending: round2(st.funds.dividends_pending),
    escrow_returned_to_investors: round2(st.funds.escrow_returned_to_investors),
  };
}

async function exportEscrowProjectionCsv(projectId, { userId, role }) {
  const r = await getEscrowProjection(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Project,${esc(r.project.name)} (${r.project.id})`);
  L.push(`Status,${r.project.status}`);
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push(`Escrow held,${r.escrow_held}`);
  L.push(`Invested confirmed,${r.invested_confirmed}`);
  L.push(`Plan total,${r.plan ? r.plan.total_amount : ''}`);
  L.push(`Released,${r.tranche_state.released}`);
  L.push(`Committed (req/reviewed/authorized),${r.tranche_state.committed}`);
  L.push(`Scheduled,${r.tranche_state.scheduled}`);
  L.push(`Outstanding total,${r.outstanding_total}`);
  L.push(`Projected remaining escrow,${r.projected_remaining}`);
  L.push(`Shortfall,${r.shortfall}`);
  L.push(`Mode,${r.mode}`);
  L.push(`Dividends pending (revenue pool, not escrow),${r.dividends_pending}`);
  return L.join('\n');
}

// ============================================================================
// PHASE 24 — MILESTONE OPERATIONAL REGISTER + REVENUE PROCESSING REGISTER
// ============================================================================

async function getMilestoneRegister(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  if (!isOwner && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya rejesta ya milestones za mradi huu.', 403);
  }
  const ms = await pool.query(
    `SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY id`, [projectId]
  );
  const dd = await pool.query(
    `SELECT * FROM project_drawdowns WHERE project_id = $1 ORDER BY milestone_id, sequence`, [projectId]
  );
  const tranchesByMs = {};
  for (const t of dd.rows) {
    (tranchesByMs[t.milestone_id] = tranchesByMs[t.milestone_id] || []).push({
      id: t.id, sequence: t.sequence, amount: Number(t.amount), status: t.status,
      disbursement_reference: t.disbursement_reference,
    });
  }
  const milestones = ms.rows.map((m) => ({
    id: m.id, name: m.name, phase: m.phase, status: m.status, budget: round2(Number(m.budget || 0)),
    proof_submitted_by: m.proof_submitted_by,
    proof_submitted_at: m.proof_submitted_at,
    proof_notes: m.proof_notes,
    proof_documents: typeof m.proof_documents === 'string' ? JSON.parse(m.proof_documents || '[]') : (m.proof_documents || []),
    expert_reviewer_id: m.expert_reviewer_id,
    expert_reviewed_at: m.expert_reviewed_at,
    expert_comment: m.expert_comment,
    ai_verification: typeof m.ai_verification === 'string' ? JSON.parse(m.ai_verification || 'null') : m.ai_verification,
    tranches: tranchesByMs[m.id] || [],
  }));
  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status },
    generated_at: new Date().toISOString(),
    summary: {
      total: milestones.length,
      completed: milestones.filter((m) => m.status === 'COMPLETED').length,
      budget_total: round2(milestones.reduce((s, m) => s + m.budget, 0)),
      tranche_released: round2(milestones.reduce((s, m) => s + m.tranches.filter((t) => t.status === 'RELEASED').reduce((a, t) => a + t.amount, 0), 0)),
    },
    milestones,
  };
}

async function exportMilestoneRegisterCsv(projectId, { userId, role }) {
  const r = await getMilestoneRegister(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Project,${esc(r.project.name)} (${r.project.id})`);
  L.push(`Status,${r.project.status}`);
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push(`Milestones,total ${r.summary.total} / completed ${r.summary.completed}`);
  L.push(`Budget total,${r.summary.budget_total}`);
  L.push(`Tranches released,${r.summary.tranche_released}`);
  L.push('');
  L.push('id,name,phase,status,budget,proof_submitted_by,proof_submitted_at,proof_notes,expert_reviewer_id,expert_reviewed_at,expert_comment,tranches');
  for (const m of r.milestones) {
    const tx = m.tranches.map((t) => `seq${t.sequence}:${t.status}:${t.disbursement_reference || ''}`).join(' | ');
    L.push([m.id, esc(m.name), esc(m.phase || ''), esc(m.status), m.budget,
            m.proof_submitted_by || '', esc(m.proof_submitted_at || ''), esc(m.proof_notes || ''),
            m.expert_reviewer_id || '', esc(m.expert_reviewed_at || ''), esc(m.expert_comment || ''),
            esc(tx)].join(','));
  }
  return L.join('\n');
}

async function prepareMilestoneRegisterPdf(projectId, { userId, role }) {
  const r = await getMilestoneRegister(projectId, { userId, role });
  const p = await getProject(projectId);
  return { ...r, currency: p.currency_code || 'TZS' };
}

function renderMilestoneRegisterPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;
  const ensure = () => { if (doc.y > 760) doc.addPage(); };

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('REJESTA YA HATUA NA USHAHIDI (Milestone & Proof Register)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`${v.project.name}  (${v.project.id})  ·  ${v.project.status}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Muhtasari / Summary');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Hatua / Milestones', `${v.summary.completed}/${v.summary.total} zimekamilika`);
  voucherField(doc, 'Bajeti / Budget total', m(v.summary.budget_total));
  voucherField(doc, 'Malipo yaliyotolewa / Tranches released', m(v.summary.tranche_released));
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text(`Hatua / Milestones (${v.milestones.length})`);
  vline(doc, doc.y + 2);
  for (const x of v.milestones) {
    ensure();
    doc.fontSize(8.5).fillColor('#111').text(`#${x.id}  ${x.name}  ·  ${x.status}  ·  budget ${m(x.budget)}${x.phase ? '  ·  ' + x.phase : ''}`);
    if (x.proof_submitted_at) {
      doc.fontSize(7).fillColor('#555').text(`   Ushahidi: submitted ${new Date(x.proof_submitted_at).toISOString()}  ·  docs ${x.proof_documents.length}`);
      if (x.proof_notes) doc.fontSize(7).fillColor('#555').text(`   Note: ${x.proof_notes}`);
    }
    if (x.expert_reviewed_at) {
      doc.fontSize(7).fillColor('#0B5D1E').text(`   Ukaguzi: reviewer #${x.expert_reviewer_id}  ·  ${new Date(x.expert_reviewed_at).toISOString()}${x.expert_comment ? '  ·  ' + x.expert_comment : ''}`);
    }
    if (x.tranches.length) {
      doc.fontSize(7).fillColor('#444').text(`   Malipo: ${x.tranches.map((t) => `seq${t.sequence} ${m(t.amount)} ${t.status}${t.disbursement_reference ? ' (' + t.disbursement_reference + ')' : ''}`).join(' · ')}`);
    }
  }

  ensure();
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.moveDown(1.6);
  doc.moveTo(120, doc.y).lineTo(320, doc.y).stroke('#aaa');
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.end();
  return doc;
}

async function getRevenueRegister(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  if (!isOwner && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya rejesta ya mapato ya mradi huu.', 403);
  }
  const rev = await pool.query(
    `SELECT * FROM project_revenue WHERE project_id = $1 ORDER BY id`, [projectId]
  );
  const alloc = await pool.query(
    `SELECT revenue_reference, allocation_step, COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS runs
     FROM waterfall_allocation_records WHERE project_id = $1
     GROUP BY revenue_reference, allocation_step ORDER BY revenue_reference, MIN(id)`, [projectId]
  );
  const allocByRef = {};
  for (const a of alloc.rows) (allocByRef[a.revenue_reference] = allocByRef[a.revenue_reference] || []).push({ step: a.allocation_step, total: round2(Number(a.total || 0)), runs: a.runs });
  const revenue = rev.rows.map((r) => ({
    id: r.id, revenue_type: r.revenue_type, amount: round2(Number(r.amount || 0)),
    reconciled: !!r.reconciled, reference: r.unique_reference, created_at: r.created_at,
    allocations: allocByRef[r.unique_reference] || [],
  }));
  const revenue_total = round2(revenue.reduce((s, x) => s + x.amount, 0));
  const allocated_total = round2(revenue.reduce((s, x) => s + x.allocations.reduce((a, y) => a + y.total, 0), 0));
  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status },
    generated_at: new Date().toISOString(),
    summary: { batches: revenue.length, revenue_total, allocated_total, allocation_parity: allocated_total === revenue_total },
    revenue,
  };
}

async function exportRevenueRegisterCsv(projectId, { userId, role }) {
  const r = await getRevenueRegister(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Project,${esc(r.project.name)} (${r.project.id})`);
  L.push(`Status,${r.project.status}`);
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push(`Batches,${r.summary.batches}`);
  L.push(`Revenue total,${r.summary.revenue_total}`);
  L.push(`Allocated total,${r.summary.allocated_total}`);
  L.push(`Allocation parity,${r.summary.allocation_parity}`);
  L.push('');
  L.push('id,revenue_type,amount,reconciled,reference,created_at,allocations');
  for (const x of r.revenue) {
    const al = x.allocations.map((a) => `${a.step}:${a.total}`).join(' | ');
    L.push([x.id, esc(x.revenue_type), x.amount, x.reconciled, esc(x.reference), esc(x.created_at), esc(al)].join(','));
  }
  return L.join('\n');
}

async function prepareRevenueRegisterPdf(projectId, { userId, role }) {
  const r = await getRevenueRegister(projectId, { userId, role });
  const p = await getProject(projectId);
  return { ...r, currency: p.currency_code || 'TZS' };
}

function renderRevenueRegisterPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;
  const ensure = () => { if (doc.y > 760) doc.addPage(); };

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('REJESTA YA UCHAKATAJI WA MAPATO (Revenue Processing Register)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`${v.project.name}  (${v.project.id})  ·  ${v.project.status}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Muhtasari / Summary');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Mapato yaliyochakatwa / Revenue processed', m(v.summary.revenue_total));
  voucherField(doc, 'Yaliyogawiwa / Allocated total', m(v.summary.allocated_total));
  voucherField(doc, 'Ulinganifu wa mgawanyo / Allocation parity', v.summary.allocation_parity ? 'OK' : 'MISMATCH');
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text(`Mapato / Revenue Batches (${v.revenue.length})`);
  vline(doc, doc.y + 2);
  for (const x of v.revenue) {
    ensure();
    doc.fontSize(8.5).fillColor('#111').text(`#${x.id}  ·  ${x.revenue_type}  ·  ${m(x.amount)}  ·  ${x.reconciled ? 'RECONCILED' : 'OPEN'}  ·  ref ${x.reference || '—'}  ·  ${new Date(x.created_at).toISOString()}`);
    if (x.allocations.length) {
      doc.fontSize(7).fillColor('#555').text(`   Mgawanyo: ${x.allocations.map((a) => `${a.step} ${m(a.total)}`).join(' · ')}`);
    }
  }

  ensure();
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.moveDown(1.6);
  doc.moveTo(120, doc.y).lineTo(320, doc.y).stroke('#aaa');
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.end();
  return doc;
}

// ============================================================================
// PHASE 25 — WATERFALL RULES GOVERNANCE RECORD
// ============================================================================

async function getWaterfallGovernance(projectId, { userId, role }) {
  const p = await getProject(projectId);
  const isOwner = p.owner_user_id === userId;
  if (!isOwner && !isExpert(role)) {
    throw new ValidityError('Huna ruhusa ya rekodi ya utawala wa sheria za mgawanyo.', 403);
  }
  const rules = await pool.query(
    `SELECT r.*, p1.full_name AS proposed_by_name, p1.phone_number AS proposed_by_phone,
            p2.full_name AS approved_by_name, p2.phone_number AS approved_by_phone
     FROM waterfall_allocation_rules r
     LEFT JOIN users p1 ON p1.id = r.proposed_by
     LEFT JOIN users p2 ON p2.id = r.approved_by
     WHERE r.project_id = $1 ORDER BY r.version`, [projectId]
  );
  const usage = await pool.query(
    `SELECT rule_id, COUNT(*)::int AS revenue_runs, COUNT(DISTINCT revenue_reference)::int AS revenue_batches
     FROM waterfall_allocation_records WHERE project_id = $1 GROUP BY rule_id`, [projectId]
  );
  const usageById = {};
  for (const u of usage.rows) usageById[u.rule_id] = u;
  const STEPS = WATERFALL_STEPS.map((s) => s.column);
  const versions = rules.rows.map((r) => {
    const rule = { ...r };
    const superseded = rules.rows.find((x) => x.id === r.supersedes_rule_id);
    const diffs = [];
    if (superseded) {
      for (const col of STEPS) {
        if (Number(r[col] || 0) !== Number(superseded[col] || 0)) {
          diffs.push(`${col}: ${Number(superseded[col] || 0)}% -> ${Number(r[col] || 0)}%`);
        }
      }
    }
    return {
      id: r.id, version: r.version, status: r.status,
      allocations: Object.fromEntries(STEPS.map((c) => [c, Number(r[c] || 0)])),
      proposed_by: r.proposed_by ? { id: r.proposed_by, name: r.proposed_by_name, phone_number: r.proposed_by_phone } : null,
      proposed_at: r.proposed_at,
      approved_by: r.approved_by ? { id: r.approved_by, name: r.approved_by_name, phone_number: r.approved_by_phone } : null,
      approved_at: r.approved_at,
      effective_at: r.effective_at,
      supersedes_rule_id: r.supersedes_rule_id,
      change_reason: r.change_reason,
      usage: usageById[r.id] || { revenue_runs: 0, revenue_batches: 0 },
      diff_vs_previous: diffs,
    };
  });
  const current = versions.find((v) => v.status === 'FROZEN' || v.status === 'ACTIVE');
  return {
    success: true,
    project: { id: p.id, name: p.name, status: p.status },
    currency: p.currency_code || 'TZS',
    generated_at: new Date().toISOString(),
    summary: {
      versions: versions.length,
      current_version: current ? current.version : null,
      current_status: current ? current.status : 'NONE',
      frozen: !!current,
    },
    versions,
  };
}

async function exportWaterfallGovernanceCsv(projectId, { userId, role }) {
  const r = await getWaterfallGovernance(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Project,${esc(r.project.name)} (${r.project.id})`);
  L.push(`Status,${r.project.status}`);
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push(`Versions,${r.summary.versions}`);
  L.push(`Current version,${r.summary.current_version} (${r.summary.current_status})`);
  L.push('');
  L.push('version,status,proposed_by,proposed_at,approved_by,approved_at,effective_at,supersedes,change_reason,revenue_batches,revenue_runs,allocations,diff_vs_previous');
  for (const v of r.versions) {
    L.push([
      v.version, esc(v.status),
      v.proposed_by ? esc(`${v.proposed_by.name} (${v.proposed_by.phone_number})`) : '',
      esc(v.proposed_at || ''), v.approved_by ? esc(`${v.approved_by.name} (${v.approved_by.phone_number})`) : '',
      esc(v.approved_at || ''), esc(v.effective_at || ''),
      v.supersedes_rule_id || '', esc(v.change_reason || ''),
      v.usage.revenue_batches, v.usage.revenue_runs,
      esc(WATERFALL_STEPS.map((s) => `${s.column}:${v.allocations[s.column]}%`).join(' ')),
      esc(v.diff_vs_previous.join(' | ')),
    ].join(','));
  }
  return L.join('\n');
}

async function prepareWaterfallGovernancePdf(projectId, { userId, role }) {
  const r = await getWaterfallGovernance(projectId, { userId, role });
  const p = await getProject(projectId);
  return { ...r, currency: p.currency_code || 'TZS' };
}

function renderWaterfallGovernancePdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;
  const ensure = () => { if (doc.y > 760) doc.addPage(); };

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('REKODI YA UTAWALA WA SHERIA ZA MGAWANYO (Waterfall Rules Governance)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`${v.project.name}  (${v.project.id})  ·  ${v.project.status}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Muhtasari / Summary');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Matoleo / Versions', String(v.summary.versions));
  voucherField(doc, 'Toleo la sasa / Current', v.summary.current_version ? `v${v.summary.current_version} (${v.summary.current_status})` : '—');
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text(`Sheria za mgawanyo / Allocation Rules (${v.versions.length})`);
  vline(doc, doc.y + 2);
  for (const x of v.versions) {
    ensure();
    doc.fontSize(9).fillColor('#111').text(`v${x.version}  ·  ${x.status}${x.supersedes_rule_id ? `  ·  supersedes v${x.supersedes_rule_id}` : ''}`);
    doc.fontSize(7.5).fillColor('#444').text('   ' + WATERFALL_STEPS.map((s) => `${s.column} ${x.allocations[s.column]}%`).join(' · '));
    if (x.proposed_at) doc.fontSize(7).fillColor('#555').text(`   Iliyopendekezwa na ${x.proposed_by ? x.proposed_by.name + ' (' + x.proposed_by.phone_number + ')' : '—'}  ·  ${new Date(x.proposed_at).toISOString()}`);
    if (x.approved_at) doc.fontSize(7).fillColor('#0B5D1E').text(`   Iliidhinishwa na ${x.approved_by ? x.approved_by.name + ' (' + x.approved_by.phone_number + ')' : '—'}  ·  ${new Date(x.approved_at).toISOString()}`);
    if (x.change_reason) doc.fontSize(7).fillColor('#555').text(`   Sababu ya mabadiliko: ${x.change_reason}`);
    if (x.usage.revenue_batches) doc.fontSize(7).fillColor('#555').text(`   Imetumika: ${x.usage.revenue_batches} batches / ${x.usage.revenue_runs} runs`);
    if (x.diff_vs_previous.length) doc.fontSize(7).fillColor('#B26A00').text(`   Mabadiliko: ${x.diff_vs_previous.join(' · ')}`);
  }

  ensure();
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center' });
  doc.moveDown(1.6);
  doc.moveTo(120, doc.y).lineTo(320, doc.y).stroke('#aaa');
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.end();
  return doc;
}

// ============================================================================
// PHASE 23 — DRAWDOWN SCHEDULE DOCUMENT + PLATFORM DIVIDEND LEDGER
// ============================================================================

async function getDrawdownSchedule(projectId, { userId, role }) {
  const ld = await listDrawdowns(projectId, { userId, role });
  const milestoneRes = await pool.query(
    `SELECT id, name FROM project_milestones WHERE project_id = $1`, [projectId]
  );
  const msName = {};
  for (const ms of milestoneRes.rows) msName[ms.id] = ms.name;
  return {
    success: true,
    project: ld.project,
    plan: ld.plan,
    generated_at: new Date().toISOString(),
    progress: ld.progress,
    tranches: ld.tranches.map((t) => ({
      id: t.id, sequence: t.sequence, amount: Number(t.amount),
      milestone_id: t.milestone_id, milestone_name: msName[t.milestone_id] || '—',
      status: t.status, disbursement_reference: t.disbursement_reference,
      requested_at: t.requested_at,
    })),
  };
}

async function exportDrawdownScheduleCsv(projectId, { userId, role }) {
  const r = await getDrawdownSchedule(projectId, { userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Project,${esc(r.project.name)} (${r.project.id})`);
  L.push(`Status,${r.project.status}`);
  L.push(`Plan total,${r.plan ? r.plan.total_amount : ''}`);
  L.push(`Released,${r.progress.released_total}`);
  L.push(`Outstanding,${r.progress.pending_total}`);
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push('');
  L.push('sequence,amount,milestone,status,disbursement_reference,requested_at');
  for (const t of r.tranches) {
    L.push([t.sequence, t.amount, esc(t.milestone_name), esc(t.status),
            esc(t.disbursement_reference || ''), esc(t.requested_at || '')].join(','));
  }
  return L.join('\n');
}

async function prepareDrawdownPlanPdf(projectId, { userId, role }) {
  const r = await getDrawdownSchedule(projectId, { userId, role });
  const p = await getProject(projectId);
  return { ...r, currency: p.currency_code || 'TZS' };
}

function renderDrawdownPlanPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;
  const ensure = () => { if (doc.y > 760) doc.addPage(); };

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('RATIBA YA DRAWDOWN / MALIPO (Drawdown Schedule)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`${v.project.name}  (${v.project.id})  ·  ${v.project.status}  ·  Imetolewa: ${new Date(v.generated_at).toISOString()}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Plan');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Jumla ya plan / Plan total', v.plan ? m(Number(v.plan.total_amount || 0)) : '—');
  voucherField(doc, 'Imetolewa / Released', m(v.progress.released_total));
  voucherField(doc, 'Inasubiri / Outstanding', m(v.progress.pending_total));
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text(`Tranches / Schedules (${v.tranches.length})`);
  vline(doc, doc.y + 2);
  for (const t of v.tranches) {
    ensure();
    doc.fontSize(8).fillColor('#111').text(`#${t.sequence}  ·  ${m(t.amount)}  ·  ${t.status}  ·  ${t.milestone_name}`);
    doc.fontSize(7).fillColor('#555').text(`   ref ${t.disbursement_reference || '—'}  ·  requested ${t.requested_at ? new Date(t.requested_at).toISOString() : '—'}`);
  }

  ensure();
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.moveDown(1.6);
  doc.moveTo(120, doc.y).lineTo(320, doc.y).stroke('#aaa');
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.end();
  return doc;
}

async function getPlatformDividendLedger({ userId, role }) {
  if (!isExpert(role)) {
    throw new ValidityError('Huna mamlaka ya daftari la jumla la dividend.', 403);
  }
  const pay = await pool.query(
    `SELECT pa.id, pa.investor_user_id, u.full_name, u.phone_number,
            pa.project_id, p.name AS project_name,
            pa.entitlement, pa.status, pa.payout_reference, pa.paid_at, pa.created_at
     FROM project_investor_payouts pa
     JOIN users u ON u.id = pa.investor_user_id
     JOIN projects p ON p.id = pa.project_id
     ORDER BY pa.id`
  );
  const totals = await pool.query(
    `SELECT COALESCE(SUM(entitlement) FILTER (WHERE status='PAID'),0)::numeric AS paid,
            COALESCE(SUM(entitlement) FILTER (WHERE status='PENDING'),0)::numeric AS pending,
            COUNT(*)::int AS count
     FROM project_investor_payouts`
  );
  const byInv = await pool.query(
    `SELECT pa.investor_user_id, u.full_name, u.phone_number,
            COALESCE(SUM(pa.entitlement) FILTER (WHERE pa.status='PAID'),0)::numeric AS paid,
            COALESCE(SUM(pa.entitlement) FILTER (WHERE pa.status='PENDING'),0)::numeric AS pending
     FROM project_investor_payouts pa JOIN users u ON u.id = pa.investor_user_id
     GROUP BY pa.investor_user_id, u.full_name, u.phone_number
     ORDER BY u.full_name`
  );
  return {
    success: true,
    generated_at: new Date().toISOString(),
    totals: { paid: round2(Number(totals.rows[0].paid || 0)), pending: round2(Number(totals.rows[0].pending || 0)), count: Number(totals.rows[0].count) },
    per_investor: byInv.rows.map((x) => ({ investor_user_id: x.investor_user_id, full_name: x.full_name, phone_number: x.phone_number, paid: round2(Number(x.paid || 0)), pending: round2(Number(x.pending || 0)) })),
    payouts: pay.rows.map((x) => ({
      id: x.id, investor_user_id: x.investor_user_id, full_name: x.full_name, phone_number: x.phone_number,
      project_id: x.project_id, project_name: x.project_name,
      entitlement: round2(Number(x.entitlement || 0)), status: x.status,
      payout_reference: x.payout_reference, paid_at: x.paid_at, created_at: x.created_at,
    })),
  };
}

async function exportPlatformDividendLedgerCsv({ userId, role }) {
  const r = await getPlatformDividendLedger({ userId, role });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const L = [];
  L.push(`Generated at,${esc(r.generated_at)}`);
  L.push(`Dividends paid (platform),${r.totals.paid}`);
  L.push(`Dividends pending (platform),${r.totals.pending}`);
  L.push(`Payout records,${r.totals.count}`);
  L.push('');
  L.push('investor,phone,invested side:project,project_id,entitlement,status,payout_reference,paid_at');
  for (const x of r.payouts) {
    L.push([esc(x.full_name), esc(x.phone_number), esc(x.project_name), x.project_id, x.entitlement,
            esc(x.status), esc(x.payout_reference || ''), esc(x.paid_at || '')].join(','));
  }
  return L.join('\n');
}

async function preparePlatformDividendLedgerPdf({ userId, role }) {
  const r = await getPlatformDividendLedger({ userId, role });
  return { ...r, currency: 'TZS' };
}

function renderPlatformDividendLedgerPdf(v, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);
  const G = '#0B5D1E';
  const m = (n) => `${formatMoney(n)} ${v.currency}`;
  const ensure = () => { if (doc.y > 760) doc.addPage(); };

  doc.fontSize(17).fillColor(G).text('AFRIKOBA GLOBAL', { align: 'center' });
  doc.fontSize(11).fillColor('#333').text('DAFTARI LA JUMLA LA DIVIDEND (Platform Dividend Ledger)', { align: 'center' });
  doc.fontSize(8).fillColor('#888').text(`Imetolewa: ${new Date(v.generated_at).toISOString()}  ·  Sarafu: ${v.currency}`, { align: 'center' });
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);

  doc.fontSize(10).fillColor(G).text('Jumla / Totals');
  vline(doc, doc.y + 2);
  voucherField(doc, 'Dividendi zilizolipwa (mfumo mzima) / Dividends paid', m(v.totals.paid));
  voucherField(doc, 'Dividendi zinazosubiri / Dividends pending', m(v.totals.pending));
  voucherField(doc, 'Rekodi za malipo / Payout records', String(v.totals.count));
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text('Kwa Mwekezaji / Per Investor (Platform)');
  vline(doc, doc.y + 2);
  v.per_investor.forEach((x) => voucherField(doc, x.full_name, `paid ${m(x.paid)}  ·  pending ${m(x.pending)}`));
  doc.moveDown(0.3);

  doc.fontSize(10).fillColor(G).text(`Malipo / Payouts (${v.payouts.length})`);
  vline(doc, doc.y + 2);
  for (const x of v.payouts) {
    ensure();
    doc.fontSize(8).fillColor('#111').text(`#${x.id}  ·  ${x.full_name}  ·  ${x.project_name}  ·  ${m(x.entitlement)}  ·  ${x.status}${x.paid_at ? '  ·  ' + new Date(x.paid_at).toISOString() : ''}`);
    doc.fontSize(7).fillColor('#555').text(`   ref ${x.payout_reference || '—'}`);
  }

  ensure();
  doc.moveDown(0.5);
  vline(doc, doc.y + 4);
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.moveDown(1.6);
  doc.moveTo(120, doc.y).lineTo(320, doc.y).stroke('#aaa');
  doc.fontSize(8).fillColor('#888').text('Mkaguzi Mkuu (Reviewer)', { align: 'center', width: 200, lineBreak: false });
  doc.end();
  return doc;
}

module.exports = {
  ACCOUNTS,
  WATERFALL_STEPS,
  isExpert,
  onFundingReceived,
  listWaterfallRules,
  createInitialRules,
  proposeWaterfallRules,
  approveWaterfallRule,
  freezeWaterfallRule,
  unfreezeWaterfallRule,
  processIncomingRevenue,
  listRevenueTransactions,
  listRevenueAllocations,
  submitMilestoneProof,
  listMilestoneEvidence,
  reviewMilestone,
  requestDisbursement,
  reviewDisbursement,
  approveDisbursement,
  rejectDisbursement,
  executeDisbursement,
  listDisbursementRequests,
  addProjectDocument,
  listProjectDocuments,
  getProjectDocument,
  deleteProjectDocument,
  getAiReview,
  runAiReview,
  payConsultationFee,
  listConsultations,
  listProjectsForReview,
  getAuditTrail,
  listDividendPayouts,
  payProjectDividends,
  getProjectTransparency,
  getMyTransparency,
  completeProject,
  getSettlementReport,
  getMyPerformance,
  releaseOwnerReserve,
  releaseOwnerResidual,
  getCloseOutReport,
  getProjectStatement,
  exportProjectStatementCsv,
  getLiquidationReport,
  liquidateProject,
  getPersonalReceipt,
  exportPersonalReceiptCsv,
  exportMyPerformanceCsv,
  getProjectLedger,
  createDrawdownPlan,
  updateDrawdownPlan,
  listDrawdowns,
  requestTranche,
  exportCloseOutReportCsv,
  exportLiquidationCsv,
  getPlatformPfeBook,
  exportPlatformPfeBookCsv,
  forceCloseFunding,
  getInvestorStatement,
  exportInvestorStatementCsv,
  getDisbursementVoucher,
  renderDisbursementVoucherPdf,
  prepareSettlementPdf,
  renderSettlementReportPdf,
  renderPersonalReceiptPdf,
  prepareLiquidationPdf,
  renderLiquidationReportPdf,
  prepareCloseOutPdf,
  renderCloseOutReportPdf,
  getWaterfallLedger,
  exportWaterfallLedgerCsv,
  prepareWaterfallLedgerPdf,
  renderWaterfallLedgerPdf,
  prepareOpsBookPdf,
  renderOpsBookPdf,
  getPayoutRegister,
  exportPayoutRegisterCsv,
  preparePayoutRegisterPdf,
  renderPayoutRegisterPdf,
  getEscrowProjection,
  exportEscrowProjectionCsv,
  getDrawdownSchedule,
  exportDrawdownScheduleCsv,
  prepareDrawdownPlanPdf,
  renderDrawdownPlanPdf,
  getPlatformDividendLedger,
  exportPlatformDividendLedgerCsv,
  preparePlatformDividendLedgerPdf,
  renderPlatformDividendLedgerPdf,
  getMilestoneRegister,
  exportMilestoneRegisterCsv,
  prepareMilestoneRegisterPdf,
  renderMilestoneRegisterPdf,
  getRevenueRegister,
  exportRevenueRegisterCsv,
  prepareRevenueRegisterPdf,
  renderRevenueRegisterPdf,
  getWaterfallGovernance,
  exportWaterfallGovernanceCsv,
  prepareWaterfallGovernancePdf,
  renderWaterfallGovernancePdf,
};