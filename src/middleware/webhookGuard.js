const config = require('../config');
const logger = require('../utils/logger');

/**
 * IP sawa na entry ya allowlist? (exact IP au CIDR)
 * @param {string} ip - Client IP (tayari normalized)
 * @param {string} entry - "1.2.3.4" au "1.2.3.0/24"
 */
function isIpAllowed(ip, entry) {
  if (entry.includes('/')) {
    const [base, bitsStr] = entry.split('/');
    const bits = parseInt(bitsStr, 10);
    if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
    const ipNum = ipv4ToInt(ip);
    const baseNum = ipv4ToInt(base);
    if (ipNum === null || baseNum === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (baseNum & mask);
  }
  return ip === entry;
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/**
 * Ulinzi wa AzamPay Webhook Callbacks
 * - Header Secret Verification (x-webhook-secret / x-azampay-secret)
 * - IP Whitelisting + CIDR (production only, tu ikiwa ALLOWED_WEBHOOK_IPS imewekwa)
 */
function verifyWebhookSecurity(req, res, next) {
  if (!config.webhook.secret) {
    if (config.nodeEnv === 'production') {
      logger.error('WEBHOOK', 'WEBHOOK_SECRET haijawekwa! Callbacks zote zimezuiliwa kwenye production.');
      return res.status(503).json({ success: false, message: 'Webhook verification not configured.' });
    }
    logger.warn('WEBHOOK', 'WEBHOOK_SECRET haipo — bypassing verification in development.');
    return next();
  }

  const headerSecret = req.headers['x-webhook-secret'] || req.headers['x-azampay-secret'];
  if (!headerSecret || headerSecret !== config.webhook.secret) {
    logger.warn('WEBHOOK', 'Secret header si sahihi (Fake Callback attempt)');
    return res.status(401).json({ success: false, message: 'Unauthorized Webhook Request' });
  }

  if (config.nodeEnv === 'production' && config.webhook.allowedIps.length > 0) {
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress
      || req.ip;
    const normalized = String(clientIp).replace(/^::ffff:/, '');
    if (!config.webhook.allowedIps.some((entry) => isIpAllowed(normalized, entry))) {
      logger.warn('WEBHOOK', `IP haijulikani ilijaribu callback: ${normalized}`);
      return res.status(403).json({ success: false, message: 'Access Denied: IP Not Whitelisted' });
    }
  }
  next();
}

module.exports = { verifyWebhookSecurity };
