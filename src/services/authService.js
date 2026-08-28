const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config');
const { sendSMS } = require('./smsService');
const { toInternationalFormat } = require('../utils/helpers');
const logger = require('../utils/logger');

const OTP_TTL_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;

// In-memory rate limiter (single-process). Kwa multi-instance, tumia Redis.
const sendLog = new Map();

function generateOtp() {
  return crypto.randomInt(100000, 999999).toString();
}

function checkSendRate(phone) {
  const cooldownMs = config.nodeEnv === 'production' ? 60 * 1000 : 5000;
  const now = Date.now();
  const last = sendLog.get(phone) || 0;
  if (now - last < cooldownMs) {
    const waitSeconds = Math.ceil((cooldownMs - (now - last)) / 1000);
    throw Object.assign(
      new Error(`Subiri sekunde ${waitSeconds} kabla ya kutuma OTP tena.`),
      { statusCode: 429 }
    );
  }
  sendLog.set(phone, now);
  if (sendLog.size > 10000) sendLog.clear();
}

async function sendOtp(phoneNumber, purpose = 'LOGIN') {
  const phone = toInternationalFormat(phoneNumber);
  checkSendRate(phone);
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO otp_codes (phone_number, otp_code, purpose, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [phone, otp, purpose, expiresAt]
  );

  const message = `AFRIKOBA: Msimbo wako wa uthibitisho ni ${otp}. Unamalizika ndani ya dakika ${OTP_TTL_MINUTES}. Usimpe mtu yeyote!`;
  await sendSMS(phone, message);
  return otp;
}

async function verifyOtp(phoneNumber, otpCode, purpose = 'LOGIN') {
  const phone = toInternationalFormat(phoneNumber);
  const result = await pool.query(
    `SELECT * FROM otp_codes
     WHERE phone_number = $1 AND purpose = $2 AND used = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose]
  );
  if (result.rows.length === 0) return { success: false, message: 'OTP haujapatikana.' };
  const record = result.rows[0];
  if (new Date() > new Date(record.expires_at)) {
    return { success: false, message: 'OTP umemalizika muda wake.' };
  }
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [record.id]);
    return { success: false, message: 'OTP umeshatumika mara nyingi. Tuma OTP mpya.' };
  }
  if (String(record.otp_code) !== String(otpCode)) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [record.id]);
    const remaining = MAX_OTP_ATTEMPTS - (record.attempts + 1);
    return {
      success: false,
      message: remaining <= 0
        ? 'OTP si sahihi. Tuma OTP mpya.'
        : `OTP si sahihi. Umebakiwa na majaribio ${remaining}.`,
    };
  }
  await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [record.id]);
  return { success: true, record };
}

async function registerUser({ fullName, phoneNumber, email, password, nidaNumber }) {
  const phone = toInternationalFormat(phoneNumber);
  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;

  const result = await pool.query(
    `INSERT INTO users (full_name, phone_number, email, password_hash, nida_number)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, full_name, phone_number, email, kyc_level, role, wallet_balance, trust_score, created_at`,
    [fullName, phone, email || null, passwordHash, nidaNumber || null]
  );
  return result.rows[0];
}

async function setupPin(userId, pin) {
  if (!/^\d{4}$/.test(String(pin))) {
    throw new Error('PIN lazima iwe tarakimu 4.');
  }
  const pinHash = bcrypt.hashSync(String(pin), 10);
  await pool.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [pinHash, userId]);
  return { success: true };
}

async function verifyPin(userId, pin) {
  const result = await pool.query('SELECT pin_hash FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) return false;
  if (!result.rows[0].pin_hash) return false;
  return bcrypt.compareSync(String(pin), result.rows[0].pin_hash);
}

async function loginWithPassword(emailOrPhone, password) {
  const isEmail = String(emailOrPhone).includes('@');
  const query = isEmail
    ? 'SELECT * FROM users WHERE email = $1'
    : 'SELECT * FROM users WHERE phone_number = $1';
  const key = isEmail ? String(emailOrPhone).trim() : toInternationalFormat(emailOrPhone);
  const result = await pool.query(query, [key]);
  if (result.rows.length === 0) return { success: false, message: 'Akaunti haijapatikana.' };
  const user = result.rows[0];
  if (!user.password_hash || !bcrypt.compareSync(String(password), user.password_hash)) {
    return { success: false, message: 'Kitambulisho si sahihi.' };
  }
  delete user.password_hash;
  delete user.pin_hash;
  return { success: true, user };
}

module.exports = { sendOtp, verifyOtp, registerUser, setupPin, verifyPin, loginWithPassword };
