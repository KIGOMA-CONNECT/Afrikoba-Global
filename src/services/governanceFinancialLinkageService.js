/**
 * Governance → Financial Decision Linkage
 * Binds an approved governance resolution to its financial workflow execution and
 * ledger record, ensuring every financial action has an immutable governance
 * authorization ("hatuna tena: tuliamua lakini sijui nani alikubali").
 *
 * D4 — defense in depth. The HTTP layer (governanceRoutes + the G2 resource
 * binding middleware) already refuses a cross-group resource before any handler
 * runs, but that boundary only exists for callers who go through it. Every
 * entry point below therefore re-derives canonical ownership for itself and
 * refuses on its own, so bypassing the router does not bypass the rule.
 *
 * Two invariants hold here, in this order:
 *   1. the resource belongs to the group context the caller is acting as
 *      (authorize, then mutate — never the other way round);
 *   2. an execution agrees with the resolution it claims to implement.
 *
 * `groupId` supplied by a client is never written: the INSERT takes the group
 * read back off the resolution row.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');
const { createAppError } = require('../utils/errorCodes');
const binding = require('./governanceResourceBindingService');

/**
 * Register a financial execution intent against an approved resolution.
 * Returns the linkage record in PENDING state.
 */
async function createExecution({ resolutionId, groupId, financialActionType, targetEntityType, targetEntityId, amount, notes, governance }) {
  const canonical = await binding.assertResourceInContext('RESOLUTION', resolutionId, governance);
  const canonicalGroupId = Number(canonical.groupId);

  const res = await pool.query(
    `INSERT INTO governance_financial_executions
       (resolution_id, group_id, financial_action_type, target_entity_type, target_entity_id, amount, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING') RETURNING *`,
    [resolutionId, canonicalGroupId, financialActionType, targetEntityType || null, targetEntityId || null, amount, notes || null]
  );
  const execution = res.rows[0];

  // Mark the resolution as linked to a workflow
  await pool.query(
    `UPDATE governance_resolutions SET linked_to_workflow=TRUE WHERE id=$1`,
    [resolutionId]
  );

  logger.info('GOV_FIN', `Financial execution registered for resolution ${resolutionId} (${financialActionType})`);
  return { success: true, execution };
}

/**
 * Finalize an execution with a ledger reference (mark EXECUTED).
 */
async function markExecuted(executionId, { ledgerReference, executedByUserId, governance }) {
  await binding.assertResourceInContext('EXECUTION', executionId, governance);
  const res = await pool.query(
    `UPDATE governance_financial_executions
        SET status='EXECUTED', ledger_reference=$2, executed_by=$3, executed_at=NOW()
      WHERE id=$1 RETURNING *`,
    [executionId, ledgerReference || null, executedByUserId || null]
  );
  if (!res.rows[0]) throw createAppError('GOV_RESOURCE_NOT_FOUND');
  return res.rows[0];
}

async function markFailed(executionId, notes, governance) {
  await binding.assertResourceInContext('EXECUTION', executionId, governance);
  const res = await pool.query(
    `UPDATE governance_financial_executions SET status='FAILED', notes=COALESCE(notes,'') || E'\n' || $2 WHERE id=$1 RETURNING *`,
    [executionId, notes || '']
  );
  if (!res.rows[0]) throw createAppError('GOV_RESOURCE_NOT_FOUND');
  return res.rows[0];
}

/**
 * List financial executions optionally filtered by resolution or status.
 *
 * The result set is always scoped to the group the caller was validated for,
 * matched on family AND id. `governance_financial_executions` has no group_type
 * column of its own (migration 061), so the type check is carried by the
 * resolution it joins — filtering on `e.group_id` alone would mix a VICOBA
 * group 8 with a SACCO group 8.
 */
async function listExecutions({ resolutionId, status, governance } = {}) {
  binding.requireContext(governance);
  const aliases = binding.familyAliases(governance.groupType);
  if (!aliases) throw createAppError('GOV_GROUP_TYPE_UNSUPPORTED', { groupType: governance.groupType });

  const params = [];
  let where = 'WHERE 1=1';
  if (resolutionId) { params.push(resolutionId); where += ` AND e.resolution_id=$${params.length}`; }
  if (status) { params.push(status); where += ` AND e.status=$${params.length}`; }
  params.push(aliases); where += ` AND UPPER(TRIM(r.group_type))=ANY($${params.length}::text[])`;
  params.push(Number(governance.groupId)); where += ` AND r.group_id=$${params.length}`;

  const res = await pool.query(
    `SELECT e.*, r.title AS resolution_title, r.resolution_number
     FROM governance_financial_executions e
     JOIN governance_resolutions r ON r.id = e.resolution_id
     ${where} ORDER BY e.created_at DESC`,
    params
  );
  return res.rows;
}

