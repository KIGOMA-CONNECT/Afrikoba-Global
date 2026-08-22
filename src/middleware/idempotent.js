/**
 * Idempotency key middleware for financial mutations.
 *
 * Client sends: Idempotency-Key: <unique-key>
 * First request: processed normally, result cached.
 * Duplicate request: returns cached response (no re-execution).
 *
 * Uses Redis when available, falls back to in-memory + DB.
 * Keys expire after 24 hours.
 */

const pool = require('../config/db');
const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TTL_SECONDS = 86400;

// In-memory fallback
const cache = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > TTL_MS) cache.delete(key);
  }
}
setInterval(cleanup, 10 * 60 * 1000);

/**
 * Express middleware. Place BEFORE the route handler.
 */
function idempotent(handler) {
  return async (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return handler(req, res, next);

    const redis = getRedis();

    // 1. Check Redis (multi-replica safe)
    if (redis) {
      try {
        const cached = await redis.get(`idem:${key}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          res.status(parsed.status).json(parsed.body);
          return;
        }
      } catch (err) {
        logger.warn('IDEMPOTENCY', `Redis lookup failed: ${err.message}`);
      }
    }

    // 2. Check in-memory fallback
    const memCached = cache.get(key);
    if (memCached && (Date.now() - memCached.timestamp < TTL_MS)) {
      res.status(memCached.status).json(memCached.body);
      return;
    }

    // 3. Check DB (survives restarts)
    try {
      const dbCheck = await pool.query(
        'SELECT status_code, response_body FROM idempotency_keys WHERE key_value = $1 AND expires_at > NOW()',
        [key]
      );
      if (dbCheck.rows.length > 0) {
        const row = dbCheck.rows[0];
        const body = typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body;
        res.status(row.status_code).json(body);
        return;
      }
    } catch (err) {
      logger.warn('IDEMPOTENCY', `DB lookup failed: ${err.message}`);
    }

    // 4. Capture response
    const originalJson = res.json.bind(res);
    let capturedStatus = 200;
    let capturedBody = null;

    res.json = function (body) {
      capturedStatus = res.statusCode || 200;
      capturedBody = body;
      originalJson(body);
      return res;
    };

    const done = () => {
      if (capturedBody) {
        const payload = JSON.stringify({ status: capturedStatus, body: capturedBody });

        // Store in Redis (multi-replica)
        if (redis) {
          redis.setex(`idem:${key}`, TTL_SECONDS, payload).catch((err) => {
            logger.warn('IDEMPOTENCY', `Redis store failed: ${err.message}`);
          });
        }

        // Store in memory (single-replica)
        cache.set(key, { status: capturedStatus, body: capturedBody, timestamp: Date.now() });

        // Store in DB (survives restarts)
        pool.query(
          `INSERT INTO idempotency_keys (key_value, user_id, status_code, response_body, expires_at)
           VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')
           ON CONFLICT (key_value) DO NOTHING`,
          [key, req.user?.id || null, capturedStatus, capturedBody]
        ).catch((err) => logger.warn('IDEMPOTENCY', `DB store failed: ${err.message}`));
      }
    };

    res.on('finish', done);
    handler(req, res, next);
  };
}

module.exports = { idempotent };
