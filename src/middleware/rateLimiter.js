const rateLimit = require('express-rate-limit');
const RedisStorePkg = require('rate-limit-redis');
const RedisStore = RedisStorePkg.RedisStore || RedisStorePkg.default || RedisStorePkg;
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

const skip = () => config.security.rateLimitDisabled || process.env.DISABLE_RATE_LIMIT === 'true';

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

/** Limiter kwa forgot-PIN (request/verify/complete) — anti SMS-flood + brute-force. */
const pinReqLimiter = makeLimiter(5, 'PINREQ');
const pinVerifyLimiter = makeLimiter(20, 'PINVERIFY');

/** Limiter kwa partner-signed BaaS endpoints (payout/statement/summary). */
const bapSignedLimiter = makeLimiter(120, 'BAP');

/** Limiter kwa partner application (public /apply). */
const bapApplyLimiter = makeLimiter(10, 'BAPAPPLY');

/** Limiter wa jumla kwa API nzima. */
const apiLimiter = makeLimiter(config.security.apiRateMax, 'API');

module.exports = { otpLimiter, authLimiter, pinReqLimiter, pinVerifyLimiter, bapSignedLimiter, bapApplyLimiter, apiLimiter };
