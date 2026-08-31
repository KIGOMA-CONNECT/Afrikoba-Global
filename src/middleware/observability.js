/**
 * Observability Middleware
 * Tracks Request IDs and logs response times.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

function observability(req, res, next) {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('REQUEST_LOG', `${req.method} ${req.originalUrl}`, {
      requestId,
      durationMs: duration,
      statusCode: res.statusCode,
      ip: req.ip,
    });
  });

  next();
}

module.exports = { observability };