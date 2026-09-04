/**
 * Governance → Financial Decision Linkage
 * Binds an approved governance resolution to its financial workflow execution and
 * ledger record, ensuring every financial action has an immutable governance
 * authorization ("hatuna tena: tuliamua lakini sijui nani alikubali").
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Register a financial execution intent against an approved resolution.
 * Returns the linkage record in PENDING state.
 */
async function createExecution({ resolutionId, groupId, financialActionType, targetEntityType, targetEntityId, amount, notes }) {
  const resolution = (await pool.query(
    'SELECT * FROM governance_resolutions WHERE id = $1',
    [resolutionId]
  )).rows[0];
  if (!resolution) throw Object.assign(new Error('Maazimio halipatikani'), { statusCode: 404 });

  const res = await pool.query(
    `INSERT INTO governance_financial_executions
       (resolution_id, group_id, financial_action_type, target_entity_type, target_entity_id, amount, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING') RETURNING *`,
    [resolutionId, groupId, financialActionType, targetEntityType || null, targetEntityId || null, amount, notes || null]
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
async function markExecuted(executionId, { ledgerReference, executedByUserId }) {
  const res = await pool.query(
    `UPDATE governance_financial_executions
        SET status='EXECUTED', ledger_reference=$2, executed_by=$3, executed_at=NOW()
      WHERE id=$1 RETURNING *`,
    [executionId, ledgerReference || null, executedByUserId || null]
  );
  return res.rows[0];
}

async function markFailed(executionId, notes) {
  const res = await pool.query(
    `UPDATE governance_financial_executions SET status='FAILED', notes=COALESCE(notes,'') || E'\n' || $2 WHERE id=$1 RETURNING *`,
    [executionId, notes || '']
  );
  return res.rows[0];
}

/**
 * List financial executions optionally filtered by resolution or group.
 */
async function listExecutions({ resolutionId, groupId, status } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (resolutionId) { params.push(resolutionId); where += ` AND resolution_id=$${params.length}`; }
  if (groupId) { params.push(groupId); where += ` AND group_id=$${params.length}`; }
  if (status) { params.push(status); where += ` AND status=$${params.length}`; }
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
 * Fetch the full governance → financial audit trail for a group,
 * linking resolutions to their executions and ledger references.
 */
async function getGovernanceAuditTrail(groupId) {
  const res = await pool.query(
    `SELECT r.id AS resolution_id, r.resolution_number, r.title, r.body, r.passed_at, r.financial_action_type,
            r.financial_amount, e.id AS execution_id, e.status AS execution_status, e.ledger_reference,
            e.target_entity_type, e.target_entity_id, e.executed_at
     FROM governance_resolutions r
     LEFT JOIN governance_financial_executions e ON e.resolution_id = r.id
     WHERE r.group_id = $1 AND r.financial_action_type IS NOT NULL
     ORDER BY r.passed_at DESC`,
    [groupId]
  );
  return res.rows;
}

module.exports = { createExecution, markExecuted, markFailed, listExecutions, getGovernanceAuditTrail };
