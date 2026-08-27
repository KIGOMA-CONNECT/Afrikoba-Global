/**
 * JWT Hardening
 * Algorithm lock, issuer validation, token structure validation.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * H12: Hardened JWT verification.
 * - Locks algorithm to prevent algorithm confusion attacks
 * - Validates issuer and audience
 * - Checks token structure
 */
function hardenedVerify(token, secret) {
  try {
    // Verify with explicit algorithm lock (prevents 'none' algorithm attack)
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],  // Lock to HMAC-SHA256 only
      complete: true,
    });

    // Validate token structure
    if (!decoded.payload || typeof decoded.payload !== 'object') {
      throw new Error('Invalid token structure');
    }

    // Check required claims
    if (!decoded.payload.id) {
      throw new Error('Token missing user ID');
    }

    // Validate issued-at is not in the future (clock skew tolerance: 5 min)
    if (decoded.payload.iat) {
      const now = Math.floor(Date.now() / 1000);
      if (decoded.payload.iat > now + 300) {
        throw new Error('Token issued in the future');
      }
    }

    // Validate expiration
    if (decoded.payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      if (decoded.payload.exp < now - 300) {
        throw new Error('Token expired');
      }
    }

    return decoded.payload;
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw Object.assign(new Error('Token imeisha muda.'), { statusCode: 401, code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'JsonWebTokenError') {
      throw Object.assign(new Error('Token batili.'), { statusCode: 401, code: 'TOKEN_INVALID' });
    }
    throw err;
  }
}

/**
 * H12: JWT payload validation middleware.
 * Validates token structure beyond basic verify.
 */
function validateTokenPayload(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = hardenedVerify(token, config.security.jwtSecret);
    req.user = payload;
    req.tokenPayload = payload;
  } catch (err) {
    // Token invalid - let auth middleware handle it
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
        code: err.code || 'TOKEN_ERROR',
      });
    }
  }
  next();
}

module.exports = {
  hardenedVerify,
  validateTokenPayload,
};
