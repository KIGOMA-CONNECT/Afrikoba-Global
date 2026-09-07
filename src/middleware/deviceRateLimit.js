/**
 * PER-DEVICE RATE LIMITER
 * Sliding-window in-memory limiter keyed by the request's device
 * fingerprint (x-device-fingerprint header or server-derived), mirroring
 * the USSD guard's always-on per-phone guard. Bypassed when global rate
 * limiting is disabled UNLESS DEVICE_RATE_LIMIT_ALWAYS=true.
 * Exported as a factory for tests, plus a default singleton for routes.
 */

const config = require('../config');
const logger = require('../utils/logger');

function createDeviceRateLimiter({ max, windowMs } = {}) {
  const bucket = new Map();
  const RATE_WINDOW_MS = windowMs || config.device.rateWindowMs;
  const MAX = max || config.device.rateMax;

  function cleanup() {
    const now = Date.now();
    for (const [key, value] of bucket) {
      if (now - value.windowStart > RATE_WINDOW_MS * 2) bucket.delete(key);
    }
  }
  const interval = setInterval(cleanup, Math.max(RATE_WINDOW_MS, 60000));
  if (interval.unref) interval.unref();

  return function deviceRateLimit(req, res, next) {
    if (config.security.rateLimitDisabled && !config.device.rateAlways) return next();

    const deviceService = require('../services/deviceService');
    const key = deviceService.generateFingerprint(req);
    const now = Date.now();
    const entry = bucket.get(key);

    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      bucket.set(key, { count: 1, windowStart: now });
      return next();
    }

    entry.count++;
    if (entry.count > MAX) {
      logger.warn('DEVICE_RATE', `Per-device rate limit exceeded: ${key}`);
      return res.status(429).json({
        success: false,
        message: 'Ombi nyingi sana kutoka kifaa hiki. Tafadhali subiri.',
        code: 'DEVICE_RATE_LIMIT_EXCEEDED',
      });
    }
    return next();
  };
}

module.exports = {
  createDeviceRateLimiter,
  deviceRateLimit: createDeviceRateLimiter(),
};