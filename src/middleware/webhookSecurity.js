/**
 * Webhook Security Hardening
 * HMAC signature verification, replay protection, IP whitelisting.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { getRedis } = require('../config/redis');

// Webhook IP whitelists (AzamPay, Beem Africa, etc.)
const WEBHOOK_IP_WHITELIST = {
  azamay: ['*'], // AzamPay sandbox has no fixed IPs; production TBD
  beem: ['*'],
};

const processedWebhooks = new Map();
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h window
  for (const [id, timestamp] of processedWebhooks) {
    if (timestamp < cutoff) processedWebhooks.delete(id);
  }
}, CLEANUP_INTERVAL).unref();

const REPLAY_TTL_SECONDS = 24 * 60 * 60;

/**
 * H16: Verify webhook HMAC signature.
 */
function verifyWebhookSignature(body, signature, secret) {
  if (!signature || !secret) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * H16: Replay protection middleware.
 * Rejects webhooks with the same ID within 24 hours.
 *
 * Backing store: Redis when configured (multi-replica safe), otherwise an
 * in-process Map. The state machine on the deposit/withdrawal rows remains
 * the authoritative protection against double-credit; this layer only rejects
 * obvious replays early.
 */
async function webhookReplayProtection(req, res, next) {
  const webhookId = req.headers['x-webhook-id'] || req.headers['x-request-id'];

  if (!webhookId) return next();

  try {
    const redis = getRedis();
    if (redis) {
      try {
        const key = `webhook:replay:${webhookId}`;
        const ok = await redis.set(key, '1', 'NX', 'EX', REPLAY_TTL_SECONDS);
        if (ok === null) {
          logger.warn('SECURITY', `Webhook replay detected (redis): ${webhookId} from ${req.ip}`);
          return res.status(409).json({
            success: false,
            message: 'Webhook imepokelewa tayari.',
            code: 'WEBHOOK_DUPLICATE',
          });
        }
        return next();
      } catch (err) {
        logger.warn('SECURITY', `Redis replay check failed, falling back to memory: ${err.message}`);
      }
    }

    if (processedWebhooks.has(webhookId)) {
      logger.warn('SECURITY', `Webhook replay detected: ${webhookId} from ${req.ip}`);
      return res.status(409).json({
        success: false,
        message: 'Webhook imepokelewa tayari.',
        code: 'WEBHOOK_DUPLICATE',
      });
    }
    processedWebhooks.set(webhookId, Date.now());

    next();
  } catch (err) {
    logger.error('SECURITY', `webhookReplayProtection failed: ${err.message}`);
    next();
  }
}

/**
 * H16: Webhook HMAC verification middleware.
 */
function verifyWebhookHmac(req, res, next) {
  const secret = config.security?.webhookSecret || process.env.WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('SECURITY', 'No webhook secret configured - skipping HMAC verification');
    return next();
  }

  const signature = req.headers['x-signature'] || req.headers['x-hub-signature-256'];
  if (!signature) {
    logger.warn('SECURITY', `Missing webhook signature from ${req.ip}`);
    return res.status(401).json({
      success: false,
      message: 'Webhook signature haipo.',
      code: 'WEBHOOK_MISSING_SIGNATURE',
    });
  }

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const isValid = verifyWebhookSignature(rawBody, signature.replace('sha256=', ''), secret);

  if (!isValid) {
    logger.warn('SECURITY', `Invalid webhook HMAC from ${req.ip}`);
    return res.status(401).json({
      success: false,
      message: 'Webhook signature batili.',
      code: 'WEBHOOK_INVALID_SIGNATURE',
    });
  }

  next();
}

module.exports = {
  verifyWebhookSignature,
  webhookReplayProtection,
  verifyWebhookHmac,
  WEBHOOK_IP_WHITELIST,
};
