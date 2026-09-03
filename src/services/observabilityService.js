/**
 * Observability / BI Service
 * Aggregated business KPIs and request/error metrics for the Admin area.
 */

const pool = require('../config/db');

async function getBusinessKpis() {
  const [users, mtdVolume, mtdFees, activeVaults, amlOpen, pendingApprovals] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM users`),
    pool.query(`SELECT COALESCE(SUM(total_charged),0)::numeric AS vol,
                       COALESCE(SUM(commission),0)::numeric AS fees,
                       COUNT(*)::int AS count
                FROM transactions WHERE status='SUCCESS' AND created_at > date_trunc('month', NOW())`),
    pool.query(`SELECT COALESCE(SUM(total_charged),0)::numeric AS vol,
                       COALESCE(SUM(commission),0)::numeric AS fees
                FROM transactions WHERE status='SUCCESS' AND created_at > date_trunc('month', NOW())`),
    pool.query(`SELECT COUNT(*)::int AS total FROM savings_goals WHERE is_completed = FALSE`),
    pool.query(`SELECT COUNT(*)::int AS total FROM aml_cases WHERE status IN ('OPEN','INVESTIGATING')`),
    pool.query(`SELECT COUNT(*)::int AS total FROM approval_flows WHERE status = 'PENDING'`),
  ]);
  return {
    users: users.rows[0].total,
    monthlyVolume: mtdVolume.rows[0].vol,
    monthlyFees: mtdFees.rows[0].fees,
    monthlyTransactions: mtdVolume.rows[0].count,
    activeVaults: activeVaults.rows[0].total,
    openAmlCases: amlOpen.rows[0].total,
    pendingApprovals: pendingApprovals.rows[0].total,
  };
}

async function getTransactionTrend(days = 14) {
  const result = await pool.query(
    `SELECT DATE(created_at) AS day, COUNT(*)::int AS count, COALESCE(SUM(total_charged),0)::numeric AS volume
     FROM transactions WHERE status='SUCCESS' AND created_at > NOW() - ($1::int || ' days')::interval
     GROUP BY DATE(created_at) ORDER BY day ASC`,
    [days]
  );
  return result.rows;
}

async function getTransactionTypeBreakdown() {
  const result = await pool.query(
    `SELECT type, COUNT(*)::int AS count, COALESCE(SUM(total_charged),0)::numeric AS volume
     FROM transactions WHERE created_at > NOW() - INTERVAL '30 days'
     GROUP BY type ORDER BY volume DESC LIMIT 15`
  );
  return result.rows;
}

async function getSeverityBreakdown() {
  const result = await pool.query(
    `SELECT severity, COUNT(*)::int AS count FROM fraud_alerts
     WHERE is_resolved = FALSE GROUP BY severity ORDER BY severity`
  );
  return result.rows;
}

module.exports = { getBusinessKpis, getTransactionTrend, getTransactionTypeBreakdown, getSeverityBreakdown };
