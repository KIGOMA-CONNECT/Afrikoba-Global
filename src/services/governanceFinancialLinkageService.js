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
 * R35 (2), owner decision D-S5-7 (= R31-1 A1). A VICOBA loan now needs three different people:
 * the member submits their own request, then Katibu, Mhasibu and Mwenyekiti approve in turn
 * (R34 S5). One actor triggering a loan from a resolution cannot satisfy that chain, so this
 * entry point refuses with 409 VICOBA_LOAN_CHAIN_REQUIRED. The resource binding check stays first
 * (a foreign resolution is still refused as before). The refusal comes before any INSERT, any
 * governance_financial_executions row and any vicoba call: nothing is written, nothing is marked
 * FAILED.
 */
async function triggerVicobaLoan({ resolutionId, governance }) {
  await binding.assertResourceInContext('RESOLUTION', resolutionId, governance);
  throw Object.assign(
    new Error('Mkopo wa VICOBA unapitia ngazi tatu (Katibu, Mhasibu, Mwenyekiti); azimio haliwezi kuuanzisha na kuutoa moja kwa moja.'),
    { statusCode: 409, code: 'VICOBA_LOAN_CHAIN_REQUIRED' }
  );
}

module.exports = { createExecution, markExecuted, markFailed, listExecutions, getGovernanceAuditTrail, triggerVicobaLoan };
