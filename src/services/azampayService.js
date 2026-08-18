const axios = require('axios');
const config = require('../config');
const { toLocalFormat } = require('../utils/helpers');
const logger = require('../utils/logger');

const BASE_URL = config.azampay.env === 'production'
  ? 'https://checkout.azampay.co.tz'
  : 'https://sandbox.azampay.co.tz';

const AUTH_URL = config.azampay.env === 'production'
  ? 'https://authenticator.azampay.co.tz/AppAuthentication/Token'
  : 'https://authenticator-sandbox.azampay.co.tz/AppAuthentication/Token';

let cachedToken = null;
let tokenExpiry = 0;

async function getAzamPayToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  const response = await axios.post(AUTH_URL, {
    appName: config.azampay.appName,
    clientId: config.azampay.clientId,
    clientSecret: config.azampay.clientSecret,
  }, { timeout: 15000 });

  const token = response.data?.data?.accessToken;
  if (!token) {
    throw new Error('Imeshindwa kupata Access Token kutoka AzamPay.');
  }
  const expiresIn = parseInt(response.data.data.expires, 10) || 3600;
  cachedToken = token;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return token;
}

/**
 * Trigger USSD Push (MnoCheckout) kwenda simu ya mteja
 * @param {string} phoneNumber
 * @param {number} amount
 * @param {string} referenceId
 * @param {string} provider - Mpesa | Tigo | Airtel | Halopesa
 */
async function triggerMnoCheckout(phoneNumber, amount, referenceId, provider) {
  try {
    const token = await getAzamPayToken();
    const accountNumber = toLocalFormat(phoneNumber);
    const payload = {
      accountNumber,
      amount: String(amount),
      currency: 'TZS',
      externalId: referenceId,
      provider,
    };
    const response = await axios.post(`${BASE_URL}/azampay/mno/checkout`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: 20000,
    });
    logger.info('AZAMPAY', `Checkout sent ref=${referenceId}`, response.data);
    return { success: true, data: response.data };
  } catch (error) {
    logger.error('AZAMPAY', error.response ? JSON.stringify(error.response.data) : error.message);
    return {
      success: false,
      message: error.response?.data?.message || error.message,
      data: error.response?.data,
    };
  }
}

/**
 * Query transaction status kwenye AzamPay (Reconciliation Engine)
 * @param {string} referenceId - externalId tulilotuma
 */
async function queryTransactionStatus(referenceId) {
  try {
    const token = await getAzamPayToken();
    const response = await axios.post(
      `${BASE_URL}/azampay/payment/query`,
      { externalId: referenceId },
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    const d = response.data || {};
    const status = (d.transactionstatus || '').toUpperCase();
    return {
      success: true,
      status: status === 'SUCCESS' ? 'SUCCESS' : status === 'FAILED' ? 'FAILED' : 'PENDING',
      data: d,
    };
  } catch (error) {
    logger.error('AZAMPAY QUERY', error.response ? JSON.stringify(error.response.data) : error.message);
    return { success: false, status: 'UNKNOWN', error: error.message };
  }
}

/**
 * Payout (send money) kupitia AzamPay - kwa ROSCA payouts na VICOBA loan disbursements
 * @param {string} phoneNumber
 * @param {number} amount
 * @param {string} referenceId
 * @param {string} provider
 */
async function triggerPayout(phoneNumber, amount, referenceId, provider) {
  try {
    const token = await getAzamPayToken();
    const payload = {
      accountNumber: toLocalFormat(phoneNumber),
      amount: String(amount),
      currency: 'TZS',
      externalId: referenceId,
      provider,
    };
    const response = await axios.post(`${BASE_URL}/azampay/mno/checkout`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: 20000,
    });
    logger.info('AZAMPAY PAYOUT', `Payout ref=${referenceId}`, response.data);
    return { success: true, data: response.data };
  } catch (error) {
    logger.error('AZAMPAY PAYOUT', error.response ? JSON.stringify(error.response.data) : error.message);
    return { success: false, message: error.response?.data?.message || error.message };
  }
}

module.exports = { getAzamPayToken, triggerMnoCheckout, queryTransactionStatus, triggerPayout };
