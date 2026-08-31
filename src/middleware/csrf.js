/**
 * CSRF Protection Middleware
 * Requires a custom header for state-changing requests.
 */

const crypto = require('crypto');

// Generate a random CSRF secret for the session/user
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware to verify the CSRF token
function verifyCsrfToken(req, res, next) {
  // Only verify state-changing methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const csrfToken = req.headers['x-csrf-token'];
  // Simplified verification: Expect it to be present for now, 
  // in a full impl, this would be compared against a server-side session store.
  if (!csrfToken) {
    return res.status(403).json({
      success: false,
      message: 'CSRF token imekosekana.',
      code: 'CSRF_TOKEN_MISSING',
    });
  }
  next();
}

module.exports = { generateCsrfToken, verifyCsrfToken };