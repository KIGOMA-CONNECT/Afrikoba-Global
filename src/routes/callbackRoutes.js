const express = require('express');
const walletService = require('../services/walletService');
const { verifyWebhookSecurity } = require('../middleware/webhookGuard');
const logger = require('../utils/logger');

const router = express.Router();

// AzamPay Payment Callback - INALINDWA na webhook guard (server.js mount inaongeza limiter + replay + HMAC)
router.post('/azampay-callback', verifyWebhookSecurity, async (req, res, next) => {
  try {
    const result = await walletService.processDepositCallback(req.body);
    const status = result.code === 404 ? 404 : result.duplicate ? 200 : 200;
    return res.status(status).json(result);
  } catch (error) {
    logger.error('CALLBACK', error.message);
    next(error);
  }
});

module.exports = router;
