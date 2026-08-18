const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Access logging + Request ID.
 * - Inatengeneza `x-request-id` kwa kila request (tracing/log correlation).
 * - Inarekodi method, path, status, muda na request id.
 * - Nyaraka za `x-request-id` zinahamishiwa kwa majibu (client anaweza kuripoti).
 */
function requestLog(req, res, next) {
  const id = crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);

  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    logger.info(
      'HTTP',
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms) [${id}]`
    );
  });

  next();
}

module.exports = { requestLog };
