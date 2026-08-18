const express = require('express');
const { handleUssd } = require('../services/ussdService');
const logger = require('../utils/logger');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { sessionId, phoneNumber, text } = req.body;

    if (!sessionId || !phoneNumber) {
      return res.status(400).send('End. Tafadhali washa tena.');
    }

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