/**
 * Get the full governance → financial audit trail for a group,
 * linking resolutions to their executions and ledger references.
 */
async function getGovernanceAuditTrail(governance) {
  binding.requireContext(governance);
  const aliases = binding.familyAliases(governance.groupType);
  if (!aliases) throw createAppError('GOV_GROUP_TYPE_UNSUPPORTED', { groupType: governance.groupType });

  const res = await pool.query(
    `SELECT r.id AS resolution_id, r.resolution_number, r.title, r.body, r.passed_at, r.financial_action_type,
            r.financial_amount, e.id AS execution_id, e.status AS execution_status, e.ledger_reference,
            e.target_entity_type, e.target_entity_id, e.executed_at
     FROM governance_resolutions r
     LEFT JOIN governance_financial_executions e ON e.resolution_id = r.id
     WHERE UPPER(TRIM(r.group_type))=ANY($1::text[])
       AND r.group_id = $2
       AND r.financial_action_type IS NOT NULL
     ORDER BY r.passed_at DESC`,
    [aliases, Number(governance.groupId)]
  );
  return res.rows;
}

// ============ AUTO-TRIGGER VICOBA LOAN FROM RESOLUTION ============

/**
 * Given a passed resolution with financial_action_type='LOAN_APPROVAL',
 * auto-create the VICOBA loan workflow, disburse, and record the ledger reference.
 * Chain: Resolution (passed) -> createExecution (PENDING) -> loan request ->
 *        approval (treasurer) -> disbursement -> ledger -> markExecuted.
 */
async function triggerVicobaLoan({ actorUserId, resolutionId, groupId, applicantUserId, amount, interestRate, repaymentMonths, governance }) {
  const vicoba = require('./vicobaService');
  let executionId = null;
  try {
    // Before anything else: the resolution must belong to the group context,
    // or this chain must not start at all. A foreign resolution never reaches
    // the INSERT below, and therefore never reaches vicoba.requestLoan /
    // vicoba.approveLoan either. The client's `groupId` is deliberately not
    // used — the canonical group comes off the resolution row.
    const canonical = await binding.assertResourceInContext('RESOLUTION', resolutionId, governance);
    const canonicalGroupId = Number(canonical.groupId);

    const resolution = (await pool.query(
      'SELECT * FROM governance_resolutions WHERE id=$1',
      [resolutionId]
    )).rows[0];
    if (!resolution) throw createAppError('GOV_RESOURCE_NOT_FOUND');

    // 1. Register the financial execution intent (PENDING)
    const execRes = await pool.query(
      `INSERT INTO governance_financial_executions
         (resolution_id, group_id, financial_action_type, target_entity_type, amount, status, executed_by)
       VALUES ($1,$2,'LOAN_APPROVAL','VICOBA_LOAN',$3,'PENDING',$4) RETURNING *`,
      [resolutionId, canonicalGroupId, amount, actorUserId]
    );
    executionId = execRes.rows[0].id;

    // 2. Create the VICOBA loan request (chairman approval step, own tx)
    const loanRequest = await vicoba.requestLoan(actorUserId, {
      groupId: canonicalGroupId,
      applicantUserId,
      requestedAmount: amount,
      interestRate: interestRate || 10,
      repaymentMonths: repaymentMonths || 3,
    });
    const loanId = loanRequest.id;

    // 3. Approve the loan (treasurer step, own tx) -> disbursement + ledger transaction
    await vicoba.approveLoan(actorUserId, loanId, amount);
    const ledgerRef = `VL-${loanId}`;

    // 4. Mark execution EXECUTED with ledger reference
    await pool.query(
      `UPDATE governance_financial_executions
          SET status='EXECUTED', ledger_reference=$2, target_entity_id=$3, executed_at=NOW()
        WHERE id=$1`,
      [executionId, ledgerRef, loanId]
    );
    await pool.query(`UPDATE governance_resolutions SET linked_to_workflow=TRUE WHERE id=$1`, [resolutionId]);

    return { success: true, resolutionId, executionId, loanId, ledgerReference: ledgerRef };
  } catch (err) {
    // Best-effort mark failed. `executionId` is still null when the binding
    // check above threw, so a denied request performs no write at all.
    if (executionId) {
      await pool.query(`UPDATE governance_financial_executions SET status='FAILED' WHERE id=$1`, [executionId]).catch(() => {});
    }
    throw err;
  }
}

module.exports = { createExecution, markExecuted, markFailed, listExecutions, getGovernanceAuditTrail, triggerVicobaLoan };
