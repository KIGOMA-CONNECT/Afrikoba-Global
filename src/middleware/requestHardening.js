/**
 * Request Hardening
 * Request ID tracking, timeouts, response sanitization.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * H11: Add unique request ID to every request.
 * Enables tracing and debugging in production.
 */
function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * H12: Track and log response time.
 */
function responseTiming(req, res, next) {
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('REQUEST_LOG', `${req.method} ${req.originalUrl}`, {
      requestId: req.id,
      durationMs: duration,
      statusCode: res.statusCode,
    });
  });
  next();
}

/**
 * H11: Request timeout (30 seconds).
 * Prevents hung requests from consuming connections.
 */
function requestTimeout(timeoutMs = 30000) {
  return (req, res, next) => {
    req.setTimeout(timeoutMs, () => {
      logger.warn('TIMEOUT', `Request timeout: ${req.method} ${req.path} from ${req.ip}`);
      if (!res.headersSent) {
        res.status(408).json({
          success: false,
          message: 'Ombi limechukua muda mrefu sana.',
          code: 'REQUEST_TIMEOUT',
        });
      }
    });
    next();
  };
}

/**
 * H17: Sanitize PII from logs.
 * Removes phone numbers, tokens, passwords from log output.
 */
function sanitizeForLog(value) {
  if (typeof value !== 'string') return value;
  // Mask phone numbers (255XXXXXXXXX pattern)
  let sanitized = value.replace(/255\d{9}/g, (match) => match.slice(0, 4) + '****' + match.slice(-2));
  // Mask tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ****');
  // Mask passwords
  sanitized = sanitized.replace(/password['":\s]+['"]?[^'",\s}]+/gi, 'password: ****');
  // Mask OTP codes
  sanitized = sanitized.replace(/\b\d{6}\b/g, '******');
  return sanitized;
}

/**
 * H20: Remove sensitive headers from response.
 */
function sanitizeHeaders(req, res, next) {
  // Remove server identification
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  // Remove internal headers that shouldn't leak
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    const lowerName = name.toLowerCase();
    // Block internal headers from leaking
    if (['x-internal', 'x-debug', 'x-stack'].includes(lowerName)) {
      return;
    }
    originalSetHeader(name, value);
  };

  next();
}

/**
 * H19: Graceful error pages for non-API routes.
 */
function gracefulErrorPages(req, res, next) {
  // Only for non-API routes (HTML responses)
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
    return next();
  }

  // Set content type for HTML error pages
  if (res.statusCode >= 400) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }

  next();
}

module.exports = {
  requestId,
  responseTiming,
  requestTimeout,
  sanitizeForLog,
  sanitizeHeaders,
  gracefulErrorPages,
};
