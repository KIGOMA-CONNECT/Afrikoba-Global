/**
 * Metrics Service
 * Collects and exposes system/business metrics for Prometheus/Grafana.
 */

const client = require('prom-client');
const logger = require('../utils/logger');

// Enable default metrics (node process)
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

// Define custom business metrics
const transactionCounter = new client.Counter({
  name: 'afrikoba_transactions_total',
  help: 'Total number of transactions processed',
  labelNames: ['type', 'status'],
});

const activeInvestmentsGauge = new client.Gauge({
  name: 'afrikoba_active_investments_total',
  help: 'Total number of active yield investments',
});

const httpLatencyHistogram = new client.Histogram({
  name: 'afrikoba_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5],
});

// Financial health gauges
const financialReconDifference = new client.Gauge({
  name: 'afrikoba_financial_recon_difference',
  help: 'Aggregate reconciliation difference of the latest run (0 = balanced)',
});
const financialOpenExceptions = new client.Gauge({
  name: 'afrikoba_financial_open_exceptions_total',
  help: 'Open reconciliation exceptions',
  labelNames: ['type'],
});
const financialStaleTransactions = new client.Gauge({
  name: 'afrikoba_financial_stale_transactions_total',
  help: 'Transactions stuck in PENDING/PROCESSING for >1h',
});

async function collectFinancialMetrics() {
  try {
    const pool = require('./db');
    const [diffRow, exceptions, staleRow] = await Promise.all([
      pool.query(
        `SELECT COALESCE(MAX(id),0) AS id, COALESCE(difference,0) AS difference
         FROM reconciliation_runs GROUP BY id, difference ORDER BY id DESC LIMIT 1`
      ),
      pool.query(
        `SELECT exception_type, COUNT(*)::int AS n
         FROM reconciliation_exceptions WHERE status='OPEN' GROUP BY exception_type`
      ),
      pool.query(
        `SELECT COALESCE(COUNT(*),0)::int AS n
         FROM transactions
         WHERE status IN ('PENDING','PROCESSING') AND created_at < NOW() - INTERVAL '1 hour'`
      ),
    ]);
    financialReconDifference.set(Number(diffRow.rows[0]?.difference || 0));
    for (const r of exceptions.rows) {
      financialOpenExceptions.labels({ type: r.exception_type }).set(r.n);
    }
    financialStaleTransactions.set(Number(staleRow.rows[0]?.n || 0));
  } catch (e) {
    logger.warn('METRICS_FIN', `Could not collect financial metrics: ${e.message}`);
  }
}

async function getMetrics() {
  await collectFinancialMetrics();
  return client.register.metrics();
}

module.exports = {
  client,
  getMetrics,
  transactionCounter,
  activeInvestmentsGauge,
  httpLatencyHistogram,
};
