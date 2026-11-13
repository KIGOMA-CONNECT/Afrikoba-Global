/* ============================================================
 * R26-C1: segregation of duties on direct admin financial routes.
 *
 * fourEyesGate(actionCode, buildPayload)
 *   When four-eyes is active for the action (feature flag FOUR_EYES on for
 *   this user AND four_eyes_policies.enabled for the action code), the
 *   direct route is refused with 403 FOUR_EYES_REQUIRED before any financial
 *   effect, the attempt is written to audit_logs, and the response tells the
 *   caller how to launch the four-eyes request instead. When four-eyes is not
 *   active, the request passes through unchanged (current behaviour).
 *
 * recordDirectExecution(req, actionCode, entityId, meta)
 *   R26-C2: audit row naming maker and checker for a direct execution that ran
 *   while four-eyes was not active (maker = the acting admin, no checker).
 *   Never throws and never changes the response.
 * ============================================================ */
const pool = require('../config/db');
const featureFlags = require('../services/featureFlagService');
const { writeAudit } = require('../services/auditService');

async function isFourEyesRequired(actionCode, user) {
  // R36B OD-3: in the pilot the direct route always requires four-eyes; neither the FOUR_EYES flag nor a
  // disabled policy row (both changeable by one admin) can switch it off.
  if (require('../config/pilot').isFourEyesLocked()) return true;
  const flagOn = await featureFlags.isEnabled('FOUR_EYES', user || null, { action_code: actionCode, gate: 'direct_route' });
  if (!flagOn) return false;
  const r = await pool.query('SELECT enabled FROM four_eyes_policies WHERE action_code = $1', [actionCode]);
  return r.rows.length > 0 && r.rows[0].enabled === true;
}

function apiPrefix(req) {
  // '/api/v1/cards' -> '/api/v1', '/api/business' -> '/api'
  return String(req.baseUrl || '/api/v1').replace(/\/[^/]+$/, '') || '/api/v1';
}

function fourEyesGate(actionCode, buildPayload) {
  return async (req, res, next) => {
    try {
      if (!(await isFourEyesRequired(actionCode, req.user))) return next();
      const payload = buildPayload(req);
      const prefix = apiPrefix(req);
      const entityId = Number.isSafeInteger(payload.loanId) ? payload.loanId : null;
      await writeAudit({
        userId: req.user && req.user.id,
        action: 'FOUR_EYES_DIRECT_BLOCKED',
        entityType: actionCode,
        entityId,
        meta: { action_code: actionCode, method: req.method, path: req.originalUrl, payload },
        req,
      });
      return res.status(403).json({
        success: false,
        code: 'FOUR_EYES_REQUIRED',
        error: 'FOUR_EYES_REQUIRED',
        message: 'Hatua hii inahitaji idhini ya msimamizi wa pili (four-eyes). Anzisha ombi la four-eyes; msimamizi mwingine ataliidhinisha.',
        four_eyes: {
          action_code: actionCode,
          launcher: { method: 'POST', path: `${prefix}/admin/four-eyes/requests`, body: { action_code: actionCode, payload } },
          approve: { method: 'POST', path: `${prefix}/admin/four-eyes/requests/:id/approve` },
        },
      });
    } catch (e) { return next(e); }
  };
}

async function recordDirectExecution(req, actionCode, entityId, meta = {}) {
  await writeAudit({
    userId: req.user && req.user.id,
    action: 'FINANCIAL_DIRECT_EXECUTED',
    entityType: actionCode,
    entityId: Number.isSafeInteger(entityId) ? entityId : null,
    meta: { action_code: actionCode, maker_id: req.user ? req.user.id : null, checker_id: null, four_eyes: 'NOT_ACTIVE', ...meta },
    req,
  }).catch(() => {});
}

module.exports = { fourEyesGate, isFourEyesRequired, recordDirectExecution };
