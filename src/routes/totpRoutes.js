const express = require('express');
const totpService = require('../services/totpService');
const { authRequired } = require('../middleware/auth');
const pool = require('../config/db');

const router = express.Router();
router.use(authRequired);

/**
 * POST /totp/setup — Generate TOTP secret + QR URL
 * Client displays otpauthUrl as QR code in authenticator app.
 */
router.post('/setup', async (req, res, next) => {
  try {
    const result = await totpService.setupTotp(req.user.id);
    return res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /totp/verify — Verify first code + enable 2FA
 */
router.post('/verify', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Kodi ya TOTP lazima iwe nambari ya tarakibu 6.' });
    }
    const result = await totpService.verifyAndEnable(req.user.id, token);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /totp/status — Check TOTP 2FA status
 */
router.get('/status', async (req, res, next) => {
  try {
    const status = await totpService.getTotpStatus(req.user.id);
    return res.json({ success: true, ...status });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /totp/disable — Disable TOTP 2FA (requires current TOTP code)
 */
router.post('/disable', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Kodi ya TOTP lazima iwe nambari ya tarakibu 6.' });
    }

    const dbResult = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
    const secret = dbResult.rows[0]?.totp_secret;
    if (!secret) {
      return res.status(400).json({ success: false, message: 'TOTP haijaanzishwa.' });
    }
    if (!totpService.verifyToken(secret, token)) {
      return res.status(403).json({ success: false, code: 'AUTH_INVALID_OTP', message: 'Kodi ya TOTP si sahihi.' });
    }

    const result = await totpService.disableTotp(req.user.id);
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
