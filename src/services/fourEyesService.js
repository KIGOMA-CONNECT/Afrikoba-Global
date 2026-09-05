/* ============================================================
 * Role-based four-eyes (maker-checker with role enforcement).
 * A sensitive admin action is posted as a request (maker); a
 * distinct approver holding one of the policy's allowed roles
 * must APPROVE (checker). On quorum the registered executor
 * runs the real operation atomically. No self-approval unless
 * the policy explicitly allows it.
 * ============================================================ */
const pool = require('../config/db');

const executors = {};

function registerExecutor(actionCode, fn) {
  executors[actionCode] = fn;
}

async function getPolicy(actionCode) {
  const r = await pool.query('SELECT * FROM four_eyes_policies WHERE action_code = $1', [actionCode]);
  if (r.rows.length === 0) throw Object.assign(new Error('Sera ya four-eyes haijapatikana.'), { status: 404 });
  if (!r.rows[0].enabled) throw Object.assign(new Error('Sera hii imezimwa.'), { status: 403 });
  return r.rows[0];
}

async function listPolicies() {
  const r = await pool.query('SELECT * FROM four_eyes_policies ORDER BY action_code');
  return r.rows;
}

async function upsertPolicy({ actionCode, description, requiredApprovers, approverRoles, enabled, allowSelfApprove }) {
  const code = String(actionCode || '').trim();
  if (!code) throw Object.assign(new Error('actionCode inahitajika.'), { status: 400 });
  let base = { description: '', required_approvers: 1, approver_roles: ['ADMIN'], enabled: true, allow_self_approve: false };
  const existing = await pool.query('SELECT * FROM four_eyes_policies WHERE action_code = $1', [code]);
  if (existing.rows.length > 0) {
    const r = existing.rows[0];
    base = {
      description: r.description,
      required_approvers: r.required_approvers,
      approver_roles: r.approver_roles,
      enabled: r.enabled,
      allow_self_approve: r.allow_self_approve,
    };
  }
  const roles = Array.isArray(approverRoles) && approverRoles.length ? approverRoles : base.approver_roles;
  const required = requiredApprovers !== undefined && requiredApprovers !== null
    ? Math.max(1, Math.min(3, Number(requiredApprovers) || 1))
    : base.required_approvers;
  const enabledVal = enabled !== undefined && enabled !== null ? Boolean(enabled) : base.enabled;
  const selfVal = allowSelfApprove !== undefined && allowSelfApprove !== null ? Boolean(allowSelfApprove) : base.allow_self_approve;
  const r = await pool.query(
    `INSERT INTO four_eyes_policies (action_code, description, required_approvers, approver_roles, enabled, allow_self_approve)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (action_code) DO UPDATE SET
       description = EXCLUDED.description, required_approvers = EXCLUDED.required_approvers,
       approver_roles = EXCLUDED.approver_roles, enabled = EXCLUDED.enabled,
       allow_self_approve = EXCLUDED.allow_self_approve, updated_at = NOW()
     RETURNING *`,
    [code, String(description ?? base.description), required, roles, enabledVal, selfVal]
  );
  return r.rows[0];
}

async function initiateRequest({ actionCode, requesterId, payload }) {
  const policy = await getPolicy(actionCode);
  const r = await pool.query(
    `INSERT INTO four_eyes_requests (action_code, requester_id, payload)
     VALUES ($1,$2,$3) RETURNING *`,
    [actionCode, requesterId, JSON.stringify(payload || {})]
  );
  const request = r.rows[0];
  return { request, policy };
}

async function getRequest(requestId) {
  const r = await pool.query(
    `SELECT r.*, u.full_name AS requester_name, u.phone_number AS requester_phone,
            p.description AS policy_description, p.required_approvers, p.approver_roles,
            p.enabled AS policy_enabled, p.allow_self_approve AS policy_allow_self_approve
       FROM four_eyes_requests r
       JOIN users u ON u.id = r.requester_id
       JOIN four_eyes_policies p ON p.action_code = r.action_code
      WHERE r.id = $1`,
    [requestId]
  );
  if (r.rows.length === 0) throw Object.assign(new Error('Ombi la four-eyes halijapatikana.'), { status: 404 });
  const req = r.rows[0];
  const policy = {
    action_code: req.action_code,
    description: req.policy_description,
    required_approvers: req.required_approvers,
    approver_roles: req.approver_roles,
    enabled: req.policy_enabled,
    allow_self_approve: req.policy_allow_self_approve,
  };
  const approvals = await pool.query(
    `SELECT a.*, u.full_name AS approver_name FROM four_eyes_approvals a
     LEFT JOIN users u ON u.id = a.approver_id
     WHERE a.request_id = $1 ORDER BY a.created_at ASC`,
    [requestId]
  );
  return { request: req, approvals: approvals.rows, policy };
}

