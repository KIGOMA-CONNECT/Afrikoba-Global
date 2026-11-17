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

// Raw provider requests (shared by sendSMS and sendSMSIdempotent).
function requestBeem(intl, message) {
  const payload = {
    source_addr: config.sms.beem.senderId,
    schedule_time: '',
    encoding: '0',
    message,
    recipients: [{ recipient_id: 1, dest_addr: stripPlus(intl) }],
  };
  const auth = Buffer.from(`${config.sms.beem.apiKey}:${config.sms.beem.secretKey}`).toString('base64');
  return axios.post('https://api.beem.africa/v1/send', payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    timeout: HTTP_TIMEOUT,
  });
}

function requestAt(intl, message) {
  const params = new URLSearchParams();
  params.append('username', config.sms.at.username);
  params.append('to', `+${stripPlus(intl)}`);
  params.append('message', message);
  if (config.sms.at.senderId) params.append('from', config.sms.at.senderId);
  return axios.post(AT_BASE, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', apiKey: config.sms.at.apiKey, Accept: 'application/json' },
    timeout: HTTP_TIMEOUT,
  });
}

function requestTwilio(intl, message) {
  const auth = Buffer.from(`${config.sms.twilio.accountSid}:${config.sms.twilio.authToken}`).toString('base64');
  const body = new URLSearchParams({ To: `+${stripPlus(intl)}`, From: config.sms.twilio.from, Body: message });
  return axios.post(`${TWILIO_BASE}/Accounts/${config.sms.twilio.accountSid}/Messages.json`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
    timeout: HTTP_TIMEOUT,
  });
}

const PROVIDER_REQUESTS = { beem: requestBeem, at: requestAt, twilio: requestTwilio };

async function sendViaBeem(intl, message) {
  const response = await requestBeem(intl, message);
  return { success: response.status === 200, data: response.data };
}

async function sendViaAt(intl, message) {
  const response = await requestAt(intl, message);
  const data = response.data;
  const recipients = data && data.SMSMessageData && Array.isArray(data.SMSMessageData.Recipients) ? data.SMSMessageData.Recipients : [];
  const ok =
    response.status === 201 &&
    (recipients.some((r) => ['100', '101'].includes(String(r.statusCode))) ||
      String(data.SMSMessageData && data.SMSMessageData.Message).includes('Sent'));
  return ok ? { success: true, data } : { success: false, error: JSON.stringify(data) };
}

