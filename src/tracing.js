/**
 * OpenTelemetry Tracing Initialization
 * Enables distributed tracing for the entire microservices architecture.
 */

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const logger = require('./utils/logger');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    // Replace with your actual OTLP collector endpoint (e.g., Honeycomb, Jaeger, or Grafana Tempo)
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

function startTracing() {
  if (process.env.ENABLE_TRACING === 'true') {
    sdk.start();
    logger.info('OBSERVABILITY', 'OpenTelemetry Tracing started.');
  }
}

module.exports = { startTracing };
