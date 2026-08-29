/**
 * PIN Reset Service
 * Forgot PIN flow with OTP verification.
 */

const crypto = require('crypto');
const pool = require('../config/db');
const smsService = require('./smsService');
const logger = require('../utils/logger');

const TOKEN_TTL_MINUTES = 10;
const RESET_KEY_TTL_MINUTES = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const REQUEST_COOLDOWN_MS = 60 * 1000;

// In-memory cooldown kwa request (single-process; multi-instance tumia Redis).
const resetRequestLog = new Map();

/**
 * Request PIN reset - sends OTP to phone.
 * - Cooldown 60s kwa namba (anti SMS-flood).
 * - Token kwa crypto.randomInt (si Math.random).
 */
async function requestPinReset(phone) {
  const now = Date.now();
  const last = resetRequestLog.get(phone) || 0;
  if (now - last < REQUEST_COOLDOWN_MS) {
    throw Object.assign(new Error('Subiri kidogo kabla ya kuomba PIN reset tena.'), { statusCode: 429 });
  }
  resetRequestLog.set(phone, now);
  if (resetRequestLog.size > 10000) resetRequestLog.clear();

  const user = await pool.query('SELECT id FROM users WHERE phone_number = $1', [phone]);
  if (user.rows.length === 0) {
    // Usidhihirisha kama namba ipo
    return { success: true, message: 'Ikiwa nambari hii ipo kwenye mfumo, utapokea OTP.' };
  }

  const token = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO pin_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [user.rows[0].id, token, expiresAt]
  );

  try {
    await smsService.sendSMS(phone, `Afrikoba: Nambari yako ya kusawazisha PIN ni ${token}. Itaisha baada ya dakika ${TOKEN_TTL_MINUTES}.`);
  } catch (err) {
    logger.warn('PIN_RESET', `SMS failed: ${err.message}`);
  }

  return { success: true, message: 'OTP imetumwa kwenye nambari yako.' };
}

/**
 * Verify PIN reset OTP.
 * - Attempts limiting: ≥5 → token inabatilishwa.
 */
async function verifyPinReset(phone, token) {
  const user = await pool.query('SELECT id FROM users WHERE phone_number = $1', [phone]);
  if (user.rows.length === 0) {
    throw Object.assign(new Error('Nambari ya simu haipatikani.'), { statusCode: 400 });
  }

  const res = await pool.query(
    `SELECT id, token, attempts FROM pin_reset_tokens
     WHERE user_id = $1 AND expires_at > NOW() AND used = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [user.rows[0].id]
  );
  if (res.rows.length === 0) {
    throw Object.assign(new Error('OTP batili au imeisha muda.'), { statusCode: 400 });
  }
  const rec = res.rows[0];

  if (rec.attempts >= MAX_VERIFY_ATTEMPTS) {
    await pool.query('UPDATE pin_reset_tokens SET used = TRUE WHERE id = $1', [rec.id]);
    throw Object.assign(new Error('Majaribio mengi. Tafadhali omba OTP mpya.'), { statusCode: 429 });
  }

  if (String(rec.token) !== String(token)) {
    await pool.query('UPDATE pin_reset_tokens SET attempts = attempts + 1 WHERE id = $1', [rec.id]);
    throw Object.assign(new Error('OTP batili au imeisha muda.'), { statusCode: 400 });
  }

  await pool.query('UPDATE pin_reset_tokens SET used = TRUE WHERE id = $1', [rec.id]);

  // Reset key kwa hatua ya mwisho (256-bit random, isiyoweza kukadiriwa)
  const resetKey = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO pin_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${RESET_KEY_TTL_MINUTES} minutes')`,
    [user.rows[0].id, resetKey]
  );

  return { success: true, resetKey, userId: user.rows[0].id };
}

/**
 * Complete PIN reset - set new PIN.
 */
async function completePinReset(userId, resetKey, newPin) {
  if (!/^\d{4,6}$/.test(newPin)) {
    throw Object.assign(new Error('PIN lazima iwe na nambari 4-6.'), { statusCode: 400 });
  }

  const result = await pool.query(
    `SELECT id FROM pin_reset_tokens
     WHERE user_id = $1 AND token = $2 AND used = FALSE AND expires_at > NOW()`,
    [userId, resetKey]
  );

  if (result.rows.length === 0) {
    throw Object.assign(new Error('Ukitajo umefuta. Tafadhali omba upya.'), { statusCode: 400 });
  }

  const bcrypt = require('bcryptjs');
  const pinHash = await bcrypt.hash(newPin, 12);

  await pool.query(`UPDATE users SET pin_hash = $1, updated_at = NOW() WHERE id = $2`, [pinHash, userId]);
  await pool.query(`UPDATE pin_reset_tokens SET used = TRUE WHERE id = $1`, [result.rows[0].id]);

  // Batilisha tokeni zingine zote za PIN reset kwa mtumiaji huyu
  await pool.query(
    `UPDATE pin_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE`,
    [userId]
  );

  return { success: true, message: 'PIN imebadilishwa.' };
}

module.exports = { requestPinReset, verifyPinReset, completePinReset };