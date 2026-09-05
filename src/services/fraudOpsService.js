/* ============================================================
 * Fraud Operations Centre — aggregation layer.
 * One-pane-of-glass over fraud_alerts, aml_cases, ai_risk_assessments.
 * Action endpoints reuse governanceService (open/update/notes) and
 * fraudDetectionService (resolveAlert), so the case lifecycle stays in
 * one place. Dashboard + query routes are gated by the
 * FRAUD_OPS_DASHBOARD feature flag (kill-switch).
 * ============================================================ */
const pool = require('../config/db');

async function getDashboard() {
  const alertsQ = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE NOT is_resolved)::int AS open,
           COUNT(*) FILTER (WHERE is_resolved)::int AS resolved
    FROM fraud_alerts`);
  const alertsBySeverity = await pool.query(`
    SELECT severity, COUNT(*)::int AS n FROM fraud_alerts GROUP BY severity ORDER BY n DESC`);
  const casesQ = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status IN ('OPEN','INVESTIGATING'))::int AS open,
           COUNT(*) FILTER (WHERE status IN ('RESOLVED','CLOSED'))::int AS closed
    FROM aml_cases`);
  const casesByStatus = await pool.query(`
    SELECT status, COUNT(*)::int AS n FROM aml_cases GROUP BY status ORDER BY n DESC`);
  const riskLatest = await pool.query(`
    SELECT ROUND(AVG(risk_score))::int AS avg_score, COUNT(*)::int AS total
    FROM (SELECT DISTINCT ON (user_id) user_id, risk_score
          FROM ai_risk_assessments ORDER BY user_id, created_at DESC) latest`);
  const riskByLevel = await pool.query(`
    SELECT risk_level, COUNT(*)::int AS n
    FROM (SELECT DISTINCT ON (user_id) user_id, risk_level
          FROM ai_risk_assessments ORDER BY user_id, created_at DESC) latest
    GROUP BY risk_level ORDER BY n DESC`);
  const priorityAlerts = await pool.query(`
    SELECT a.id, a.user_id, u.full_name, u.phone_number, a.alert_type, a.severity,
           LEFT(a.description, 120) AS description, a.created_at
    FROM fraud_alerts a LEFT JOIN users u ON u.id = a.user_id
    WHERE NOT a.is_resolved
    ORDER BY a.created_at DESC LIMIT 10`);
  const priorityCases = await pool.query(`
    SELECT c.id, c.user_id, u.full_name, u.phone_number, c.case_type, c.status, c.risk_level,
           c.assigned_to, COALESCE(a.full_name, '') AS assigned_name, c.created_at
    FROM aml_cases c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN users a ON a.id = c.assigned_to
    WHERE c.status IN ('OPEN','INVESTIGATING')
    ORDER BY c.updated_at DESC LIMIT 10`);
  const topFlagged = await pool.query(`
    SELECT a.user_id, u.full_name, u.phone_number, COUNT(*)::int AS n,
           MAX(a.severity) AS worst_severity
    FROM fraud_alerts a LEFT JOIN users u ON u.id = a.user_id
    WHERE NOT a.is_resolved
    GROUP BY a.user_id, u.full_name, u.phone_number
    ORDER BY n DESC LIMIT 8`);

  return {
    alerts: {
      ...alertsQ.rows[0],
      by_severity: alertsBySeverity.rows,
    },
    cases: {
      ...casesQ.rows[0],
      by_status: casesByStatus.rows,
    },
    risk: {
      avg_score: riskLatest.rows[0].avg_score,
      profiled_users: riskLatest.rows[0].total,
      by_level: riskByLevel.rows,
    },
    priority: {
      alerts: priorityAlerts.rows,
      cases: priorityCases.rows,
    },
    top_flagged_users: topFlagged.rows,
  };
}

async function queryAlerts({ severity = null, openOnly = null, limit = 50, offset = 0 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const r = await pool.query(
    `SELECT a.*, u.full_name, u.phone_number
     FROM fraud_alerts a LEFT JOIN users u ON u.id = a.user_id
     WHERE ($1::text IS NULL OR a.severity = $1)
       AND ($2::boolean IS NULL OR (NOT a.is_resolved) = $2)
     ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
    [severity || null, openOnly === undefined || openOnly === null ? null : Boolean(openOnly), n, off]
  );
  return r.rows;
}

async function queryCases({ status = null, disposition = null, limit = 50, offset = 0 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const r = await pool.query(
    `SELECT c.*, u.full_name, u.phone_number, COALESCE(a.full_name, '') AS assigned_name
     FROM aml_cases c
     LEFT JOIN users u ON u.id = c.user_id
     LEFT JOIN users a ON a.id = c.assigned_to
     WHERE ($1::text IS NULL OR c.status = $1)
       AND ($2::text IS NULL OR c.disposition = $2)
     ORDER BY c.updated_at DESC LIMIT $3 OFFSET $4`,
    [status || null, disposition || null, n, off]
  );
  return r.rows;
}

async function listRiskProfiles(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const r = await pool.query(
    `SELECT l.user_id, u.full_name, u.phone_number, l.risk_score, l.risk_level,
            l.confidence, l.model_version, l.created_at
     FROM (SELECT DISTINCT ON (user_id) user_id, risk_score, risk_level, confidence, model_version, created_at
           FROM ai_risk_assessments ORDER BY user_id, created_at DESC) l
     LEFT JOIN users u ON u.id = l.user_id
     ORDER BY l.risk_score DESC LIMIT $1`,
    [n]
  );
  return r.rows;
}

module.exports = {
  getDashboard,
  queryAlerts,
  queryCases,
  listRiskProfiles,
};