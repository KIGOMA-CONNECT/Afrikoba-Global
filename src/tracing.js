/**
 * OpenTelemetry Tracing Initialization
 * Enables distributed tracing for the entire microservices architecture.
 */

const logger = require('./utils/logger');

function startTracing() {
  if (process.env.ENABLE_TRACING === 'true') {
    try {
      const { NodeSDK } = require('@opentelemetry/sdk-node');
      const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

      const sdk = new NodeSDK({
        traceExporter: new OTLPTraceExporter({
          url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
        }),
        instrumentations: [getNodeAutoInstrumentations()],
      });

      sdk.start();
      logger.info('OBSERVABILITY', 'OpenTelemetry Tracing started.');
    } catch (err) {
      logger.warn('OBSERVABILITY', 'OpenTelemetry packages not installed, tracing disabled.');
    }
  }
}

module.exports = { startTracing };
