const pool = require('../config/db');
const { sendSMS } = require('../services/smsService');
const logger = require('../utils/logger');

/**
 * Notification service — in-app + SMS + email.
 */

/**
 * Create an in-app notification.
 */
async function createNotification(userId, { title, body, type = 'INFO', channel = 'IN_APP', entityType = null, entityId = null }) {
  try {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, title, body, type, channel, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, title, body, type, channel, entityType, entityId]
    );

    // Send SMS if user has SMS enabled
    const prefs = await pool.query(
      'SELECT sms_enabled FROM notification_preferences WHERE user_id = $1',
      [userId]
    );
    if (prefs.rows.length > 0 && prefs.rows[0].sms_enabled) {
      const u = await pool.query('SELECT phone_number FROM users WHERE id = $1', [userId]);
      if (u.rows[0]?.phone_number) sendSMS(u.rows[0].phone_number, body).catch(() => {});
    }

    return result.rows[0].id;
  } catch (err) {
    logger.error('NOTIFICATION', `Failed to create notification: ${err.message}`);
    return null;
  }
}

/**
 * Get user's notifications with pagination.
 */
async function getNotifications(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const offset = (page - 1) * limit;
  const conditions = ['user_id = $1'];
  const params = [userId];

  if (unreadOnly) {
    conditions.push('read_at IS NULL');
  }

  const where = conditions.join(' AND ');

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM notifications WHERE ${where}`,
    params
  );

  const result = await pool.query(
    `SELECT id, title, body, type, channel, entity_type, entity_id, read_at, created_at
     FROM notifications WHERE ${where}
     ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    notifications: result.rows,
    total: countResult.rows[0].total,
    page,
    limit,
    totalPages: Math.ceil(countResult.rows[0].total / limit),
  };
}

/**
 * Mark notification as read.
 */
async function markAsRead(userId, notificationId) {
  const result = await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL RETURNING id',
    [notificationId, userId]
  );
  return result.rowCount > 0;
}

/**
 * Mark all user notifications as read.
 */
async function markAllAsRead(userId) {
  const result = await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return result.rowCount;
}

/**
 * Get unread count.
 */
async function getUnreadCount(userId) {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return result.rows[0].count;
}

/**
 * Get or create notification preferences.
 */
async function getPreferences(userId) {
  let result = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
  if (result.rows.length === 0) {
    result = await pool.query(
      'INSERT INTO notification_preferences (user_id) VALUES ($1) RETURNING *',
      [userId]
    );
  }
  return result.rows[0];
}

/**
 * Update notification preferences.
 */
async function updatePreferences(userId, prefs) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(prefs)) {
    if (['sms_enabled', 'email_enabled', 'push_enabled', 'transaction_alerts', 'vicoba_alerts', 'rosca_alerts', 'p2p_alerts', 'promo_alerts'].includes(key)) {
      fields.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }
  }

  if (fields.length === 0) return null;

  values.push(userId);
  const result = await pool.query(
    `UPDATE notification_preferences SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`,
    values
  );
  return result.rows[0];
}

module.exports = { createNotification, getNotifications, markAsRead, markAllAsRead, getUnreadCount, getPreferences, updatePreferences };
