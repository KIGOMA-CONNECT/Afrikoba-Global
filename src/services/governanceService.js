/**
 * Governance Service
 * Four-eyes RBAC (maker-checker approval flows) + AML case management
 * on top of fraud alerts.
 */

const pool = require('../config/db');

// ===== FOUR-EYES RBAC (maker-checker) =====

async function createApprovalFlow({ requesterId, actionType, refType, refId, data }) {
  const result = await pool.query(
    `INSERT INTO approval_flows (action_type, ref_type, ref_id, requester_id, data)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [actionType, refType || null, refId || null, requesterId, JSON.stringify(data || {})]
  );
  return result.rows[0];
}

async function listApprovalFlows(status = null, limit = 100) {
  let query = `SELECT af.*, u.full_name AS requester_name, u.phone_number AS requester_phone
               FROM approval_flows af JOIN users u ON af.requester_id = u.id`;
  const params = [];
  if (status) { query += ` WHERE af.status = $1`; params.push(status); }
  query += ` ORDER BY af.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const result = await pool.query(query, params);
  return result.rows;
}

async function decideApprovalFlow(flowId, approverId, action, comment) {
  if (!['APPROVE', 'REJECT'].includes(action)) throw new Error('Hatua si sahihi.');

  const flow = await pool.query(`SELECT * FROM approval_flows WHERE id = $1`, [flowId]);
  if (flow.rows.length === 0) throw new Error('Ombi la idhini halipatikani.');
  const f = flow.rows[0];
  if (f.status !== 'PENDING') throw new Error('Ombi hili tayari limeamuliwa.');
  if (f.requester_id === approverId) throw new Error('Huwezi kuidhinisha ombi lako mwenyewe (four-eyes).');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO approval_actions (flow_id, approver_id, action, comment) VALUES ($1, $2, $3, $4)`,
      [flowId, approverId, action, comment || null]
    );
    await client.query(
      `UPDATE approval_flows SET status = $1, decided_at = NOW() WHERE id = $2`,
      [action === 'APPROVE' ? 'APPROVED' : 'REJECTED', flowId]
    );
    await client.query('COMMIT');
    return (await pool.query(`SELECT * FROM approval_flows WHERE id = $1`, [flowId])).rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ===== AML CASE MANAGEMENT =====

async function openAmlCase({ alertId, userId, caseType, riskLevel, summary, assignedTo, authorId }) {
  const result = await pool.query(
    `INSERT INTO aml_cases (alert_id, user_id, case_type, risk_level, assigned_to, summary)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [alertId || null, userId || null, caseType || 'SUSPICIOUS_ACTIVITY', riskLevel || 'MEDIUM', assignedTo || null, summary || null]
  );
  if (alertId) {
    await pool.query(`UPDATE fraud_alerts SET is_resolved = TRUE, resolved_by = $1, resolved_at = NOW() WHERE id = $2`, [authorId, alertId]);
  }
  return result.rows[0];
}

async function listAmlCases(status = null, limit = 100) {
  let query = `SELECT c.*, u.full_name AS user_name, u.phone_number AS user_phone,
                      a.full_name AS assigned_name
               FROM aml_cases c
               LEFT JOIN users u ON c.user_id = u.id
               LEFT JOIN users a ON c.assigned_to = a.id`;
  const params = [];
  if (status) { query += ` WHERE c.status = $1`; params.push(status); }
  query += ` ORDER BY c.updated_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const result = await pool.query(query, params);
  return result.rows;
}

async function getAmlCase(caseId) {
  const c = await pool.query(
    `SELECT c.*, u.full_name AS user_name, u.phone_number AS user_phone, a.full_name AS assigned_name
     FROM aml_cases c
     LEFT JOIN users u ON c.user_id = u.id
     LEFT JOIN users a ON c.assigned_to = a.id
     WHERE c.id = $1`,
    [caseId]
  );
  if (c.rows.length === 0) throw new Error('Kesi haipatikani.');
  const notes = await pool.query(
    `SELECT n.*, u.full_name AS author_name FROM aml_case_notes n
     LEFT JOIN users u ON n.author_id = u.id WHERE n.case_id = $1 ORDER BY n.created_at DESC`,
    [caseId]
  );
  return { case: c.rows[0], notes: notes.rows };
}

async function updateAmlCase(caseId, authorId, { status, assignedTo, riskLevel, disposition }) {
  const sets = [];
  const params = [];
  if (status) { params.push(status); sets.push(`status = $${params.length}`); }
  if (assignedTo !== undefined) { params.push(assignedTo); sets.push(`assigned_to = $${params.length}`); }
  if (riskLevel) { params.push(riskLevel); sets.push(`risk_level = $${params.length}`); }
  if (disposition !== undefined) { params.push(disposition); sets.push(`disposition = $${params.length}`); }
  if (sets.length === 0) throw new Error('Hakuna mabadiliko.');
  params.push(new Date()); sets.push(`updated_at = $${params.length}`);
  params.push(caseId);
  const result = await pool.query(
    `UPDATE aml_cases SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return result.rows[0];
}

async function addAmlNote(caseId, authorId, note) {
  const result = await pool.query(
    `INSERT INTO aml_case_notes (case_id, author_id, note) VALUES ($1, $2, $3) RETURNING *`,
    [caseId, authorId, note]
  );
  return result.rows[0];
}

module.exports = {
  createApprovalFlow,
  listApprovalFlows,
  decideApprovalFlow,
  openAmlCase,
  listAmlCases,
  getAmlCase,
  updateAmlCase,
  addAmlNote,
};
