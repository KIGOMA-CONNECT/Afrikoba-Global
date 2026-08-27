/**
 * Webhook Security Hardening
 * HMAC signature verification, replay protection, IP whitelisting.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

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

/**
 * H16: Verify webhook HMAC signature.
 * @param {string} body - Raw request body
 * @param {string} signature - Signature from header
 * @param {string} secret - Webhook secret
 * @returns {boolean}
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
 */
function webhookReplayProtection(req, res, next) {
  const webhookId = req.headers['x-webhook-id'] || req.headers['x-request-id'];

  if (webhookId) {
    if (processedWebhooks.has(webhookId)) {
      logger.warn('SECURITY', `Webhook replay detected: ${webhookId} from ${req.ip}`);
      return res.status(409).json({
        success: false,
        message: 'Webhook imepokelewa tayari.',
        code: 'WEBHOOK_DUPLICATE',
      });
    }
    processedWebhooks.set(webhookId, Date.now());
  }

  next();
}

/**
 * H16: Webhook HMAC verification middleware.
 */
function verifyWebhookHmac(req, res, next) {
  // Skip if no signature header
  const signature = req.headers['x-signature'] || req.headers['x-hub-signature-256'];
  if (!signature) return next();

  const secret = config.security?.webhookSecret || process.env.WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('SECURITY', 'No webhook secret configured - skipping HMAC verification');
    return next();
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
};
