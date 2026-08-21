const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * USSD Request Authentication Guard
 * - HMAC signature verification for USSD gateway requests
 * - Rate limiting per phone number (max 10 requests/min)
 * - Session ID format validation
 * - Phone number format validation
 */

const ussdRateMap = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_MIN = 10;

function cleanupRates() {
  const now = Date.now();
  for (const [key, data] of ussdRateMap) {
    if (now - data.windowStart > RATE_WINDOW_MS * 2) {
      ussdRateMap.delete(key);
    }
  }
}
setInterval(cleanupRates, 120000);

/**
 * HMAC signature verification:
 * Gateway sends: x-ussd-signature = HMAC-SHA256(sessionId + phoneNumber + timestamp, USSD_SECRET)
 * This prevents forged USSD requests from unauthenticated callers.
 */
function verifyUssdSignature(req, res, next) {
  const { sessionId, phoneNumber, timestamp } = req.body;

  if (!sessionId || !phoneNumber) {
    return res.status(400).send('END Tafadhali washa tena.');
  }

  if (!config.ussd.secret) {
    if (config.nodeEnv === 'production') {
      logger.error('USSD', 'USSD_SECRET haijawekwa kwenye production! Request imezuiliwa.');
      return res.status(500).send('END Hitilafu ya mfumo. Tafadhali washa tena.');
    }
    return next();
  }

  const signature = req.headers['x-ussd-signature'];
  if (!signature) {
    logger.warn('USSD', `USSD request bila signature: session=${sessionId} phone=${phoneNumber}`);
    return res.status(401).send('END Ombi si halali.');
  }

  const ts = parseInt(timestamp, 10);
  if (!ts || Math.abs(Date.now() - ts) > 120000) {
    logger.warn('USSD', `USSD request ya muda mrefu/mbaya: session=${sessionId}`);
    return res.status(401).send('END Ombi limefungwa.');
  }

  const expectedPayload = `${sessionId}${phoneNumber}${timestamp}`;
  const expectedSig = crypto
    .createHmac('sha256', config.ussd.secret)
    .update(expectedPayload)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
    logger.warn('USSD', `USSD signature isiyo sahihi: session=${sessionId} phone=${phoneNumber}`);
    return res.status(401).json({ success: false, message: 'USSD signature invalid.' });
  }

  next();
}

/**
 * Per-phone rate limiting for USSD requests.
 * In production, a real gateway would also provide source IP verification.
 */
function ussdRateLimit(req, res, next) {
  const { phoneNumber } = req.body;
  const now = Date.now();
  const entry = ussdRateMap.get(phoneNumber);

  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    ussdRateMap.set(phoneNumber, { count: 1, windowStart: now });
    return next();
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS_PER_MIN) {
    logger.warn('USSD', `USSD rate limit exceeded: ${phoneNumber}`);
    return res.status(429).send('END Ombi nyingi sana. Tafadhali subiri.');
  }

  next();
}

/**
 * Validate phone number format (Tanzania: +255XXXXXXXXX or 255XXXXXXXXX)
 */
function validateUssdPhone(req, res, next) {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).send('END Nambari ya simu inahitajika.');
  }
  const cleaned = phoneNumber.replace(/^\+/, '');
  if (!/^255\d{9}$/.test(cleaned)) {
    return res.status(400).send('END Nambari ya simu si sahihi.');
  }
  req.body.phoneNumber = cleaned;
  next();
}

module.exports = { verifyUssdSignature, ussdRateLimit, validateUssdPhone };
