const axios = require('axios');
const config = require('../config');
const { toInternationalFormat } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Tuma SMS kupitia Beem Africa API
 * @param {string} phoneNumber - Namba ya simu ya mpokeaji
 * @param {string} message - Ujumbe wa SMS
 */
async function sendSMS(phoneNumber, message) {
  if (config.nodeEnv !== 'production' && !config.beem.apiKey) {
    logger.info('SMS', 'MODE YA MAJARIBIO - SMS haitatumwa', { phoneNumber, message });
    return { success: true, simulated: true, data: { message } };
  }
  try {
    const formattedPhone = toInternationalFormat(phoneNumber);
    const payload = {
      source_addr: config.beem.senderId,
      schedule_time: '',
      encoding: '0',
      message: message,
      recipients: [{ recipient_id: 1, dest_addr: formattedPhone }],
    };
    const auth = Buffer.from(`${config.beem.apiKey}:${config.beem.secretKey}`).toString('base64');
    const response = await axios.post('https://api.beem.africa/v1/send', payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
      timeout: 15000,
    });
    logger.info('SMS', `Inatumwa kwenda ${formattedPhone}`, response.data);
    return { success: true, data: response.data };
  } catch (error) {
    logger.error('SMS', error.response ? JSON.stringify(error.response.data) : error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendSMS };
