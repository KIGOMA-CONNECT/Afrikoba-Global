const express = require('express');
const authService = require('../services/authService');
const serviceService = require('../services/serviceService');
const { signToken, authRequired } = require('../middleware/auth');
const { otpLimiter, authLimiter } = require('../middleware/rateLimiter');
const { toInternationalFormat } = require('../utils/helpers');
const { validate } = require('../middleware/validate');
const schemas = require('../validations/schemas');
const logger = require('../utils/logger');

const router = express.Router();

// Tuma OTP (Login / Usajili) - rate-limited dhidi ya brute force
router.post('/send-otp', otpLimiter, validate(schemas.auth.sendOtp), async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;
    const otp = await authService.sendOtp(phoneNumber, 'LOGIN');
    logger.info('AUTH', `OTP imetumwa kwenda ${toInternationalFormat(phoneNumber)}`);
    if (process.env.NODE_ENV !== 'production') {
      return res.json({ success: true, message: 'OTP imetumwa.', devOtp: otp });
    }
    return res.json({ success: true, message: 'OTP imetumwa kwenye simu yako.' });
  } catch (error) {
    next(error);
  }
});

// Login kwa OTP
router.post('/login', authLimiter, validate(schemas.auth.login), async (req, res, next) => {
  try {
    const { phoneNumber, otp } = req.body;

    const result = await authService.verifyOtp(phoneNumber, otp, 'LOGIN');
    if (!result.success) return res.status(400).json(result);

    const pool = require('../config/db');
    const userRes = await pool.query(
      `SELECT id, full_name, phone_number, email, role, kyc_level, wallet_balance,
              locked_balance, trust_score, nida_number, is_active, currency_code
       FROM users WHERE phone_number = $1`,
      [toInternationalFormat(phoneNumber)]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Huna akaunti. Sajili kwanza.' });
    }
    const user = userRes.rows[0];
    const services = await serviceService.getUserServices(user.id);
    const token = signToken(user);
    return res.json({ success: true, token, user: { ...user, services } });
  } catch (error) {
    next(error);
  }
});

// Usajili mpya
router.post('/register', authLimiter, validate(schemas.auth.register), async (req, res, next) => {
  try {
    const { fullName, phoneNumber, email, password, otp, nidaNumber } = req.body;
    const otpCheck = await authService.verifyOtp(phoneNumber, otp, 'LOGIN');
    if (!otpCheck.success) return res.status(400).json(otpCheck);

    const user = await authService.registerUser({ fullName, phoneNumber, email, password, nidaNumber });
    await serviceService.openWallet(user.id);
    user.services = ['WALLET'];
    const token = signToken(user);
    return res.status(201).json({ success: true, token, user });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'Namba ya simu au email tayari imesajiliwa.' });
    }
    next(error);
  }
});

// Login kwa Email + Password
router.post('/login/password', authLimiter, validate(schemas.auth.loginPassword), async (req, res, next) => {
  try {
    const { emailOrPhone, password } = req.body;
    const result = await authService.loginWithPassword(emailOrPhone, password);
    if (!result.success) return res.status(401).json(result);
    const services = await serviceService.getUserServices(result.user.id);

    // Check if TOTP 2FA is enabled
    const pool = require('../config/db');
    const totpRes = await pool.query('SELECT totp_enabled FROM users WHERE id = $1', [result.user.id]);
    if (totpRes.rows[0]?.totp_enabled) {
      const tempToken = signToken({ ...result.user, totp_pending: true }, '5m');
      return res.json({ success: true, requires2FA: true, tempToken, message: 'Ingiza kodi ya TOTP.' });
    }

    const token = signToken(result.user);
    return res.json({ success: true, token, user: { ...result.user, services } });
  } catch (error) {
    next(error);
  }
});

// TOTP 2FA login — verify tempToken + TOTP code, return full JWT
router.post('/totp-login', authLimiter, async (req, res, next) => {
  try {
    const { tempToken, token: totpCode } = req.body;
    if (!tempToken || !totpCode) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'tempToken na totpCode zinahitajika.' });
    }

    const jwt = require('jsonwebtoken');
    let decoded;
    try {
      decoded = jwt.verify(tempToken, require('../config').security.jwtSecret);
    } catch (e) {
      return res.status(401).json({ success: false, code: 'AUTH_EXPIRED_TOKEN', message: 'TempToken imeisha. Tafadhali ingia tena.' });
    }

    if (!decoded.totp_pending) {
      return res.status(400).json({ success: false, message: 'Token si ya TOTP login.' });
    }

    const pool = require('../config/db');
    const userRes = await pool.query('SELECT id, role, phone_number, totp_secret FROM users WHERE id = $1', [decoded.id]);
    const user = userRes.rows[0];
    if (!user || !user.totp_secret) {
      return res.status(400).json({ success: false, message: 'TOTP haijaanzishwa kwa mtumiaji huyu.' });
    }

    const { verifyToken } = require('../services/totpService');
    if (!verifyToken(user.totp_secret, totpCode)) {
      return res.status(403).json({ success: false, code: 'AUTH_INVALID_OTP', message: 'Kodi ya TOTP si sahihi.' });
    }

    const services = await serviceService.getUserServices(user.id);
    const fullToken = signToken(user);
    return res.json({ success: true, token: fullToken, user: { id: user.id, role: user.role, phone_number: user.phone_number, services } });
  } catch (error) {
    next(error);
  }
});

// Weka PIN (4 digits)
router.post('/pin', authRequired, validate(schemas.auth.pin), async (req, res, next) => {
  try {
    const { pin } = req.body;
    await authService.setupPin(req.user.id, pin);
    return res.json({ success: true, message: 'PIN imewekwa.' });
  } catch (error) {
    next(error);
  }
});

// KYC Upgrade - Level 2 (NIDA + Anwani)
router.post('/kyc', authRequired, async (req, res, next) => {
  try {
    const { nidaNumber, residentialAddress, idDocumentUrl } = req.body;
    const pool = require('../config/db');
    await pool.query(
      `UPDATE users
       SET nida_number = COALESCE($1, nida_number),
           residential_address = COALESCE($2, residential_address),
           id_document_url = COALESCE($3, id_document_url),
           kyc_level = 2
       WHERE id = $4`,
      [nidaNumber || null, residentialAddress || null, idDocumentUrl || null, req.user.id]
    );
    return res.json({ success: true, message: 'KYC Level 2 imethibitishwa.' });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ success: false, message: 'NIDA tayari imetumika.' });
    next(error);
  }
});

// Profaili yangu
router.get('/me', authRequired, async (req, res, next) => {
  try {
    const services = await serviceService.getUserServices(req.user.id);
    res.json({ success: true, user: { ...req.user, services } });
  } catch (error) {
    next(error);
  }
});

// PATCH /profile — Sasisha profaili
router.patch('/profile', authRequired, async (req, res, next) => {
  try {
    const { fullName, email } = req.body;
    const pool = require('../config/db');
    const updates = [];
    const params = [];
    let idx = 1;
    if (fullName) { updates.push(`full_name = $${idx++}`); params.push(fullName); }
    if (email) { updates.push(`email = $${idx++}`); params.push(email); }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'Hakuna kitu cha kubadilisha.' });
    params.push(req.user.id);
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    return res.json({ success: true, message: 'Profaili imesasishwa.' });
  } catch (error) {
    next(error);
  }
});

// Refresh access token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token inahitajika.' });

    const { refreshAccessToken } = require('../middleware/sessionManager');
    const result = await refreshAccessToken(refreshToken);
    return res.json({ success: true, ...result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
});

// Logout (revoke token)
router.post('/logout', authRequired, async (req, res, next) => {
  try {
    const { revokeToken } = require('../middleware/sessionManager');
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      await revokeToken(token);
    }
    return res.json({ success: true, message: 'Umeondoka.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
