/**
 * Security Hardening Middleware
 * Additional security layers beyond helmet defaults.
 */

const logger = require('../utils/logger');
const { tr, localizeError } = require('../i18n');

/**
 * H1: Enhanced security headers
 */
function securityHeaders(req, res, next) {
  // HSTS with preload (force HTTPS)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer policy (protect sensitive URLs)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy (disable browser features)
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Cache control for API responses (prevent caching sensitive data)
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  // Remove server identification
  res.removeHeader('X-Powered-By');

  next();
}

/**
 * H4: Request body size limits + content-type validation
 */
function requestValidation(req, res, next) {
  // Block requests with no content-type for POST/PUT/PATCH
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.get('Content-Type');
    if (!contentType) {
      return res.status(415).json({
        success: false,
        message: res.t('CONTENT_TYPE_REQUIRED'),
        code: 'VALIDATION_ERROR',
      });
    }
    // Allow JSON, form-data, x-www-form-urlencoded, and text/plain
    // (text/plain ni kwa partner-signed BaaS endpoints - secured via HMAC)
    const allowed = ['application/json', 'multipart/form-data', 'application/x-www-form-urlencoded', 'text/plain'];
    const isAllowed = allowed.some(t => contentType.toLowerCase().includes(t));
    if (!isAllowed) {
      return res.status(415).json({
        success: false,
        message: res.t('CONTENT_TYPE_DENIED'),
        code: 'VALIDATION_ERROR',
      });
    }
  }

  // Block requests with suspicious user agents
  const ua = req.get('User-Agent') || '';
  const blockedPatterns = [
    /sqlmap/i, /nikto/i, /nessus/i, /openvas/i,
    /masscan/i, /nmap/i, /dirbuster/i, /gobuster/i,
    /hydra/i, /john/i, /hashcat/i, /burp/i,
    /owasp/i, /metasploit/i, /curl.*python/i,
  ];
  if (blockedPatterns.some(p => p.test(ua))) {
    logger.warn('SECURITY', `Blocked suspicious UA: ${ua} from ${req.ip}`);
    return res.status(403).json({
      success: false,
      message: 'Access imezuiwa.',
      code: 'FORBIDDEN',
    });
  }

  next();
}

/**
 * H6: Suspicious activity detection
 */
const suspiciousActivityTracker = new Map();

function trackSuspiciousActivity(req, res, next) {
  // Test-mode bypass: integration tests simulate many users from one IP.
  // Production never sets this — suspicious-activity blocking stays active.
  if (process.env.DISABLE_RATE_LIMIT === 'true' || process.env.RATE_LIMIT_DISABLED === 'true') {
    return next();
  }
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 200;

  if (!suspiciousActivityTracker.has(ip)) {
    suspiciousActivityTracker.set(ip, { count: 1, firstSeen: now });
    return next();
  }

  const tracker = suspiciousActivityTracker.get(ip);

  // Reset if window expired
  if (now - tracker.firstSeen > windowMs) {
    suspiciousActivityTracker.set(ip, { count: 1, firstSeen: now });
    return next();
  }

  tracker.count++;

  // Log suspicious IPs
  if (tracker.count > 50) {
    logger.warn('SECURITY', `Suspicious activity from ${ip}: ${tracker.count} requests in ${Math.round((now - tracker.firstSeen) / 60000)} min`);
  }

  // Block if too many requests
  if (tracker.count > maxAttempts) {
    logger.error('SECURITY', `BLOCKED IP ${ip}: ${tracker.count} requests in ${Math.round((now - tracker.firstSeen) / 60000)} min`);
    suspiciousActivityTracker.delete(ip);
    return res.status(429).json({
      success: false,
      message: res.t('TOO_MANY_REQUESTS'),
      code: 'RATE_LIMIT',
    });
  }

  next();
}

// Cleanup tracker every 15 minutes
setInterval(() => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  for (const [ip, tracker] of suspiciousActivityTracker) {
    if (now - tracker.firstSeen > windowMs) {
      suspiciousActivityTracker.delete(ip);
    }
  }
}, 15 * 60 * 1000);

/**
 * H9: CORS strict enforcement
 */
function strictCors(req, res, next) {
  const origin = req.get('Origin');

  // Block requests with no origin (non-browser)
  // Allow same-origin and known origins
  if (origin) {
    const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim());
    if (!allowedOrigins.includes(origin) && !allowedOrigins.includes('*')) {
      logger.warn('SECURITY', `Blocked CORS origin: ${origin} from ${req.ip}`);
      return res.status(403).json({
        success: false,
        message: res.t('ORIGIN_DENIED'),
        code: 'FORBIDDEN',
      });
    }
  }

  next();
}

/**
 * H8: Error handling hardening (no stack traces in production)
 */
function secureErrorHandler(err, req, res, next) {
  const isDev = process.env.NODE_ENV !== 'production';

  // Log the full error internally
  logger.error('ERROR', `${err.message} - ${req.method} ${req.path} - ${req.ip}`);

  // Send sanitized error to client (localized 4xx business messages, generic 5xx)
  const statusCode = err.statusCode || err.status || 500;
  const isServerError = statusCode >= 500;
  const response = {
    success: false,
    message: isServerError ? (isDev && !err.code ? err.message : tr('INTERNAL_ERROR', req.locale || 'sw')) : localizeError(err, req.locale || 'sw'),
    code: err.code || (isServerError ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'),
  };

  // Include request ID if available
  if (req.id) response.requestId = req.id;

  // Include stack trace only in development
  if (isDev && err.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = {
  securityHeaders,
  requestValidation,
  trackSuspiciousActivity,
  strictCors,
  secureErrorHandler,
};