async function listRequests(status = null, limit = 100) {
  let query = `SELECT r.*, u.full_name AS requester_name, u.phone_number AS requester_phone,
                      p.description AS policy_description
                 FROM four_eyes_requests r
                 JOIN users u ON u.id = r.requester_id
                 JOIN four_eyes_policies p ON p.action_code = r.action_code`;
  const params = [];
  if (status) { query += ` WHERE r.status = $1`; params.push(status); }
  query += ` ORDER BY r.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const r = await pool.query(query, params);
  return r.rows;
}

async function _countApprovals(requestId) {
  const r = await pool.query(
    `SELECT decision, COUNT(*)::int AS n FROM four_eyes_approvals
     WHERE request_id = $1 GROUP BY decision`,
    [requestId]
  );
  const n = { APPROVE: 0, REJECT: 0 };
  for (const row of r.rows) n[row.decision] = row.n;
  return n;
}

async function approve(requestId, approverId, role, note) {
  const { request, policy } = await getRequest(requestId);
  if (request.status !== 'PENDING') throw Object.assign(new Error('Ombi hili tayari limeamuliwa.'), { status: 409 });
  if (Number(request.requester_id) === Number(approverId) && !policy.allow_self_approve) {
    throw Object.assign(new Error('Huwezi kuidhinisha ombi lako mwenyewe (four-eyes).'), { status: 403 });
  }
  if (!policy.approver_roles.includes(role)) {
    throw Object.assign(new Error(`Jukumu "${role}" haliruhusiwi kuidhinisha hatua hii.`), { status: 403 });
  }
  const already = await pool.query(
    'SELECT id FROM four_eyes_approvals WHERE request_id = $1 AND approver_id = $2',
    [requestId, approverId]
  );
  if (already.rows.length > 0) throw Object.assign(new Error('Umeshathamini ombi hili.'), { status: 409 });

  await pool.query(
    `INSERT INTO four_eyes_approvals (request_id, approver_id, approver_role, decision, note)
     VALUES ($1,$2,$3,'APPROVE',$4)`,
    [requestId, approverId, role, note || null]
  );

  const counts = await _countApprovals(requestId);
  if (counts.APPROVE >= policy.required_approvers) {
    await pool.query(`UPDATE four_eyes_requests SET status = 'APPROVED', updated_at = NOW() WHERE id = $1`, [requestId]);
    const executed = await _dispatch(requestId, approverId);
    return { request: (await getRequest(requestId)).request, approvalCounts: counts, executed };
  }
  return { request: (await getRequest(requestId)).request, approvalCounts: counts, executed: false };
}

async function reject(requestId, approverId, role, note) {
  const { request, policy } = await getRequest(requestId);
  if (request.status !== 'PENDING') throw Object.assign(new Error('Ombi hili tayari limeamuliwa.'), { status: 409 });
  if (!policy.approver_roles.includes(role)) {
    throw Object.assign(new Error(`Jukumu "${role}" haliruhusiwi kuidhinisha hatua hii.`), { status: 403 });
  }
  await pool.query(
    `INSERT INTO four_eyes_approvals (request_id, approver_id, approver_role, decision, note)
     VALUES ($1,$2,$3,'REJECT',$4)`,
    [requestId, approverId, role, note || null]
  );
  await pool.query(`UPDATE four_eyes_requests SET status = 'REJECTED', updated_at = NOW() WHERE id = $1`, [requestId]);
  return (await getRequest(requestId)).request;
}

async function cancel(requestId, userId) {
  const { request } = await getRequest(requestId);
  if (Number(request.requester_id) !== Number(userId)) throw Object.assign(new Error('Mlengaji tu anaruhusiwa kufuta ombi.'), { status: 403 });
  if (request.status !== 'PENDING') throw Object.assign(new Error('Ombi hili tayari limeamuliwa.'), { status: 409 });
  await pool.query(`UPDATE four_eyes_requests SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`, [requestId]);
  return (await getRequest(requestId)).request;
}

async function _dispatch(requestId, approverId) {
  const { request } = await getRequest(requestId);
  if (request.status !== 'APPROVED') return null;
  const executor = executors[request.action_code];
  if (!executor) {
    await pool.query(
      `UPDATE four_eyes_requests SET status = 'FAILED', error = 'No executor registered for this action.', updated_at = NOW() WHERE id = $1`,
      [requestId]
    );
    return null;
  }
  try {
    const result = await executor(request.payload || {}, approverId, request);
    await pool.query(
      `UPDATE four_eyes_requests SET status = 'EXECUTED', executed_by = $2, execution_result = $3, error = NULL, updated_at = NOW() WHERE id = $1`,
      [requestId, approverId, JSON.stringify(result || {})]
    );
    return result || {};
  } catch (e) {
    await pool.query(
      `UPDATE four_eyes_requests SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
      [requestId, String(e.message || e)]
    );
    return null;
  }
}

async function retry(requestId, actorId) {
  const { request } = await getRequest(requestId);
  if (request.status !== 'FAILED') throw Object.assign(new Error('Ombi linahitaji kuwa FAILED ili kurudia.'), { status: 409 });
  return { executed: await _dispatch(requestId, actorId), request: (await getRequest(requestId)).request };
}

module.exports = {
  registerExecutor,
  getPolicy,
  listPolicies,
  upsertPolicy,
  initiateRequest,
  getRequest,
  listRequests,
  approve,
  reject,
  cancel,
  retry,
};