require('dotenv').config();

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  db: {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'afrikoba_global',
    password: process.env.DB_PASSWORD || 'secret',
    port: parseInt(process.env.DB_PORT || '5432', 10),
  },
  beem: {
    apiKey: process.env.BEEM_API_KEY,
    secretKey: process.env.BEEM_SECRET_KEY,
    senderId: process.env.BEEM_SENDER_ID || 'AFRIKOBA',
  },
  azampay: {
    appName: process.env.AZAMPAY_APP_NAME,
    clientId: process.env.AZAMPAY_CLIENT_ID,
    clientSecret: process.env.AZAMPAY_CLIENT_SECRET,
    env: process.env.AZAMPAY_ENV || 'sandbox',
  },
  fees: {
    depositCommissionPercent: parseFloat(process.env.DEPOSIT_COMMISSION_PERCENT || '0.01'),
    platformCommPercent: parseFloat(process.env.PLATFORM_COMM_PERCENT || '2.00'),
    investorPayoutPercent: parseFloat(process.env.INVESTOR_PAYOUT_PERCENT || '28.00'),
    operationalPercent: parseFloat(process.env.OPERATIONAL_PERCENT || '70.00'),
    vicobaMonthlyFee: parseFloat(process.env.VICOBA_MONTHLY_FEE || '10000'),
  },
  webhook: {
    secret: process.env.WEBHOOK_SECRET || '',
    allowedIps: (process.env.ALLOWED_WEBHOOK_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  contract: {
    dir: process.env.CONTRACT_DIR || 'contracts',
    baseUrl: process.env.CONTRACT_BASE_URL || 'http://localhost:3000/contracts',
  },
  security: {
    jwtSecret: process.env.JWT_SECRET,
    jwtTtl: process.env.JWT_TTL || '7d',
    // '*' ina ruhusu origin zote (development). Katika production weka list halisi.
    corsOrigins: (process.env.CORS_ORIGINS || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rateLimitDisabled: process.env.RATE_LIMIT_DISABLED === 'true',
    otpRateMax: parseInt(process.env.OTP_RATE_MAX || '20', 10),
    authRateMax: parseInt(process.env.AUTH_RATE_MAX || '40', 10),
    apiRateMax: parseInt(process.env.API_RATE_MAX || '1000', 10),
    rateWindowMs: parseInt(process.env.RATE_WINDOW_MS || String(15 * 60 * 1000), 10),
    // Optional TLS (mbele ya reverse proxy inapendelewa)
    tlsCert: process.env.TLS_CERT_PATH,
    tlsKey: process.env.TLS_KEY_PATH,
  },
  trustProxy: process.env.TRUST_PROXY === 'true',
};

const DEFAULT_JWT = 'afrikoba_dev_secret_change_me';

/**
 * Fail-fast validation: katika production, usikubali maadili ya default ambayo
 * yana hatari. Hii inazuia server kuanza kama mazingira hayajasahihishwa.
 */
function validateConfig() {
  const errors = [];
  const isProd = config.nodeEnv === 'production';

  if (!isProd) return { valid: true, errors };

  if (!config.security.jwtSecret || config.security.jwtSecret === DEFAULT_JWT) {
    errors.push('JWT_SECRET lazima uwe imewekwa na sio default (JWT_SECRET)');
  }
  if (!config.db.password || config.db.password === 'secret') {
    errors.push('DB_PASSWORD lazima uwe imewekwa na sio default');
  }
  if (!config.webhook.secret) {
    errors.push('WEBHOOK_SECRET lazima uwe imewekwa (uthibitisho wa callbacks)');
  }
  if (!config.beem.apiKey || !config.beem.secretKey) {
    errors.push('BEEM_API_KEY na BEEM_SECRET_KEY zinahitajika (SMS halisi)');
  }
  if (!config.azampay.clientId || !config.azampay.clientSecret || config.azampay.env === 'sandbox') {
    errors.push('AZAMPAY_CLIENT_ID, AZAMPAY_CLIENT_SECRET na AZAMPAY_ENV=production zinahitajika');
  }
  if (!config.security.corsOrigins || config.security.corsOrigins.includes('*')) {
    errors.push('CORS_ORIGINS lazima uwe list halisi ya origins (sio "*")');
  }
  if (!config.contract.baseUrl.startsWith('https://')) {
    errors.push('CONTRACT_BASE_URL lazima ianze na https://');
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration haijakamilika:\n- ${errors.join('\n- ')}`);
  }
  return { valid: true, errors };
}

module.exports = config;
module.exports.validateConfig = validateConfig;
module.exports.DEFAULT_JWT = DEFAULT_JWT;
