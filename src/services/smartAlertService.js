/**
 * Smart Alerts Service
 * Balance threshold, large tx, unusual activity alerts.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const ALERT_TYPES = {
  BALANCE_LOW: { check: (balance, threshold) => balance < threshold, msg: (t) => `Salio lako limepungua chini ya TSh ${t.toLocaleString()}` },
  BALANCE_HIGH: { check: (balance, threshold) => balance > threshold, msg: (t) => `Salio lako limeongezeka zaidi ya TSh ${t.toLocaleString()}` },
  LARGE_TRANSACTION: { check: (amount, threshold) => amount >= threshold, msg: (t, a) => `Muamala mkubwa: TSh ${a.toLocaleString()} (mpaka TSh ${t.toLocaleString()})` },
  UNUSUAL_ACTIVITY: { check: () => true, msg: () => 'Shughuli isiyo ya kawaida imegunduliwa kwenye akaunti yako.' },
  CONTRIBUTION_DUE: { check: () => true, msg: (t) => `Mchango wako wa TSh ${t.toLocaleString()} unakaribia kulipwa.` },
  LOAN_DUE: { check: () => true, msg: (t) => `Lipa deni lako: TSh ${t.toLocaleString()}` },
};

async function createAlert(userId, { alert_type, threshold, message_template }) {
  if (!ALERT_TYPES[alert_type]) throw new Error('Aina ya alert batili.');

  const result = await pool.query(
    `INSERT INTO smart_alerts (user_id, alert_type, threshold, message_template)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, alert_type, threshold || null, message_template || ALERT_TYPES[alert_type].msg(threshold || 0)]
  );
  return result.rows[0];
}

async function getAlerts(userId) {
  const result = await pool.query(
    `SELECT * FROM smart_alerts WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function updateAlert(userId, alertId, updates) {
  const { threshold, message_template, is_active } = updates;
  const result = await pool.query(
    `UPDATE smart_alerts
     SET threshold = COALESCE($1, threshold),
         message_template = COALESCE($2, message_template),
         is_active = COALESCE($3, is_active),
         updated_at = NOW()
     WHERE id = $4 AND user_id = $5 RETURNING *`,
    [threshold, message_template, is_active, alertId, userId]
  );
  return result.rows[0];
}

async function deleteAlert(userId, alertId) {
  const result = await pool.query(
    `DELETE FROM smart_alerts WHERE id = $1 AND user_id = $2 RETURNING id`,
    [alertId, userId]
  );
  return result.rows.length > 0;
}

async function checkAlerts(userId, { balance, amount, type }) {
  const alerts = await pool.query(
    `SELECT * FROM smart_alerts WHERE user_id = $1 AND is_active = TRUE`,
    [userId]
  );

  const triggered = [];
  for (const alert of alerts.rows) {
    let shouldTrigger = false;

    switch (alert.alert_type) {
      case 'BALANCE_LOW':
        if (balance !== undefined) shouldTrigger = balance < parseFloat(alert.threshold);
        break;
      case 'BALANCE_HIGH':
        if (balance !== undefined) shouldTrigger = balance > parseFloat(alert.threshold);
        break;
      case 'LARGE_TRANSACTION':
        if (amount !== undefined) shouldTrigger = amount >= parseFloat(alert.threshold || 1000000);
        break;
      case 'UNUSUAL_ACTIVITY':
        shouldTrigger = true;
        break;
    }

    if (shouldTrigger) {
      triggered.push({
        id: alert.id,
        type: alert.alert_type,
        message: alert.message_template,
      });

      await pool.query(
        `UPDATE smart_alerts SET last_triggered = NOW(), trigger_count = trigger_count + 1 WHERE id = $1`,
        [alert.id]
      );

      // Send notification
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, $2, $3, 'ALERT')`,
        [userId, `Alert: ${alert.alert_type}`, alert.message_template]
      );

      logger.info('ALERT', `Triggered ${alert.alert_type} for user ${userId}`);
    }
  }

  return triggered;
}

module.exports = { createAlert, getAlerts, updateAlert, deleteAlert, checkAlerts };
