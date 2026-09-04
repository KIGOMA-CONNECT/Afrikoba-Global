/**
 * Admin Ops Dashboard
 * Aggregates system health, financial health, security posture, recurrence,
 * and audit/security events for a single enhanced operations screen.
 */

const express = require('express');
const pool = require('../config/db');
const { authRequired, requireRoles } = require('../middleware/auth');
const { listAudit } = require('../services/auditService');

const router = express.Router();
router.use(authRequired, requireRoles('ADMIN'));

// ===== Aggregate ops dashboard =====
router.get('/dashboard', async (req, res, next) => {
  try {
    // 1. DB health & table stats
    let health = { db: 'UP' };
    let tableStats = [];
    try {
      const { getTableStats, getHealthMetrics } = require('../services/dbMaintenanceService');
      tableStats = await getTableStats();
      const metrics = await getHealthMetrics();
      health = { db: 'UP', metrics };
    } catch (e) { health = { db: 'DEGRADED', error: e.message }; }

    // 2. Financial health snapshot
    let financial = null;
    try { financial = await require('../services/financialMonitoring').financialHealthSnapshot(); }
    catch (e) { financial = { error: e.message }; }

    // 3. Security posture
    let security = {};
    try {
      const [totpUsers, stepupPending, totalUsers] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE totp_enabled`),
        pool.query(`SELECT COUNT(*)::int AS c FROM stepup_tokens WHERE used_at IS NULL AND expires_at > NOW()`),
        pool.query(`SELECT COUNT(*)::int AS c FROM users`),
      ]);
      const activeUsers = (await pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS c FROM transactions WHERE created_at > NOW() - INTERVAL '7 days'`
      ).catch(() => ({ rows: [{ c: null }] }))).rows[0].c;
      security = {
        totalUsers: totalUsers.rows[0].c,
        active7d: activeUsers,
        totpEnabledUsers: totpUsers.rows[0].c,
        activeStepupTokens: stepupPending.rows[0].c,
      };
    } catch (e) { security = { error: e.message }; }

    // 4. Recurrence summary
    let recurrence = { activeRules: 0, failedLast: 0 };
    try {
      const [rules, failed] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM recurrence_rules WHERE enabled`),
        pool.query(`SELECT COUNT(*)::int AS c FROM recurrence_executions WHERE status='FAILED' AND run_at > NOW() - INTERVAL '24 hours'`),
      ]);
      recurrence = { activeRules: rules.rows[0].c, failedLast24h: failed.rows[0].c };
    } catch (e) { recurrence = { error: e.message }; }

    // 5. Recent audit + security events
    const recentAudit = await listAudit({ limit: 15 });

    // 6. Step-up issuance events (security)
    let securityEvents = [];
    try {
      securityEvents = (await pool.query(
        `SELECT e.id, e.status, e.run_at,
                COALESCE((e.detail->>'result')::text, e.detail->>'error') AS summary
           FROM recurrence_executions e ORDER BY e.run_at DESC LIMIT 5`
      )).rows;
    } catch (e) { securityEvents = []; }

    // 7. Request Telemetry Metrics
    let telemetry = null;
    try {
      const obs = require('../services/observabilityService');
      telemetry = await obs.getRequestMetrics(24);
    } catch (e) { telemetry = { error: e.message }; }

    res.json({
      success: true,
      observedAt: new Date().toISOString(),
      health,
      tableStats,
      financial,
      security,
      recurrence,
      recentAudit,
      securityEvents,
      telemetry,
      system: {
        uptime: process.uptime(),
        pid: process.pid,
        node: process.version,
        memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, heapTotal: process.memoryUsage().heapTotal },
      },
    });
  } catch (error) { next(error); }
});

// ===== Recent audit log =====
router.get('/audit', async (req, res, next) => {
  try {
    const logs = await listAudit({
      limit: parseInt(req.query.limit, 10) || 50,
      action: req.query.action,
      entityType: req.query.entity_type,
    });
    res.json({ success: true, logs });
  } catch (error) { next(error); }
});

// ===== Live uptime / process info =====
router.get('/system', async (req, res, next) => {
  try {
    const mem = process.memoryUsage();
    res.json({
      success: true,
      uptime: process.uptime(),
      pid: process.pid,
      node: process.version,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      time: new Date().toISOString(),
    });
  } catch (error) { next(error); }
});

module.exports = router;
