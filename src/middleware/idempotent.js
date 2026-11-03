/**
 * Idempotency key middleware for financial mutations.
 *
 * Client sends: Idempotency-Key: <unique-key>
 * First request: claims the key, runs the handler, caches a 2xx response.
 * Duplicate request: returns the cached response (no re-execution).
 * Concurrent duplicate: the second request is rejected with 409 instead of
 * executing the mutation twice.
 *
 * Phase 68 / S3 hardening:
 *   - every key is scoped to the authenticated user, in memory, Redis and the
 *     database, so one user can never read another user's cached response;
 *   - the database row is claimed atomically (INSERT ... ON CONFLICT DO NOTHING)
 *     before the handler runs, which serialises concurrent duplicates even
 *     across replicas and after a restart;
 *   - only 2xx responses are cached. A refusal (4xx/5xx) or an aborted request
 *     releases the claim so the client can retry.
 *
 * No schema change: the existing `key_value` primary key stores the scoped key
 * (`u<userId>:<client key>`), and an in-flight row is a placeholder with
 * `status_code = 0` plus an ownership token in `response_body.claim`.
 */

const crypto = require('crypto');
const pool = require('../config/db');
const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TTL_SECONDS = 86400;
const CLAIM_LEASE_SECONDS = 5 * 60; // in-flight claim expires after 5 minutes

// In-memory fallback. Keys are already user-scoped.
const cache = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > TTL_MS) cache.delete(key);
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref?.();

function scopeKey(userId, key) {
  return `u${userId}:${key}`;
}

