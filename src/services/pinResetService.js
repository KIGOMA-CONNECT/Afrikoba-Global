/**
 * PIN Reset Service
 * Forgot PIN flow with OTP verification.
 */

const crypto = require('crypto');
const pool = require('../config/db');
const smsService = require('./smsService');
const logger = require('../utils/logger');

/**
 * Request PIN reset - sends OTP to phone.
 */
async function requestPinReset(phone) {
  const user = await pool.query(`SELECT id, phone FROM users WHERE phone = $1`, [phone]);
  if (user.rows.length === 0) {
    // Don't reveal if user exists
    return { success: true, message: 'Ikiwa nambari hii ipo kwenye mfumo, utapokea OTP.' };
  }

  const token = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await pool.query(
    `INSERT INTO pin_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [user.rows[0].id, token, expiresAt]
  );

  try {
    await smsService.sendSms(phone, `Afrikoba: Nambari yako ya kusawazisha PIN ni ${token}. Itaisha baada ya dakika 10.`);
  } catch (err) {
    logger.warn('PIN_RESET', `SMS failed: ${err.message}`);
  }

  return { success: true, message: 'OTP imetumwa kwenye nambari yako.' };
}

/**
 * Verify PIN reset OTP.
 */
async function verifyPinReset(phone, token) {
  const user = await pool.query(`SELECT id FROM users WHERE phone = $1`, [phone]);
  if (user.rows.length === 0) {
    throw new Error('Nambari ya simu haipatikani.');
  }

  const result = await pool.query(
    `SELECT id FROM pin_reset_tokens
     WHERE user_id = $1 AND token = $2 AND used = FALSE AND expires_at > NOW()`,
    [user.rows[0].id, token]
  );

  if (result.rows.length === 0) {
    throw new Error('OTP batili au imeisha muda.');
  }

  // Mark token as used
  await pool.query(`UPDATE pin_reset_tokens SET used = TRUE WHERE id = $1`, [result.rows[0].id]);

  // Generate reset key for next step
  const resetKey = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO pin_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
    [user.rows[0].id, resetKey]
  );

  return { success: true, resetKey, userId: user.rows[0].id };
}

/**
 * Complete PIN reset - set new PIN.
 */
async function completePinReset(userId, resetKey, newPin) {
  if (!/^\d{4,6}$/.test(newPin)) {
    throw new Error('PIN lazima iwe na nambari 4-6.');
  }

  const result = await pool.query(
    `SELECT id FROM pin_reset_tokens
     WHERE user_id = $1 AND token = $2 AND used = FALSE AND expires_at > NOW()`,
    [userId, resetKey]
  );

  if (result.rows.length === 0) {
    throw new Error('Ukitajo umefuta. Tafadhali omba upya.');
  }

  // Hash and update PIN
  const bcrypt = require('bcryptjs');
  const pinHash = await bcrypt.hash(newPin, 12);

  await pool.query(`UPDATE users SET pin_hash = $1, updated_at = NOW() WHERE id = $2`, [pinHash, userId]);
  await pool.query(`UPDATE pin_reset_tokens SET used = TRUE WHERE id = $1`, [result.rows[0].id]);

  // Invalidate all other reset tokens
  await pool.query(
    `UPDATE pin_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE`,
    [userId]
  );

  return { success: true, message: 'PIN imebadilishwa.' };
}

module.exports = { requestPinReset, verifyPinReset, completePinReset };
