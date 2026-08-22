const { authenticator } = require('otplib');
const pool = require('../config/db');
const config = require('../config');

/**
 * TOTP 2FA service — optional second factor beyond SMS OTP.
 * Uses otplib (RFC 6238 compliant).
 */

/**
 * Generate a new TOTP secret for a user.
 * Returns { secret, otpauthUrl } — client displays otpauthUrl as QR code.
 */
async function setupTotp(userId) {
  const secret = authenticator.generateSecret();
  const user = await pool.query('SELECT phone_number FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });

  const otpauthUrl = authenticator.keyuri(user.rows[0].phone_number, 'Afrikoba Global', secret);

  // Store secret (not enabled yet — must verify first)
  await pool.query(
    'UPDATE users SET totp_secret = $1, totp_enabled = FALSE WHERE id = $2',
    [secret, userId]
  );

  return { secret, otpauthUrl };
}

/**
 * Verify a TOTP code and enable 2FA for the user.
 * Call this after user scans QR code and enters first code.
 */
async function verifyAndEnable(userId, token) {
  const user = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });

  const secret = user.rows[0].totp_secret;
  if (!secret) throw Object.assign(new Error('TOTP haijaanzishwa. Anza na /totp/setup.'), { statusCode: 400 });

  const isValid = authenticator.verify({ token, secret });
  if (!isValid) throw Object.assign(new Error('Kodi ya TOTP si sahihi.'), { statusCode: 403 });

  await pool.query(
    'UPDATE users SET totp_enabled = TRUE, totp_verified_at = NOW() WHERE id = $1',
    [userId]
  );

  return { success: true, message: 'TOTP 2FA imewashwa.' };
}

/**
 * Verify a TOTP code during login/transaction.
 * Returns true/false.
 */
function verifyToken(secret, token) {
  if (!secret) return false;
  return authenticator.verify({ token, secret });
}

/**
 * Disable TOTP 2FA for a user.
 */
async function disableTotp(userId) {
  await pool.query(
    'UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_verified_at = NULL WHERE id = $1',
    [userId]
  );
  return { success: true, message: 'TOTP 2FA imezimwa.' };
}

/**
 * Get TOTP status for a user.
 */
async function getTotpStatus(userId) {
  const user = await pool.query('SELECT totp_enabled, totp_verified_at FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });
  return {
    enabled: user.rows[0].totp_enabled || false,
    verifiedAt: user.rows[0].totp_verified_at,
  };
}

module.exports = { setupTotp, verifyAndEnable, verifyToken, disableTotp, getTotpStatus };
