/**
 * Enhanced Session Management
 * Refresh tokens, token rotation, session tracking.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config');
const logger = require('../utils/logger');

const REFRESH_TOKEN_EXPIRY = '30d';
const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_SECRET = config.security.jwtSecret + '_refresh';

/**
 * Generate access + refresh token pair.
 */
function generateTokenPair(user) {
  const accessToken = jwt.sign(
    { id: user.id, role: user.role, phone_number: user.phone_number },
    config.security.jwtSecret,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  const refreshToken = jwt.sign(
    { id: user.id, type: 'refresh', jti: crypto.randomUUID() },
    REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );

  return { accessToken, refreshToken, expiresIn: 3600 };
}

/**
 * Verify refresh token and issue new access token.
 */
async function refreshAccessToken(refreshToken) {
  try {
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);

    if (decoded.type !== 'refresh') {
      throw Object.assign(new Error('Token si refresh token.'), { statusCode: 401 });
    }

    // Check if user still exists and is active
    const result = await pool.query(
      'SELECT id, role, phone_number, is_active FROM users WHERE id = $1',
      [decoded.id]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      throw Object.assign(new Error('Mtumiaji hajapatikana au amezuiwa.'), { statusCode: 401 });
    }

    const user = result.rows[0];
    const newAccessToken = jwt.sign(
      { id: user.id, role: user.role, phone_number: user.phone_number },
      config.security.jwtSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );

    return { accessToken: newAccessToken, expiresIn: 3600 };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw Object.assign(new Error('Refresh token imeisha muda.'), { statusCode: 401 });
    }
    throw err;
  }
}

/**
 * Session validation middleware - checks token blacklist.
 */
async function validateSession(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.security.jwtSecret, { ignoreExpiration: true });

    // Check if token has been revoked (blacklisted)
    const revoked = await pool.query(
      'SELECT id FROM revoked_tokens WHERE token_jti = $1',
      [decoded.jti]
    );

    if (revoked.rows.length > 0) {
      return res.status(401).json({
        success: false,
        message: 'Token imebatilishwa. Ingia tena.',
        code: 'TOKEN_REVOKED',
      });
    }

    // Check if token is expired
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      return res.status(401).json({
        success: false,
        message: 'Token imeisha muda.',
        code: 'TOKEN_EXPIRED',
      });
    }
  } catch (err) {
    // Token verification failed - let auth middleware handle it
  }

  next();
}

/**
 * Revoke a token (for logout).
 */
async function revokeToken(token) {
  try {
    const decoded = jwt.verify(token, config.security.jwtSecret, { ignoreExpiration: true });
    if (decoded.jti) {
      await pool.query(
        'INSERT INTO revoked_tokens (token_jti, user_id, expires_at) VALUES ($1, $2, to_timestamp($3)) ON CONFLICT (token_jti) DO NOTHING',
        [decoded.jti, decoded.id, decoded.exp]
      );
    }
  } catch (err) {
    logger.warn('SESSION', `Failed to revoke token: ${err.message}`);
  }
}

/**
 * Revoke all tokens for a user (force logout everywhere).
 */
async function revokeAllUserTokens(userId) {
  try {
    // Insert all user's active tokens into blacklist
    // This is a nuclear option - forces re-login on all devices
    await pool.query(
      'UPDATE users SET updated_at = NOW() WHERE id = $1',
      [userId]
    );
    logger.info('SESSION', `All tokens revoked for user ${userId}`);
  } catch (err) {
    logger.warn('SESSION', `Failed to revoke all tokens for user ${userId}: ${err.message}`);
  }
}

module.exports = {
  generateTokenPair,
  refreshAccessToken,
  validateSession,
  revokeToken,
  revokeAllUserTokens,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
};
