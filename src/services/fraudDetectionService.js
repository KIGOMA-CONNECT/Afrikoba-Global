/**
 * Fraud Detection Service
 * Detect unusual patterns, velocity checks, anomaly detection.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const THRESHOLDS = {
  VELOCITY_HOUR: 10,
  VELOCITY_DAY: 50,
  AMOUNT_SINGLE_HIGH: 5000000,
  AMOUNT_DAILY_HIGH: 15000000,
  UNIQUE_RECIPIENTS_DAY: 10,
  FAILED_ATTEMPTS_HOUR: 5,
  NIGHT_HOURS_START: 1,
  NIGHT_HOURS_END: 5,
};

async function runFraudChecks(userId, transaction) {
  const alerts = [];

  const hourlyCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM transactions
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId]
  );
  if (hourlyCount.rows[0].count >= THRESHOLDS.VELOCITY_HOUR) {
    alerts.push({ type: 'VELOCITY', severity: 'HIGH', description: `Muamala mwingi: ${hourlyCount.rows[0].count} ndani ya saa 1` });
  }

  const dailyCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM transactions
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
    [userId]
  );
  if (dailyCount.rows[0].count >= THRESHOLDS.VELOCITY_DAY) {
    alerts.push({ type: 'VELOCITY', severity: 'HIGH', description: `Muamala mwingi wa siku: ${dailyCount.rows[0].count}` });
  }

  if (parseFloat(transaction.amount) >= THRESHOLDS.AMOUNT_SINGLE_HIGH) {
    alerts.push({ type: 'AMOUNT', severity: 'MEDIUM', description: `Kiasi kikubwa: TSh ${parseFloat(transaction.amount).toLocaleString()}` });
  }

  const dailyAmount = await pool.query(
    `SELECT COALESCE(SUM(total_charged), 0)::numeric AS total FROM transactions
     WHERE user_id = $1 AND status = 'SUCCESS' AND created_at > NOW() - INTERVAL '1 day'`,
    [userId]
  );
  if (parseFloat(dailyAmount.rows[0].total) + parseFloat(transaction.amount) > THRESHOLDS.AMOUNT_DAILY_HIGH) {
    alerts.push({ type: 'AMOUNT', severity: 'HIGH', description: `Jumla ya siku inazidi limit` });
  }

  const failedCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM transactions
     WHERE user_id = $1 AND status = 'FAILED' AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId]
  );
  if (failedCount.rows[0].count >= THRESHOLDS.FAILED_ATTEMPTS_HOUR) {
    alerts.push({ type: 'PATTERN', severity: 'HIGH', description: `Majaribio yameshindwa: ${failedCount.rows[0].count} mara` });
  }

  const hour = new Date().getHours();
  if (hour >= THRESHOLDS.NIGHT_HOURS_START && hour <= THRESHOLDS.NIGHT_HOURS_END) {
    alerts.push({ type: 'TIME', severity: 'LOW', description: `Muamala wa usiku: Saa ${hour}` });
  }

  if (transaction.ipAddress) {
    const recentIps = await pool.query(
      `SELECT DISTINCT meta->>'ip' AS ip FROM transactions
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
       AND meta->>'ip' IS NOT NULL`,
      [userId]
    );
    const knownIps = recentIps.rows.map((r) => r.ip).filter(Boolean);
    if (knownIps.length > 0 && !knownIps.includes(transaction.ipAddress)) {
      alerts.push({ type: 'DEVICE', severity: 'MEDIUM', description: `IP mpya: ${transaction.ipAddress}` });
    }
  }

  for (const alert of alerts) {
    await pool.query(
      `INSERT INTO fraud_alerts (user_id, alert_type, severity, description, transaction_id, ip_address, device_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, alert.type, alert.severity, alert.description, transaction.id || null, transaction.ipAddress || null, transaction.fingerprint || null]
    );
    logger.warn('FRAUD', `[${alert.severity}] User ${userId}: ${alert.description}`);
  }

  return { checked: true, alertsCount: alerts.length, alerts, shouldBlock: alerts.some((a) => a.severity === 'HIGH') };
}

async function getUserAlerts(userId, resolved = false) {
  const result = await pool.query(
    `SELECT * FROM fraud_alerts WHERE user_id = $1 AND is_resolved = $2 ORDER BY created_at DESC LIMIT 50`,
    [userId, resolved]
  );
  return result.rows;
}

async function getAllAlerts(severity = null, limit = 100) {
  let query = `SELECT fa.*, u.phone AS user_phone FROM fraud_alerts fa LEFT JOIN users u ON fa.user_id = u.id WHERE fa.is_resolved = FALSE`;
  const params = [];
  if (severity) { query += ` AND fa.severity = $1`; params.push(severity); }
  query += ` ORDER BY fa.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const result = await pool.query(query, params);
  return result.rows;
}

async function resolveAlert(alertId, adminId) {
  const result = await pool.query(
    `UPDATE fraud_alerts SET is_resolved = TRUE, resolved_by = $1, resolved_at = NOW() WHERE id = $2 RETURNING *`,
    [adminId, alertId]
  );
  return result.rows[0];
}

module.exports = { runFraudChecks, getUserAlerts, getAllAlerts, resolveAlert, THRESHOLDS };
