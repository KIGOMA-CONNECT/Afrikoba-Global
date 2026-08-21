const express = require('express');
const { handleUssd } = require('../services/ussdService');
const { verifyUssdSignature, ussdRateLimit, validateUssdPhone } = require('../middleware/ussdGuard');
const logger = require('../utils/logger');

const router = express.Router();

router.post('/', ussdRateLimit, validateUssdPhone, verifyUssdSignature, async (req, res) => {
  try {
    const { sessionId, phoneNumber, text } = req.body;

    const result = await handleUssd(sessionId, phoneNumber, text || '');

    if (result.end) {
      return res.send(`END ${result.response}`);
    }
    return res.send(`CON ${result.response}`);
  } catch (error) {
    logger.error('USSD', `USSD callback error: ${error.message}`);
    return res.send('END Hitilafu imetokea. Tafadhali jaribu tena baadaye.');
  }
});

module.exports = router;
