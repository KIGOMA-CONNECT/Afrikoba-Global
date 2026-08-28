/**
 * Granular Rate Limiting
 * Different limits for different endpoint categories.
 */

const rateLimit = require('express-rate-limit');
const { getRedis } = require('../config/redis');

/**
 * Create a rate limiter with Redis or in-memory store.
 */
function createLimiter(options) {
  // Test-mode bypass: integration tests simulate many users from one IP.
  // Production never sets this — rate limits stay active.
  if (process.env.DISABLE_RATE_LIMIT === 'true' || process.env.RATE_LIMIT_DISABLED === 'true') {
    return (req, res, next) => next();
  }
  const storeOptions = {
    windowMs: options.windowMs || 15 * 60 * 1000,
    max: options.max || 100,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    message: {
      success: false,
      message: options.message || 'Maombi mengi sana. Jaribu tena baadaye.',
      code: 'RATE_LIMIT',
    },
    keyGenerator: options.keyGenerator || undefined,
  };

  return rateLimit(storeOptions);
}

// H7: Granular rate limits per endpoint category

// Auth endpoints (stricter)
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 40,
  message: 'Maombi mengi ya uingiaji. Subiri dakika 15.',
});

// OTP endpoints (very strict)
const otpLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Maombi mengi ya OTP. Subiri dakika 15.',
});

// Wallet endpoints (moderate)
const walletLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Maombi mengi ya wallet. Subiri kidogo.',
});

// Financial operations (strict)
const financialLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Maombi mengi ya fedha. Subiri kidogo.',
});

// Admin endpoints (moderate)
const adminLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Maombi mengi ya admin.',
});

// Public endpoints (generous)
const publicLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Maombi mengi sana.',
});

// Login attempt limiter (per phone number)
const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const phone = req.body?.phoneNumber || req.body?.phone_number || 'unknown';
    return `login:${phone}`;
  },
  message: 'Majaribio mengi ya kuingia. Subiri dakika 15.',
});

// Registration limiter (per IP)
const registerLimiter = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: 'Usajili mwingi. Subiri saa 1.',
});

// Password/PIN change limiter
const passwordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Majaribio mengi ya kubadilisha nywila. Subiri saa 1.',
});

// File upload limiter (if applicable)
const uploadLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Upload nyingi. Subiri saa 1.',
});

// Webhook limiter (generous for payment callbacks)
const webhookLimiter = createLimiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,
  message: 'Webhook nyingi.',
});

module.exports = {
  authLimiter,
  otpLimiter,
  walletLimiter,
  financialLimiter,
  adminLimiter,
  publicLimiter,
  loginLimiter,
  registerLimiter,
  passwordLimiter,
  uploadLimiter,
  webhookLimiter,
};
