/**
 * OpenTelemetry-style Request Telemetry Middleware
 * Assigns trace IDs, records request duration, status codes, user context,
 * and persists telemetry metrics into the request_telemetry table.
 */

const pool = require('../config/db');
const { v4: uuidv4 } = require('crypto'); // or simple random hex

function generateTraceId() {
  return 'tr_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function requestTelemetry(req, res, next) {
  const traceId = req.headers['x-trace-id'] || generateTraceId();
  req.traceId = traceId;
  res.setHeader('X-Trace-ID', traceId);

  const start = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const durationMs = diff[0] * 1000 + Math.round(diff[1] / 1e6);
    const statusCode = res.statusCode;
    const userId = req.user ? req.user.id : null;
    const method = req.method;
    const path = req.originalUrl || req.url;
    const ip = req.ip || req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';

    // Asynchronously log to telemetry table without blocking response
    pool.query(
      `INSERT INTO request_telemetry (trace_id, method, path, status_code, duration_ms, user_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [traceId, method, path, statusCode, durationMs, userId, ip, userAgent]
    ).catch(() => {});
  });

  next();
}

module.exports = { requestTelemetry };
