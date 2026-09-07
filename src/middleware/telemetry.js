/**
 * OpenTelemetry-style Request Telemetry Middleware
 * Assigns trace IDs, records request duration, status codes, user context,
 * and persists telemetry metrics into the request_telemetry table. Also
 * establishes a ROOT span in trace_spans and prepares the req.trace context
 * so downstream middleware/services can attach CHILD spans (parent/child).
 */

const pool = require('../config/db');
const { initTrace, startSpan, run } = require('../utils/trace');
const { v4: uuidv4 } = require('crypto'); // or simple random hex

function generateTraceId() {
  return 'tr_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function requestTelemetry(req, res, next) {
  const traceId = req.headers['x-trace-id'] || generateTraceId();
  req.traceId = traceId;
  res.setHeader('X-Trace-ID', traceId);

  // Establish trace context for child spans.
  const trace = initTrace(req);

  const startTime = process.hrtime();
  const startMs = Date.now();

  res.on('finish', () => {
    const diff = process.hrtime(startTime);
    const durationMs = diff[0] * 1000 + Math.round(diff[1] / 1e6);
    const statusCode = res.statusCode;
    const userId = req.user ? req.user.id : null;
    const method = req.method;
    const path = req.originalUrl || req.url;
    const ip = req.ip || req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';

    // Root trace summary row.
    pool.query(
      `INSERT INTO request_telemetry (trace_id, method, path, status_code, duration_ms, user_id, ip_address, user_agent, span_id, span_kind, operation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ROOT', $10)`,
      [traceId, method, path, statusCode, durationMs, userId, ip, userAgent, trace.rootSpanId,
       `${method} ${path}`]
    ).catch(() => {});

    // Root span row in trace_spans (parent_span_id = NULL).
    pool.query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, span_kind, service_name, operation,
         start_ms, duration_ms, status, user_id, ip_address)
       VALUES ($1,$2,NULL,'ROOT',$3,$4,$5,$6,$7,$8,$9)`,
      [traceId, trace.rootSpanId, 'afrikoba-backend', `${method} ${path}`,
       startMs, durationMs, statusCode >= 400 ? 'ERROR' : 'OK', userId, ip]
    ).catch(() => {});
  });

  // Establish trace context for the remainder of the request chain so any
  // service call (async included) can attach CHILD spans under the ROOT.
  return run({ traceId, parentSpanId: trace.rootSpanId }, next);
}

module.exports = { requestTelemetry };
