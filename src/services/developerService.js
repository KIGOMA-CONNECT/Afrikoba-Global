/**
 * Developer Portal Service
 * API key management, sandbox testing, webhook simulator.
 */

const pool = require('../config/db');
const crypto = require('crypto');

function generateApiKey() {
  const raw = 'ak_live_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, prefix: raw.slice(0, 12) + '...' };
}

async function createApiKey(userId, { name, scopes, rate_limit }) {
  const { raw, hash, prefix } = generateApiKey();
  const result = await pool.query(
    `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, rate_limit)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, key_prefix, scopes, rate_limit, is_active, created_at`,
    [userId, name || 'API Key', prefix, hash, JSON.stringify(scopes || ['read']), rate_limit || 100]
  );
  return { ...result.rows[0], key: raw };
}

async function listApiKeys(userId) {
  const result = await pool.query(
    `SELECT id, name, key_prefix, scopes, rate_limit, is_active, last_used_at, created_at
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function revokeApiKey(userId, keyId) {
  const result = await pool.query(
    `UPDATE api_keys SET is_active = FALSE WHERE id = $1 AND user_id = $2 RETURNING id`,
    [keyId, userId]
  );
  return result.rows.length > 0;
}

async function deleteApiKey(userId, keyId) {
  const result = await pool.query(
    `DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id`,
    [keyId, userId]
  );
  return result.rows.length > 0;
}

async function touchApiKey(keyHash) {
  await pool.query(
    `UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1 AND is_active = TRUE`,
    [keyHash]
  );
}

async function lookupApiKey(rawKey) {
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const result = await pool.query(
    `SELECT * FROM api_keys WHERE key_hash = $1 AND is_active = TRUE`,
    [hash]
  );
  return result.rows[0] || null;
}

async function simulateWebhook(userId, { url, event, payload }) {
  const result = await pool.query(
    `INSERT INTO webhook_deliveries (user_id, url, event, payload, response_status, response_body)
     VALUES ($1, $2, $3, $4, 200, $5) RETURNING *`,
    [userId, url, event, JSON.stringify(payload || {}), JSON.stringify({ ok: true, message: 'Simulated delivery' })]
  );
  return result.rows[0];
}

async function getWebhookDeliveries(userId) {
  const result = await pool.query(
    `SELECT id, url, event, payload, response_status, response_body, delivered_at
     FROM webhook_deliveries WHERE user_id = $1 ORDER BY delivered_at DESC LIMIT 20`,
    [userId]
  );
  return result.rows;
}

module.exports = {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
  touchApiKey,
  lookupApiKey,
  simulateWebhook,
  getWebhookDeliveries,
};
