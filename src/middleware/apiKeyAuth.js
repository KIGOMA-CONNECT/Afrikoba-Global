/**
 * API Key Authentication
 * For external integrations, webhooks, and third-party access.
 */

const crypto = require('crypto');
const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * H15: API key validation middleware.
 * Validates API key from header or query parameter.
 */
async function validateApiKey(req, res, next) {
  // Skip if no API key required for this route
  if (!req.route?.settings?.apiKeyRequired) {
    return next();
  }

  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      message: 'API key inahitajika.',
      code: 'API_KEY_MISSING',
    });
  }

  try {
    // Hash the API key for comparison (we store hashes, not plain keys)
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const result = await pool.query(
      `SELECT id, name, permissions, rate_limit, is_active
       FROM api_keys WHERE key_hash = $1 AND is_active = TRUE`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      logger.warn('SECURITY', `Invalid API key from ${req.ip}`);
      return res.status(401).json({
        success: false,
        message: 'API key batili.',
        code: 'API_KEY_INVALID',
      });
    }

    const key = result.rows[0];

    // Check rate limit for this key
    const rateCheck = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM api_key_usage
       WHERE api_key_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [key.id]
    );

    if (rateCheck.rows[0].count >= (key.rate_limit || 1000)) {
      return res.status(429).json({
        success: false,
        message: 'API key rate limit imefikiwa.',
        code: 'API_KEY_RATE_LIMIT',
      });
    }

    // Log usage
    pool.query(
      `INSERT INTO api_key_usage (api_key_id, endpoint, method, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [key.id, req.path, req.method, req.ip]
    ).catch(() => {});

    // Attach API key info to request
    req.apiKey = {
      id: key.id,
      name: key.name,
      permissions: key.permissions,
    };

    next();
  } catch (err) {
    logger.error('SECURITY', `API key validation failed: ${err.message}`);
    next(); // Don't block on validation failure
  }
}

/**
 * Generate a new API key (returns plain key + hash).
 */
function generateApiKey() {
  const plainKey = `afb_${crypto.randomBytes(32).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(plainKey).digest('hex');
  return { plainKey, hash };
}

/**
 * Require API key for a route.
 */
function requireApiKey(req, res, next) {
  req.route.settings = req.route.settings || {};
  req.route.settings.apiKeyRequired = true;
  next();
}

module.exports = {
  validateApiKey,
  generateApiKey,
  requireApiKey,
};
