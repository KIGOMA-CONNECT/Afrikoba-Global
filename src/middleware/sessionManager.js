/**
 * Enhanced Session Management
 * Refresh tokens with rotation + reuse detection, session tracking.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config');
const logger = require('../utils/logger');

const REFRESH_TOKEN_EXPIRY = '30d';
const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_SECRET = config.security.jwtSecret + '_refresh';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate access + refresh token pair. Refresh token hifadhiwa DB.
 */
async function generateTokenPair(user) {
  const accessToken = jwt.sign(
    { id: user.id, role: user.role, phone_number: user.phone_number, av: user.auth_version || 0, jti: crypto.randomUUID() },
    config.security.jwtSecret,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  const refreshToken = jwt.sign(
    { id: user.id, type: 'refresh', jti: crypto.randomUUID(), av: user.auth_version || 0 },
    REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );

  // Hifadhi refresh token hash
  try {
    const tokenHash = hashToken(refreshToken);
    const decoded = jwt.decode(refreshToken);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, to_timestamp($3))`,
      [user.id, tokenHash, decoded.exp]
    );
  } catch (err) {
    logger.warn('SESSION', `Failed to store refresh token: ${err.message}`);
  }

  return { accessToken, refreshToken, expiresIn: 3600 };
}

/**
 * Refresh access token + rotate refresh token.
 * Reuse detection: token ya zamani ilishafutwa → revoke ALL user sessions.
 */
async function refreshAccessToken(refreshToken) {
  try {
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);

    if (decoded.type !== 'refresh') {
      throw Object.assign(new Error('Token si refresh token.'), { statusCode: 401 });
    }

    // Check if user still exists and is active
    const result = await pool.query(
      'SELECT id, role, phone_number, is_active, auth_version FROM users WHERE id = $1',
      [decoded.id]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      throw Object.assign(new Error('Mtumiaji hajapatikana au amezuiwa.'), { statusCode: 401 });
    }

    // auth_version check (password change → revoke all)
    if (decoded.av !== (result.rows[0].auth_version || 0)) {
      throw Object.assign(new Error('Kipindi kimeisha. Ingia tena.'), { statusCode: 401 });
    }

    // Reuse detection: token hash ipo?
    const tokenHash = hashToken(refreshToken);
    const tokenRow = await pool.query(
      'SELECT id FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash]
    );

    if (tokenRow.rows.length === 0) {
      // Token imeisha — reuse ya token ya zamani → revoke ALL sessions
      logger.warn('SESSION', `Refresh token reuse detected for user ${decoded.id} — revoking all sessions`);
      await pool.query('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [decoded.id]);
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [decoded.id]);
      throw Object.assign(new Error('Refresh token imebatilishwa. Ingia tena.'), { statusCode: 401 });
    }

    // Futa token ya zamani (consumed)
    await pool.query('DELETE FROM refresh_tokens WHERE id = $1', [tokenRow.rows[0].id]);

    // Toka user mpya
    const user = result.rows[0];

    // Toka access token mpya
    const newAccessToken = jwt.sign(
      { id: user.id, role: user.role, phone_number: user.phone_number, av: user.auth_version || 0, jti: crypto.randomUUID() },
      config.security.jwtSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );

    // Toka refresh token mpya + hifadhi
    const newRefreshToken = jwt.sign(
      { id: user.id, type: 'refresh', jti: crypto.randomUUID(), av: user.auth_version || 0 },
      REFRESH_TOKEN_SECRET,
      { expiresIn: REFRESH_TOKEN_EXPIRY }
    );
    try {
      const newHash = hashToken(newRefreshToken);
      const newDecoded = jwt.decode(newRefreshToken);
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, to_timestamp($3))`,
        [user.id, newHash, newDecoded.exp]
      );
    } catch (err) {
      logger.warn('SESSION', `Failed to store new refresh token: ${err.message}`);
    }

    return { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: 3600 };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw Object.assign(new Error('Refresh token imeisha muda.'), { statusCode: 401 });
    }
    throw err;
  }
}

/**
 * Revoke a specific refresh token.
 */
async function revokeRefreshToken(refreshToken) {
  try {
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET, { ignoreExpiration: true });
    if (decoded.jti) {
      await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)]);
    }
  } catch (err) {
    logger.warn('SESSION', `Failed to revoke refresh token: ${err.message}`);
  }
}

/**
 * Revoke ALL tokens for a user (force logout everywhere).
 */
async function revokeAllUserTokens(userId) {
  try {
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
    await pool.query(
      'UPDATE users SET auth_version = auth_version + 1 WHERE id = $1',
      [userId]
    );
    logger.info('SESSION', `All tokens revoked for user ${userId}`);
  } catch (err) {
    logger.warn('SESSION', `Failed to revoke all tokens for user ${userId}: ${err.message}`);
  }
}

/**
 * Revoke an access token (for logout — jti blacklist).
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
 * Cleanup expired refresh tokens (call periodically).
 */
async function cleanupExpiredRefreshTokens() {
  try {
    const res = await pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
    if (res.rowCount > 0) {
      logger.info('SESSION', `Cleaned up ${res.rowCount} expired refresh tokens`);
    }
  } catch (err) {
    logger.warn('SESSION', `Failed to cleanup expired refresh tokens: ${err.message}`);
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

module.exports = {
  generateTokenPair,
  refreshAccessToken,
  revokeToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  cleanupExpiredRefreshTokens,
  validateSession,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
};
