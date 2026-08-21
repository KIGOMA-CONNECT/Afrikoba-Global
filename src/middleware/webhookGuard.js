const config = require('../config');
const logger = require('../utils/logger');

/**
 * Ulinzi wa AzamPay Webhook Callbacks
 * - Header Secret Verification (x-webhook-secret)
 * - IP Whitelisting (production only)
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
    const normalized = clientIp.replace(/^::ffff:/, '');
    if (!config.webhook.allowedIps.includes(normalized)) {
      logger.warn('WEBHOOK', `IP haijulikani ilijaribu callback: ${normalized}`);
      return res.status(403).json({ success: false, message: 'Access Denied: IP Not Whitelisted' });
    }
  }
  next();
}

module.exports = { verifyWebhookSecurity };
