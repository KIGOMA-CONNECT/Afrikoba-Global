const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const config = require('../config');
const { getRedis } = require('../config/redis');

const opts = (max, label) => ({
  windowMs: config.security.rateWindowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: `Majaribio mengi. Jaribu tena baadaye. (${label})`,
  },
});

const skip = () => config.security.rateLimitDisabled;

function makeLimiter(max, label) {
  const options = { ...opts(max, label), skip };

  // Use Redis store when available (shared across replicas)
  const redis = getRedis();
  if (redis) {
    options.store = new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: `rl:${label.toLowerCase()}:`,
    });
  }

  return rateLimit(options);
}

/** Limiter maalum kwa send-otp (brute force kwa OTP). */
const otpLimiter = makeLimiter(config.security.otpRateMax, 'OTP');

/** Limiter kwa login/register/password/pin. */
const authLimiter = makeLimiter(config.security.authRateMax, 'AUTH');

/** Limiter wa jumla kwa API nzima. */
const apiLimiter = makeLimiter(config.security.apiRateMax, 'API');

module.exports = { otpLimiter, authLimiter, apiLimiter };
