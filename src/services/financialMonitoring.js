/**
 * FINANCIAL MONITORING / TELEMETRY
 * Exposes a compact snapshot of the platform's financial health so ops can
 * watch the "reconciliation difference = 0" invariant, exception backlog and
 * transaction aging from one place (dashboard + /health + cron hook).
 */

const pool = require('../config/db');
const { recentRuns } = require('../jobs/balanceReconciliation');

/**
 * Financial health snapshot. Never throws - returns degraded booleans which the
 * caller can render. Used by /api/financial/monitoring and /health/ready.
 */
async function financialHealthSnapshot() {
  const out = {
    ok: true,
    reconciliation: { latest: null },
    openExceptions: 0,
    openExceptionsByType: [],
    aging: { pendingDeposits: 0, processingWithdrawals: 0, stale: 0 },
    auditWrites: 0,
  };

  try {
    const [runs, exceptions, aging, audit] = await Promise.all([
      recentRuns(1),
      pool.query(
        `SELECT exception_type, COUNT(*)::int AS n
         FROM reconciliation_exceptions WHERE status = 'OPEN'
         GROUP BY exception_type ORDER BY n DESC`
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status='PENDING' AND type='DEPOSIT' THEN 1 ELSE 0 END),0)::int AS pendingDeposits,
           COALESCE(SUM(CASE WHEN status='PROCESSING' AND type='WITHDRAWAL' THEN 1 ELSE 0 END),0)::int AS processingWithdrawals,
           COALESCE(SUM(CASE WHEN status IN ('PENDING','PROCESSING') AND created_at < NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END),0)::int AS stale
         FROM transactions`
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM financial_audit_log`),
    ]);

    if (runs.length > 0) {
      const latest = runs[0];
      out.reconciliation.latest = latest;
      // The north-star: latest run must have zero aggregate difference.
      if (Number(latest.difference) !== 0 || latest.status !== 'COMPLETE') {
        out.ok = false;
      }
    } else {
      out.ok = false; // never reconciled yet
    }

    out.openExceptionsByType = exceptions.rows;
    out.openExceptions = exceptions.rows.reduce((s, r) => s + r.n, 0);
    if (out.openExceptions > 0) out.ok = false;

    out.aging = aging.rows[0] || { pendingDeposits: 0, processingWithdrawals: 0, stale: 0 };
    if (out.aging.stale > 0 || out.aging.processingWithdrawals > 0) out.ok = false;

    out.auditWrites = audit.rows[0].n;
  } catch (e) {
    // A DB layer failure means we cannot assert financial health -> not ok.
    require('../utils/logger').error('FIN_MONITOR', e.message);
    out.ok = false;
    out.error = e.message;
  }

  return out;
}

module.exports = { financialHealthSnapshot };
