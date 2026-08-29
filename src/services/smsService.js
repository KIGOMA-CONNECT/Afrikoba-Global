const axios = require('axios');
const config = require('../config');
const { toInternationalFormat } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * SMS ya Kimataifa — Multi-provider:
 *  - Beem Africa          → Tanzania (255)
 *  - Africa's Talking     → Afrika (KE, UG, RW, BI, ZM, MW, MZ, ET, SO, CD, GH, NG, ZA, EG...)
 *  - Twilio (default)     → nyingine (dunia) + failover
 * Routing kwa dial-prefix; failover inajaribu providers zingine zilizoconfigured
 * ikiwa provider ya kwanza inashindikana.
 */

const AT_BASE = 'https://api.africastalking.com/version1/messaging';
const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';
const HTTP_TIMEOUT = 15000;

// Dial-prefix (intl, bila '+') → provider msingi
const COUNTRY_PROVIDER = {
  '255': 'beem',           // Tanzania
  '254': 'at',             // Kenya
  '256': 'at',             // Uganda
  '250': 'at',             // Rwanda
  '257': 'at',             // Burundi
  '260': 'at',             // Zambia
  '265': 'at',             // Malawi
  '258': 'at',             // Mozambique
  '251': 'at',             // Ethiopia
  '252': 'at',             // Somalia
  '243': 'at',             // DR Congo
  '233': 'at',             // Ghana
  '234': 'at',             // Nigeria
  '27': 'at',              // South Africa
  '20': 'at',              // Egypt
};

// Mlolongo wa failover (baada ya provider ya msingi)
const FAILOVER_CHAIN = ['beem', 'at', 'twilio'];

function stripPlus(p) {
  return String(p || '').replace(/^\+/, '');
}

function isProviderConfigured(name) {
  if (name === 'beem') return !!(config.sms.beem.apiKey && config.sms.beem.secretKey);
  if (name === 'at') return !!(config.sms.at.apiKey && config.sms.at.username);
  if (name === 'twilio') return !!(config.sms.twilio.accountSid && config.sms.twilio.authToken && config.sms.twilio.from);
  return false;
}

function providersAvailable() {
  return FAILOVER_CHAIN.some(isProviderConfigured);
}

/**
 * Pata provider msingi kwa namba (E.164 bila '+', e.g. 254712345678).
 * @returns {'beem'|'at'|'twilio'}
 */
function resolveProvider(phone) {
  const intl = stripPlus(toInternationalFormat(phone, 'TZ'));
  let prefix = intl;
  while (prefix.length > 0) {
    if (COUNTRY_PROVIDER[prefix]) return COUNTRY_PROVIDER[prefix];
    prefix = prefix.slice(0, -1);
  }
  return 'twilio';
}

// ------------------------- Providers -------------------------

async function sendViaBeem(intl, message) {
  const payload = {
    source_addr: config.sms.beem.senderId,
    schedule_time: '',
    encoding: '0',
    message,
    recipients: [{ recipient_id: 1, dest_addr: stripPlus(intl) }],
  };
  const auth = Buffer.from(`${config.sms.beem.apiKey}:${config.sms.beem.secretKey}`).toString('base64');
  const response = await axios.post('https://api.beem.africa/v1/send', payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    timeout: HTTP_TIMEOUT,
  });
  return { success: response.status === 200, data: response.data };
}

async function sendViaAt(intl, message) {
  const params = new URLSearchParams();
  params.append('username', config.sms.at.username);
  params.append('to', `+${stripPlus(intl)}`);
  params.append('message', message);
  if (config.sms.at.senderId) params.append('from', config.sms.at.senderId);
  const response = await axios.post(AT_BASE, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', apiKey: config.sms.at.apiKey, Accept: 'application/json' },
    timeout: HTTP_TIMEOUT,
  });
  const data = response.data;
  const recipients = data && data.SMSMessageData && Array.isArray(data.SMSMessageData.Recipients) ? data.SMSMessageData.Recipients : [];
  const ok =
    response.status === 201 &&
    (recipients.some((r) => ['100', '101'].includes(String(r.statusCode))) ||
      String(data.SMSMessageData && data.SMSMessageData.Message).includes('Sent'));
  return ok ? { success: true, data } : { success: false, error: JSON.stringify(data) };
}

async function sendViaTwilio(intl, message) {
  const auth = Buffer.from(`${config.sms.twilio.accountSid}:${config.sms.twilio.authToken}`).toString('base64');
  const body = new URLSearchParams({ To: `+${stripPlus(intl)}`, From: config.sms.twilio.from, Body: message });
  const response = await axios.post(`${TWILIO_BASE}/Accounts/${config.sms.twilio.accountSid}/Messages.json`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
    timeout: HTTP_TIMEOUT,
  });
  return response.status === 201
    ? { success: true, data: response.data }
    : { success: false, error: JSON.stringify(response.data) };
}

const PROVIDER_SENDERS = { beem: sendViaBeem, at: sendViaAt, twilio: sendViaTwilio };

// ------------------------- Public API -------------------------

/**
 * Tuma SMS (OTP, notifications) kwa namba yoyote ya dunia.
 * Routing kwa nchi → provider, failover kama inashindikana.
 * @param {string} phoneNumber
 * @param {string} message
 * @returns {Promise<{success: boolean, simulated?: boolean, data?: any, error?: string, provider?: string}>}
 */
async function sendSMS(phoneNumber, message) {
  const primary = resolveProvider(phoneNumber);

  // Non-production: simulate DAIMA — usiguse providers halisi (OTP ya dev inatoka ndani ya app)
  if (config.nodeEnv !== 'production') {
    logger.info('SMS', 'MODE YA MAJARIBIO - SMS haitatumwa', { phoneNumber, message, provider: primary });
    return { success: true, simulated: true, provider: primary, data: { message } };
  }

  const intl = toInternationalFormat(phoneNumber, 'TZ');
  const chain = [primary, ...FAILOVER_CHAIN.filter((p) => p !== primary)].filter(isProviderConfigured);

  if (chain.length === 0) {
    logger.error('SMS', 'Hakuna SMS provider configured (beem/at/twilio) kwa OTP');
    return { success: false, error: 'No SMS provider configured', provider: primary };
  }

  for (const name of chain) {
    try {
      const result = await PROVIDER_SENDERS[name](intl, message);
      if (result.success) {
        logger.info('SMS', `[${name}] Inatumwa kwenda ${intl}`, result.data);
        return { ...result, provider: name };
      }
      logger.warn('SMS', `[${name}] imeshindikana, inajaribu provider ijayo: ${result.error}`);
    } catch (e) {
      logger.warn('SMS', `[${name}] error: ${e.message}`);
    }
  }
  return { success: false, error: `All SMS providers failed (${chain.join(',')})`, provider: primary };
}

module.exports = { sendSMS, resolveProvider, isProviderConfigured, providersAvailable };