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

function getMetrics() {
  return client.register.metrics();
}

module.exports = {
  client,
  getMetrics,
  transactionCounter,
  activeInvestmentsGauge,
  httpLatencyHistogram,
};
