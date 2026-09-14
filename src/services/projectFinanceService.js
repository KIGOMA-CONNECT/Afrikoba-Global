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

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
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
    `SELECT i.id AS investment_id, i.project_id, p.name, p.status AS project_status,
            p.capital_required, p.amount_raised, i.amount AS invested,
            i.participation_pct, i.status AS investment_status,
            i.refund_reference, i.refunded_at, i.created_at AS invested_at,
            COALESCE(pp.total_pending, 0)::numeric AS pending_total,
            COALESCE(pa.total_paid, 0)::numeric AS paid_total
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
     WHERE i.investor_user_id = $1
     ORDER BY i.id DESC`,
    [userId]
  );
  const rows = r.rows.map((x) => {
    const invested = Number(x.invested || 0);
    const paid = Number(x.paid_total || 0);
    const refunded = x.refunded_at ? invested : 0;
    const received = round2(paid + refunded);
    const roi = invested > 0 ? round2(((received - invested) / invested) * 100) : 0;
    const percent_funded = (x.capital_required && Number(x.capital_required) > 0)
      ? round2((Number(x.amount_raised) / Number(x.capital_required)) * 100) : 0;
    return {
      ...x,
      invested: round2(invested),
      received: round2(received),
      pending_total: round2(Number(x.pending_total || 0)),
      paid_total: round2(paid),
      refunded_amount: round2(refunded),
      roi_percent: roi,
      percent_funded,
    };
  });
  const totals = rows.reduce((acc, x) => {
    acc.invested = round2(acc.invested + x.invested);
    acc.received = round2(acc.received + x.received);
    acc.pending = round2(acc.pending + Number(x.pending_total || 0));
    return acc;
  }, { invested: 0, received: 0, pending: 0 });
  totals.roi_percent = totals.invested > 0 ? round2(((totals.received - totals.invested) / totals.invested) * 100) : 0;
  return { totals, investments: rows };
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
    });

    await client.query('COMMIT');

    await createNotification(p.owner_user_id, {
      title: meta.title,
      body: meta.body(p.name, amount),
      type: 'PROJECT', entityType: 'PROJECT', entityId: projectId,
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
    investors: investorPositions,
    waterfall: waterfall.rows,
    milestones: milestones.rows,
    milestone_total: milestones.rows.length,
    milestone_completed: milestones.rows.filter((m) => m.status === 'COMPLETED').length,
  };
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
};