/**
 * CSRF Protection Middleware
 * Protects state-changing endpoints while allowing token-based API clients.
 */

const crypto = require('crypto');

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function verifyCsrfToken(req, res, next) {
  // Safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Token-based API clients (Bearer token, API key, webhook signature) are immune to CSRF
  if (req.headers.authorization || req.headers['x-api-key'] || req.headers['x-webhook-signature']) {
    return next();
  }

  // Webhooks, USSD, and health routes are immune
  if (req.path.startsWith('/payments') || req.path.startsWith('/ussd') || req.path.startsWith('/health')) {
    return next();
  }

  // JSON APIs with Content-Type application/json or x-csrf-token are allowed
  if (req.is('application/json') || req.headers['x-csrf-token'] || req.headers['x-requested-with']) {
    return next();
  }

  // Non-JSON without authentication or CSRF token is rejected
  return res.status(403).json({
    success: false,
    message: 'CSRF token imekosekana.',
    code: 'CSRF_TOKEN_MISSING',
  });
}

module.exports = { generateCsrfToken, verifyCsrfToken };