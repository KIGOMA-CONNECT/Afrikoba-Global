const express = require('express');
const walletService = require('../services/walletService');
const logger = require('../utils/logger');

const router = express.Router();

// AzamPay Payment Callback - security middleware chain imewekwa kwenye server.js mount kabla ya callback route
router.post('/azampay-callback', async (req, res, next) => {
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