function parseBody(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function sendCached(res, entry) {
  res.status(entry.status).json(entry.body);
}

async function readCompleted({ redis, key, userId }) {
  if (redis) {
    try {
      const cached = await redis.get(`idem:${key}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.status) return parsed;
      }
    } catch (err) {
      logger.warn('IDEMPOTENCY', `Redis lookup failed: ${err.message}`);
    }
  }

  const memCached = cache.get(key);
  if (memCached && Date.now() - memCached.timestamp < TTL_MS) {
    return { status: memCached.status, body: memCached.body };
  }

  try {
    const { rows } = await pool.query(
      `SELECT status_code, response_body
         FROM idempotency_keys
        WHERE key_value = $1
          AND user_id IS NOT DISTINCT FROM $2
          AND status_code > 0
          AND expires_at > NOW()`,
      [key, userId]
    );
    if (rows.length > 0) {
      return {
        status: Number(rows[0].status_code),
        body: parseBody(rows[0].response_body),
      };
    }
  } catch (err) {
    logger.warn('IDEMPOTENCY', `DB lookup failed: ${err.message}`);
  }

  return null;
}

/**
 * Atomically claim the key. Returns:
 *   { state: 'owned', token }       this request may execute
 *   { state: 'completed', entry }   a finished response exists
 *   { state: 'in_flight', retryAfter } another request is still running
 */
async function claimKey(key, userId) {
  const token = crypto.randomUUID();

  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (key_value, user_id, status_code, response_body, expires_at)
     VALUES ($1, $2, 0, $3::jsonb, NOW() + ($4::text || ' seconds')::interval)
     ON CONFLICT (key_value) DO NOTHING
     RETURNING key_value`,
    [key, userId, JSON.stringify({ claim: token }), CLAIM_LEASE_SECONDS]
  );

  if (inserted.rowCount === 1) return { state: 'owned', token };

  const { rows } = await pool.query(
    `SELECT status_code, response_body, expires_at,
            GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - NOW()))))::int AS retry_after
       FROM idempotency_keys
      WHERE key_value = $1 AND user_id IS NOT DISTINCT FROM $2`,
    [key, userId]
  );

  if (rows.length === 0) {
    // The row disappeared between the conflict and the read (expiry cleanup).
    // Treat it as in-flight; the client retries shortly.
    return { state: 'in_flight', retryAfter: 1 };
  }

  const row = rows[0];
  if (Number(row.status_code) > 0) {
    return {
      state: 'completed',
      entry: { status: Number(row.status_code), body: parseBody(row.response_body) },
    };
  }

  // A crashed request leaves a placeholder behind. Allow takeover only after
  // the lease expired; the ownership token prevents the old request from
  // writing a response over the new owner's row.
  const takeover = await pool.query(
    `UPDATE idempotency_keys
        SET response_body = $3::jsonb,
            expires_at = NOW() + ($4::text || ' seconds')::interval
      WHERE key_value = $1
        AND user_id IS NOT DISTINCT FROM $2
        AND status_code = 0
        AND expires_at <= NOW()
      RETURNING key_value`,
    [key, userId, JSON.stringify({ claim: token }), CLAIM_LEASE_SECONDS]
  );

  if (takeover.rowCount === 1) return { state: 'owned', token };

  return { state: 'in_flight', retryAfter: Math.max(1, Number(row.retry_after) || 1) };
}

async function completeClaim({ key, token, status, body }) {
  try {
    const updated = await pool.query(
      `UPDATE idempotency_keys
          SET status_code = $3,
              response_body = $4::jsonb,
              expires_at = NOW() + INTERVAL '24 hours'
        WHERE key_value = $1
          AND status_code = 0
          AND response_body->>'claim' = $2`,
      [key, token, status, JSON.stringify(body)]
    );
    if (updated.rowCount !== 1) {
      logger.warn('IDEMPOTENCY', `Claim ownership lost for ${key}; response not cached.`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('IDEMPOTENCY', `DB store failed: ${err.message}`);
    return false;
  }
}

async function releaseClaim({ key, token }) {
  try {
    await pool.query(
      `DELETE FROM idempotency_keys
        WHERE key_value = $1
          AND status_code = 0
          AND response_body->>'claim' = $2`,
      [key, token]
    );
  } catch (err) {
    logger.warn('IDEMPOTENCY', `DB release failed: ${err.message}`);
  }
}

/**
 * Express middleware. Place BEFORE the route handler.
 */
function idempotent(handler) {
  return async (req, res, next) => {
    const clientKey = req.headers['idempotency-key'];
    if (!clientKey) return handler(req, res, next);

    const userId = req.user && req.user.id;
    if (!userId) {
      // Every route using this middleware is authenticated. Refusing here is
      // fail-closed: an unscoped key could otherwise leak across users.
      return res.status(401).json({
        success: false,
        message: 'Idempotency-Key inahitaji mtumiaji aliyethibitishwa.',
        code: 'IDEMPOTENCY_REQUIRES_AUTH',
      });
    }

    const key = scopeKey(userId, clientKey);
    const redis = getRedis();

    const completed = await readCompleted({ redis, key, userId });
    if (completed) return sendCached(res, completed);

    const claim = await claimKey(key, userId);
    if (claim.state === 'completed') return sendCached(res, claim.entry);
    if (claim.state === 'in_flight') {
      res.setHeader('Retry-After', String(claim.retryAfter));
      return res.status(409).json({
        success: false,
        message: 'Ombi la awali lenye ufunguo huu linaendelea. Tafadhali subiri.',
        code: 'IDEMPOTENCY_IN_PROGRESS',
      });
    }

    let capturedStatus = 200;
    let capturedBody = null;
    let finalizePromise = null;

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      capturedStatus = res.statusCode || 200;
      capturedBody = body;
      return originalJson(body);
    };

    const finalize = () => {
      if (finalizePromise) return finalizePromise;
      finalizePromise = (async () => {
        // No body captured: the request was aborted before a response. Release
        // the claim so the client can retry safely.
        if (capturedBody === null) {
          await releaseClaim({ key, token: claim.token });
          return;
        }

        // Only successful responses are safe to replay. A refusal may depend
        // on time-varying state (limits, fraud, balances) and must be retryable.
        if (capturedStatus < 200 || capturedStatus >= 300) {
          await releaseClaim({ key, token: claim.token });
          return;
        }

        const stored = await completeClaim({
          key,
          token: claim.token,
          status: capturedStatus,
          body: capturedBody,
        });
        if (!stored) return;

        const payload = JSON.stringify({ status: capturedStatus, body: capturedBody });

        if (redis) {
          redis.setex(`idem:${key}`, TTL_SECONDS, payload).catch((err) => {
            logger.warn('IDEMPOTENCY', `Redis store failed: ${err.message}`);
          });
        }
        cache.set(key, { status: capturedStatus, body: capturedBody, timestamp: Date.now() });
      })();
      return finalizePromise;
    };

    res.locals = res.locals || {};
    res.locals.idempotencyFinalize = finalize;
    res.on('finish', finalize);
    res.on('close', finalize);

    try {
      await handler(req, res, next);
    } catch (err) {
      await releaseClaim({ key, token: claim.token });
      if (!res.headersSent) return next(err);
      throw err;
    }
  };
}

module.exports = { idempotent };
