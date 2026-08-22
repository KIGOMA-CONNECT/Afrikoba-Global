/**
 * Idempotency key middleware for financial mutations.
 *
 * Client sends: Idempotency-Key: <unique-key>
 * First request: processed normally, result cached.
 * Duplicate request: returns cached response (no re-execution).
 *
 * Keys expire after 24 hours.
 * Uses an in-memory store; swap for Redis in production with P2-1.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory fallback (swap to Redis in P2-1)
const cache = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > TTL_MS) cache.delete(key);
  }
}
setInterval(cleanup, 10 * 60 * 1000); // cleanup every 10 min

/**
 * Express middleware. Place BEFORE the route handler.
 * Reads `Idempotency-Key` header.
 * On first request: calls next() and captures response.
 * On duplicate: returns cached response.
 */
function idempotent(handler) {
  return async (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return handler(req, res, next);

    // Check memory cache first
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.timestamp < TTL_MS)) {
      res.status(cached.status).json(cached.body);
      return;
    }

    // Check DB (survives restarts)
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

    // Capture response
    const originalJson = res.json.bind(res);
    let capturedStatus = 200;
    let capturedBody = null;

    res.json = function (body) {
      capturedStatus = res.statusCode || 200;
      capturedBody = body;
      originalJson(body);
      return res;
    };

    // Let handler run, then store
    const done = () => {
      if (capturedBody) {
        cache.set(key, { status: capturedStatus, body: capturedBody, timestamp: Date.now() });
        pool.query(
          `INSERT INTO idempotency_keys (key_value, user_id, status_code, response_body, expires_at)
           VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')
           ON CONFLICT (key_value) DO NOTHING`,
          [key, req.user?.id || null, capturedStatus, JSON.stringify(capturedBody)]
        ).catch((err) => logger.warn('IDEMPOTENCY', `DB store failed: ${err.message}`));
      }
    };

    res.on('finish', done);
    handler(req, res, next);
  };
}

module.exports = { idempotent };
