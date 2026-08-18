const rateLimit = require('express-rate-limit');
const config = require('../config');

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
  return rateLimit({ ...opts(max, label), skip });
}

/** Limiter maalum kwa send-otp (brute force kwa OTP). */
const otpLimiter = makeLimiter(config.security.otpRateMax, 'OTP');

/** Limiter kwa login/register/password/pin. */
const authLimiter = makeLimiter(config.security.authRateMax, 'AUTH');

/** Limiter wa jumla kwa API nzima. */
const apiLimiter = makeLimiter(config.security.apiRateMax, 'API');

module.exports = { otpLimiter, authLimiter, apiLimiter };
