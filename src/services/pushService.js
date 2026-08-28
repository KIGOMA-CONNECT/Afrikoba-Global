/**
 * Push Notification Service
 * Register devices, send push notifications.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Register push token.
 */
async function registerToken(userId, token, platform) {
  if (!['IOS', 'ANDROID', 'WEB'].includes(platform)) {
    throw new Error('Jukwaa batili. Tumia IOS, ANDROID, au WEB.');
  }

  await pool.query(
    `INSERT INTO push_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, token) DO UPDATE SET is_active = TRUE, created_at = NOW()`,
    [userId, token, platform]
  );

  return { success: true };
}

/**
 * Remove push token.
 */
async function removeToken(userId, token) {
  await pool.query(
    `UPDATE push_tokens SET is_active = FALSE WHERE user_id = $1 AND token = $2`,
    [userId, token]
  );
  return { success: true };
}

/**
 * Send push notification to user.
 */
async function sendPush(userId, { title, body, data }) {
  const tokens = await pool.query(
    `SELECT token, platform FROM push_tokens WHERE user_id = $1 AND is_active = TRUE`,
    [userId]
  );

  if (tokens.rows.length === 0) {
    return { sent: 0, message: 'Hakuna vifaa vilivyosajiliwa.' };
  }

  // In production, integrate with Firebase Cloud Messaging (FCM) or APNs
  // For now, log the notification
  for (const t of tokens.rows) {
    logger.info('PUSH', `Push to ${t.platform}: ${title} - ${body} (${t.token.substring(0, 10)}...)`);
  }

  // Store notification in-app as well
  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type)
     VALUES ($1, $2, $3, 'PUSH')`,
    [userId, title, body]
  );

  return { sent: tokens.rows.length, platforms: [...new Set(tokens.rows.map((t) => t.platform))] };
}

/**
 * Broadcast push to all users.
 */
async function broadcast({ title, body, data }) {
  const tokens = await pool.query(
    `SELECT DISTINCT user_id, platform FROM push_tokens WHERE is_active = TRUE`
  );

  let sent = 0;
  for (const t of tokens.rows) {
    logger.info('PUSH', `Broadcast to user ${t.user_id}: ${title}`);
    sent++;
  }

  return { sent, totalUsers: tokens.rows.length };
}

module.exports = { registerToken, removeToken, sendPush, broadcast };