async function sendViaTwilio(intl, message) {
  const response = await requestTwilio(intl, message);
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

// ===================== Phase 71 / Step D: idempotent delivery =====================
//
// sendSMS (above) is kept unchanged for OTP. Business SMS that must not be sent
// twice use sendSMSIdempotent, backed by the sms_deliveries table (migration 148).
// This REDUCES duplicate sends; it cannot guarantee exactly-once delivery: an
// UNKNOWN outcome may or may not have reached the handset.

const crypto = require('crypto');

const OUTCOME = { SENT: 'SENT', DEFINITE: 'DEFINITE', UNKNOWN: 'UNKNOWN' };
const IDEMPOTENCY_KEY_MAX = 200;
const STALE_PENDING_MS = 10 * 60 * 1000; // > worst case chain time (3 x 15s timeouts)

// Network errors where the connection was never established, so the request
// cannot have reached the provider. Anything else without an HTTP response
// (timeouts, resets, hang-ups, unrecognised codes) is UNKNOWN.
const DEFINITE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// Africa's Talking per-recipient statusCode.
const AT_ACCEPTED = new Set([100, 101, 102]);                         // Processed, Sent, Queued
const AT_REJECTED = new Set([401, 402, 403, 404, 405, 406, 407, 409, 502]); // RiskHold .. DoNotDisturb, RejectedByGateway
// 500 InternalServerError, 501 GatewayError and unrecognised codes -> UNKNOWN.

function classifyAxiosError(err) {
  const status = err && err.response && typeof err.response.status === 'number' ? err.response.status : null;
  if (status !== null) {
    // 408 Request Timeout: the provider may have received (part of) the request -> UNKNOWN.
    if (status === 408) return { outcome: OUTCOME.UNKNOWN, code: 'HTTP_408' };
    if (status >= 400 && status < 500) return { outcome: OUTCOME.DEFINITE, code: `HTTP_${status}` };
    return { outcome: OUTCOME.UNKNOWN, code: `HTTP_${status}` };
  }
  const code = err && typeof err.code === 'string' ? err.code : null;
  if (code && DEFINITE_NETWORK_CODES.has(code)) return { outcome: OUTCOME.DEFINITE, code };
  return { outcome: OUTCOME.UNKNOWN, code: code || 'UNCLASSIFIED_ERROR' };
}

function classifyProviderResponse(provider, response) {
  const status = response && response.status;
  const data = (response && response.data) || {};
  if (provider === 'beem') {
    if (status !== 200) return { outcome: OUTCOME.UNKNOWN, code: `BEEM_HTTP_${status}` };
    if (data.successful === false) return { outcome: OUTCOME.DEFINITE, code: `BEEM_REJECTED_${data.code ?? 'NA'}` };
    return { outcome: OUTCOME.SENT, code: 'BEEM_ACCEPTED', messageId: data.request_id != null ? String(data.request_id) : null };
  }
  if (provider === 'at') {
    if (status !== 201) return { outcome: OUTCOME.UNKNOWN, code: `AT_HTTP_${status}` };
    const recipients = data.SMSMessageData && Array.isArray(data.SMSMessageData.Recipients)
      ? data.SMSMessageData.Recipients : [];
    if (recipients.length === 0) return { outcome: OUTCOME.UNKNOWN, code: 'AT_NO_RECIPIENTS' };
    const sc = Number(recipients[0].statusCode);
    if (AT_ACCEPTED.has(sc)) {
      return { outcome: OUTCOME.SENT, code: `AT_STATUS_${sc}`, messageId: recipients[0].messageId ? String(recipients[0].messageId) : null };
    }
    if (AT_REJECTED.has(sc)) return { outcome: OUTCOME.DEFINITE, code: `AT_STATUS_${sc}` };
    return { outcome: OUTCOME.UNKNOWN, code: `AT_STATUS_${sc}` };
  }
  if (provider === 'twilio') {
    if (status >= 200 && status < 300 && data.sid) {
      return { outcome: OUTCOME.SENT, code: 'TWILIO_ACCEPTED', messageId: String(data.sid) };
    }
    return { outcome: OUTCOME.UNKNOWN, code: `TWILIO_HTTP_${status}` };
  }
  return { outcome: OUTCOME.UNKNOWN, code: `UNKNOWN_PROVIDER_${provider}` };
}

function _hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function _normalizePhone(phone) {
  return stripPlus(toInternationalFormat(phone, 'TZ'));
}

function resultFromRow(row, extra = {}) {
  return {
    success: row.status === 'SENT',
    status: row.status,
    provider: row.provider || null,
    providerMessageId: row.provider_message_id || null,
    simulated: row.simulated === true,
    error: row.last_error || null,
    ...extra,
  };
}

/**
 * Send an SMS at most once per idempotency key (best effort; see header).
 * The PENDING row is committed (autocommit on the pool) BEFORE any provider is
 * called. Existing rows: SENT -> returned, not resent; UNKNOWN -> returned, not
 * resent; PENDING -> in flight (or, if stale, marked UNKNOWN), not resent;
 * FAILED -> an explicit new attempt is made.
 * Timeouts / 5xx / resets are UNKNOWN and stop the failover chain.
 * @returns {Promise<{success, status: 'SENT'|'FAILED'|'UNKNOWN'|'PENDING', provider, providerMessageId, simulated, error, duplicate?, inFlight?}>}
 */
async function sendSMSIdempotent(key, phoneNumber, message, { staleMs = STALE_PENDING_MS } = {}) {
  const idemKey = typeof key === 'string' ? key.trim() : '';
  if (!idemKey) throw new Error('sendSMSIdempotent: idempotency key is required');
  if (Array.from(idemKey).length > IDEMPOTENCY_KEY_MAX) {
    throw new Error(`sendSMSIdempotent: idempotency key exceeds ${IDEMPOTENCY_KEY_MAX} characters`);
  }
  if (!phoneNumber || !message) throw new Error('sendSMSIdempotent: phone and message are required');

  const pool = require('../config/db');
  const normalized = _normalizePhone(phoneNumber);
  const phoneHash = _hash(normalized);
  const bodyHash = _hash(message);
  const last4 = normalized.slice(-4);

  // ---- 1. Claim (committed before any provider call) ----
  let claim = null;
  for (let i = 0; i < 3 && !claim; i++) {
    const ins = await pool.query(
      `INSERT INTO sms_deliveries (idempotency_key, phone_hash, phone_last4, body_hash, status, attempts)
       VALUES ($1, $2, $3, $4, 'PENDING', 1)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, attempts`,
      [idemKey, phoneHash, last4, bodyHash]
    );
    if (ins.rows[0]) { claim = ins.rows[0]; break; }

    const existing = (await pool.query('SELECT * FROM sms_deliveries WHERE idempotency_key = $1', [idemKey])).rows[0];
    if (!existing) continue;
    if (existing.phone_hash.trim() !== phoneHash || existing.body_hash.trim() !== bodyHash) {
      throw new Error(`SMS idempotency key reused with a different phone or body: ${idemKey}`);
    }
    if (existing.status === 'SENT' || existing.status === 'UNKNOWN') {
      return resultFromRow(existing, { duplicate: true });
    }
    if (existing.status === 'PENDING') {
      const stale = await pool.query(
        `UPDATE sms_deliveries
            SET status = 'UNKNOWN',
                last_error = 'STALE_PENDING: outcome not recorded before the sending process stopped',
                updated_at = NOW()
          WHERE id = $1 AND status = 'PENDING'
            AND updated_at < NOW() - ($2 * INTERVAL '1 millisecond')
          RETURNING *`,
        [existing.id, staleMs]
      );
      if (stale.rows[0]) {
        logger.warn('SMS', `[idempotent] stale PENDING -> UNKNOWN key=${idemKey} last4=${last4}`);
        return resultFromRow(stale.rows[0], { duplicate: true });
      }
      return resultFromRow(existing, { duplicate: true, inFlight: true });
    }
    if (existing.status === 'FAILED') {
      // Explicit decision: a FAILED key (no provider accepted it) may be attempted again.
      const retry = await pool.query(
        `UPDATE sms_deliveries
            SET status = 'PENDING', attempts = attempts + 1, updated_at = NOW()
          WHERE id = $1 AND status = 'FAILED'
          RETURNING id, attempts`,
        [existing.id]
      );
      if (retry.rows[0]) claim = retry.rows[0];
    }
  }
  if (!claim) throw new Error(`sendSMSIdempotent: could not claim key ${idemKey}`);

  async function finish(status, provider, providerMessageId, simulated, lastError) {
    const res = await pool.query(
      `UPDATE sms_deliveries
          SET status = $2, provider = $3, provider_message_id = $4, simulated = $5,
              last_error = $6, updated_at = NOW()
        WHERE id = $1 AND status = 'PENDING'
        RETURNING *`,
      [claim.id, status, provider, providerMessageId, simulated, lastError]
    );
    return res.rows[0]
      ? resultFromRow(res.rows[0])
      : { success: status === 'SENT', status, provider, providerMessageId, simulated, error: lastError };
  }

  // ---- 2. Simulation outside production (no provider touched) ----
  const primary = resolveProvider(phoneNumber);
  if (config.nodeEnv !== 'production') {
    logger.info('SMS', `[idempotent] simulated key=${idemKey} last4=${last4} provider=${primary}`);
    return finish('SENT', primary, null, true, null);
  }

  // ---- 3. Provider chain: failover only after a DEFINITE failure ----
  const intl = toInternationalFormat(phoneNumber, 'TZ');
  const chain = [primary, ...FAILOVER_CHAIN.filter((p) => p !== primary)].filter(isProviderConfigured);
  if (chain.length === 0) return finish('FAILED', primary, null, false, 'NO_PROVIDER_CONFIGURED');

  const definite = [];
  for (const name of chain) {
    let outcome;
    try {
      outcome = classifyProviderResponse(name, await PROVIDER_REQUESTS[name](intl, message));
    } catch (e) {
      outcome = classifyAxiosError(e);
    }
    if (outcome.outcome === OUTCOME.SENT) {
      logger.info('SMS', `[idempotent] sent key=${idemKey} last4=${last4} provider=${name}`);
      return finish('SENT', name, outcome.messageId || null, false, null);
    }
    if (outcome.outcome === OUTCOME.UNKNOWN) {
      logger.warn('SMS', `[idempotent] UNKNOWN outcome, no failover key=${idemKey} provider=${name} code=${outcome.code}`);
      return finish('UNKNOWN', name, null, false, [...definite, `${name}:${outcome.code}`].join(';'));
    }
    definite.push(`${name}:${outcome.code}`);
    logger.warn('SMS', `[idempotent] definite failure, failing over key=${idemKey} provider=${name} code=${outcome.code}`);
  }
  return finish('FAILED', chain[chain.length - 1], null, false, definite.join(';'));
}

module.exports = {
  sendSMS,
  sendSMSIdempotent,
  classifyAxiosError,
  classifyProviderResponse,
  STALE_PENDING_MS,
  resolveProvider,
  isProviderConfigured,
  providersAvailable,
  _hash,
  _normalizePhone,
};