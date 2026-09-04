/**
 * Step-Up Authentication Service
 *
 * Requires a fresh second-factor verification (TOTP via otplib, or a step-up SMS OTP
 * sent on request) before a sensitive operation, and issues a short-lived, single-use,
 * purpose-scoped step-up token. Middleware then enforces that token on protected routes.
 */

const crypto = require('crypto');
const pool = require('../config/db');
const logger = require('../utils/logger');
const { verifyToken } = require('./totpService');
const authService = require('./authService');

const STEPUP_TTL_MINUTES = 10;
const STEPUP_OTP_PURPOSE = 'STEPUP';
const VALID_PURPOSES = new Set(['TREASURY_EXECUTE', 'PAYROLL_PAY', 'LARGE_WITHDRAWAL', 'ADMIN_ACTION']);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Request a step-up SMS OTP code (used when the user does not have TOTP enabled).
 */
async function requestStepUpCode(userId) {
  const user = (await pool.query('SELECT phone_number, totp_enabled FROM users WHERE id=$1', [userId])).rows[0];
  if (!user) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });
  if (user.totp_enabled) {
    return { method: 'TOTP', message: 'Use your authenticator app to generate a code.' };
  }
  const code = await authService.sendOtp(user.phone_number, STEPUP_OTP_PURPOSE);
  return { method: 'SMS', message: 'A step-up code was sent to your phone.' };
}

/**
 * Verify a fresh second-factor and issue a short-lived single-use step-up token.
 */
async function issueStepUpToken(userId, purpose, code) {
  if (!VALID_PURPOSES.has(purpose)) throw Object.assign(new Error('Purpose si sahihi.'), { statusCode: 400 });
  if (!code) throw Object.assign(new Error('Kodi ya uthibitisho inahitajika.'), { statusCode: 400 });

  const user = (await pool.query(
    'SELECT id, totp_secret, totp_enabled, phone_number FROM users WHERE id=$1', [userId]
  )).rows[0];
  if (!user) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });

  let verified = false;
  let method = 'UNKNOWN';
  if (user.totp_enabled && user.totp_secret) {
    verified = verifyToken(user.totp_secret, code);
    method = 'TOTP';
  } else {
    const res = await authService.verifyOtp(user.phone_number, code, STEPUP_OTP_PURPOSE);
    verified = !!res.success;
    method = 'SMS';
  }
  if (!verified) throw Object.assign(new Error('Kodi ya uthibitisho si sahihi.'), { statusCode: 403 });

  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + STEPUP_TTL_MINUTES * 60000);
  await pool.query(
    `INSERT INTO stepup_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [userId, purpose, hashToken(raw), expiresAt]
  );
  logger.info('STEPUP', `Step-up token issued for user ${userId} purpose=${purpose} via ${method}`);
  return { purpose, token: raw, expiresInMinutes: STEPUP_TTL_MINUTES };
}

/**
 * Middleware factory: require a valid un-used step-up token for `purpose`.
 * Header: x-stepup-token (consumed on success — single use).
 */
function requireStepUp(purpose) {
  return async (req, res, next) => {
    try {
      const raw = req.headers['x-stepup-token'] || req.body?.stepupToken;
      if (!raw) return res.status(403).json({ success: false, code: 'STEPUP_REQUIRED', purpose, message: res.t('AUTH_STEPUP_REQUIRED') });
      const h = hashToken(raw);
      const row = (await pool.query(
        `SELECT * FROM stepup_tokens WHERE token_hash=$1 AND purpose=$2 ORDER BY id DESC LIMIT 1`,
        [h, purpose]
      )).rows[0];
      if (!row || row.used_at) return res.status(403).json({ success: false, code: 'STEPUP_INVALID', message: res.t('AUTH_STEPUP_INVALID') });
      if (new Date(row.expires_at) < new Date()) return res.status(403).json({ success: false, code: 'STEPUP_EXPIRED', message: res.t('AUTH_STEPUP_EXPIRED') });
      if (row.user_id !== req.user.id) return res.status(403).json({ success: false, code: 'STEPUP_INVALID', message: res.t('AUTH_STEPUP_INVALID') });

      await pool.query(`UPDATE stepup_tokens SET used_at=NOW() WHERE id=$1`, [row.id]);
      next();
    } catch (err) { next(err); }
  };
}

/** Purge expired/unused step-up tokens (call from scheduler). */
async function purgeExpired() {
  const res = await pool.query(`DELETE FROM stepup_tokens WHERE expires_at < NOW() OR used_at IS NOT NULL`);
  if (res.rowCount > 0) logger.info('STEPUP', `Purged ${res.rowCount} step-up tokens`);
  return res.rowCount;
}

module.exports = { issueStepUpToken, requestStepUpCode, requireStepUp, purgeExpired, VALID_PURPOSES };
