/**
 * Device & Session Management Service
 * Track trusted devices, active sessions, login alerts.
 */

const pool = require('../config/db');
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Generate device fingerprint from request.
 * Prefers the client's stable `x-device-fingerprint` (mobile apps bind a
 * per-install id) and falls back to a server-derived hash of the HTTP
 * signature so the same browser/IP resolves consistently.
 */
function generateFingerprint(req) {
  const header = req.headers ? req.headers[config.device.fingerprintHeader] : null;
  if (typeof header === 'string' && /^[a-f0-9]{32,128}$/i.test(header.trim())) {
    return header.trim().toLowerCase();
  }
  const raw = `${req.ip}|${req.headers['user-agent'] || ''}|${req.headers['accept-language'] || ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Register or update trusted device.
 */
async function registerDevice(userId, req, deviceName) {
  const fingerprint = generateFingerprint(req);
  const ua = req.headers['user-agent'] || '';
  const os = parseOS(ua);
  const browser = parseBrowser(ua);

  const result = await pool.query(
    `INSERT INTO trusted_devices (user_id, device_fingerprint, device_name, device_type, os, browser, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, device_fingerprint) DO UPDATE SET
       last_used_at = NOW(), ip_address = $7, device_name = COALESCE($3, trusted_devices.device_name)
     RETURNING *`,
    [userId, fingerprint, deviceName || `${os} ${browser}`, os.includes('Mobile') ? 'MOBILE' : 'DESKTOP', os, browser, req.ip]
  );

  return result.rows[0];
}

/**
 * Check if device is trusted (registered, active and explicitly trusted).
 */
async function isTrustedDevice(userId, req) {
  const fingerprint = generateFingerprint(req);
  const result = await pool.query(
    `SELECT id FROM trusted_devices WHERE user_id = $1 AND device_fingerprint = $2 AND is_active = TRUE AND is_trusted = TRUE`,
    [userId, fingerprint]
  );
  return result.rows.length > 0;
}

/**
 * Trust status for a specific fingerprint (row incl. policy bits).
 */
async function trustedDeviceStatus(userId, fingerprint) {
  const result = await pool.query(
    `SELECT id, device_fingerprint, device_name, device_type, os, browser,
            ip_address, last_used_at, is_active, is_trusted, created_at
     FROM trusted_devices
     WHERE user_id = $1 AND device_fingerprint = $2`,
    [userId, fingerprint]
  );
  return result.rows[0] || null;
}

/**
 * Non-blocking heartbeat: refresh last_used_at + ip for a known device.
 */
async function touchDevice(userId, fingerprint, req) {
  try {
    await pool.query(
      `UPDATE trusted_devices SET last_used_at = NOW(), ip_address = COALESCE($3, ip_address)
       WHERE user_id = $1 AND device_fingerprint = $2`,
      [userId, fingerprint, req ? req.ip : null]
    );
  } catch (e) {
    logger.error('DEVICE_TOUCH_FAILURE', e.message, { userId });
  }
}

/**
 * Alert on a first-seen device (fraud_alerts DEVICE row, MEDIUM).
 */
async function noteNewDevice(userId, fingerprint, req) {
  try {
    const known = await pool.query(
      'SELECT 1 FROM trusted_devices WHERE user_id = $1 AND device_fingerprint = $2',
      [userId, fingerprint]
    );
    if (known.rows.length > 0) return;
    await pool.query(
      `INSERT INTO fraud_alerts (user_id, alert_type, severity, description, ip_address, device_fingerprint)
       VALUES ($1, 'DEVICE', 'MEDIUM', $2, $3, $4)`,
      [userId, `Kifaa kipya kimeonekana: ${req ? req.ip : ''}`, req ? req.ip : null, fingerprint]
    );
  } catch (e) {
    logger.error('DEVICE_ALERT_FAILURE', e.message, { userId });
  }
}

/**
 * Set the user's device policy (PERMISSIVE | TRUSTED_ONLY).
 */
async function setDevicePolicy(userId, policy) {
  const result = await pool.query(
    `UPDATE users SET device_policy = $1, updated_at = NOW() WHERE id = $2 RETURNING device_policy`,
    [policy, userId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].device_policy;
}

/**
 * Get all trusted devices.
 */
async function getTrustedDevices(userId) {
  const result = await pool.query(
    `SELECT * FROM trusted_devices WHERE user_id = $1 AND is_active = TRUE ORDER BY last_used_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Remove trusted device.
 */
async function removeDevice(userId, deviceId) {
  const result = await pool.query(
    `DELETE FROM trusted_devices WHERE id = $1 AND user_id = $2 RETURNING id`,
    [deviceId, userId]
  );
  return result.rows.length > 0;
}

/**
 * Create active session.
 */
async function createSession(userId, req) {
  const fingerprint = generateFingerprint(req);
  const tokenHash = crypto.randomBytes(32).toString('hex');

  const result = await pool.query(
    `INSERT INTO active_sessions (user_id, session_token_hash, device_fingerprint, device_name, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '30 days')
     RETURNING *`,
    [userId, tokenHash, fingerprint, req.headers['user-agent'] || 'Unknown', req.ip, req.headers['user-agent']]
  );

  // Check if new device - send alert
  const isKnown = await isTrustedDevice(userId, req);
  if (!isKnown) {
    logger.warn('SECURITY', `New device login for user ${userId} from ${req.ip}`);
    await pool.query(
      `INSERT INTO fraud_alerts (user_id, alert_type, severity, description, ip_address, device_fingerprint)
       VALUES ($1, 'DEVICE', 'MEDIUM', $2, $3, $4)`,
      [userId, `Kifaa kipya kimeingia: ${req.ip}`, req.ip, fingerprint]
    );
  }

  return result.rows[0];
}

/**
 * Get active sessions for user.
 */
async function getActiveSessions(userId) {
  const result = await pool.query(
    `SELECT * FROM active_sessions
     WHERE user_id = $1 AND is_active = TRUE AND expires_at > NOW()
     ORDER BY last_active_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Terminate a session.
 */
async function terminateSession(userId, sessionId) {
  const result = await pool.query(
    `UPDATE active_sessions SET is_active = FALSE WHERE id = $1 AND user_id = $2 RETURNING id`,
    [sessionId, userId]
  );
  return result.rows.length > 0;
}

/**
 * Terminate all sessions except current.
 */
async function terminateAllSessions(userId, currentSessionId = null) {
  let query = `UPDATE active_sessions SET is_active = FALSE WHERE user_id = $1 AND is_active = TRUE`;
  const params = [userId];

  if (currentSessionId) {
    query += ` AND id != $2`;
    params.push(currentSessionId);
  }

  const result = await pool.query(query, params);
  return result.rowCount;
}

module.exports = {
  generateFingerprint,
  registerDevice,
  isTrustedDevice,
  trustedDeviceStatus,
  touchDevice,
  noteNewDevice,
  setDevicePolicy,
  getTrustedDevices,
  removeDevice,
  createSession,
  getActiveSessions,
  terminateSession,
  terminateAllSessions,
};

function parseOS(ua) {
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad/i.test(ua)) return 'iOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Unknown';
}

function parseBrowser(ua) {
  if (/chrome/i.test(ua)) return 'Chrome';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua)) return 'Safari';
  if (/edge/i.test(ua)) return 'Edge';
  return 'Unknown';
}
