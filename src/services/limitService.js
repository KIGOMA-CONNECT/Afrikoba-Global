/**
 * Transaction Limits Service
 * Enforce daily, monthly, and per-transaction limits.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const DEFAULT_LIMITS = {
  DAILY: { ALL: 5000000, WITHDRAWAL: 2000000, TRANSFER: 5000000 },
  MONTHLY: { ALL: 100000000, WITHDRAWAL: 50000000, TRANSFER: 100000000 },
  PER_TRANSACTION: { ALL: 2000000, WITHDRAWAL: 1000000, TRANSFER: 2000000 },
};

const TX_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'];

async function getLimit(userId, limitType, txType) {
  const result = await pool.query(
    `SELECT * FROM transaction_limits
     WHERE user_id = $1 AND limit_type = $2 AND transaction_type = $3
     LIMIT 1`,
    [userId, limitType, txType]
  );

  if (result.rows.length > 0) return result.rows[0];

  const defaultAmount = DEFAULT_LIMITS[limitType]?.[txType] || DEFAULT_LIMITS[limitType]?.ALL || 1000000;
  const periodExpr = limitType === 'DAILY' ? 'NOW() + INTERVAL \'1 day\''
    : limitType === 'MONTHLY' ? 'NOW() + INTERVAL \'1 month\''
    : 'NULL';

  const created = await pool.query(
    `INSERT INTO transaction_limits (user_id, limit_type, transaction_type, max_amount, period_end)
     VALUES ($1, $2, $3, $4, ${periodExpr})
     ON CONFLICT (user_id, limit_type, transaction_type) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [userId, limitType, txType, defaultAmount]
  );

  return created.rows[0];
}

async function checkLimits(userId, amount, txType = 'ALL') {
  const checks = [];

  const perTx = await getLimit(userId, 'PER_TRANSACTION', txType);
  if (perTx && amount > parseFloat(perTx.max_amount)) {
    checks.push({
      passed: false,
      limitType: 'PER_TRANSACTION',
      max: perTx.max_amount,
      requested: amount,
      message: `Kiasi kinazidi kikomo cha muamala mmoja (TSh ${parseFloat(perTx.max_amount).toLocaleString()})`,
    });
  } else {
    checks.push({ passed: true, limitType: 'PER_TRANSACTION' });
  }

  const daily = await getLimit(userId, 'DAILY', txType);
  if (daily) {
    const dailyUsed = await pool.query(
      `SELECT COALESCE(SUM(total_charged), 0)::numeric AS total
       FROM transactions
       WHERE user_id = $1 AND status = 'SUCCESS' AND created_at >= $2`,
      [userId, daily.period_start || new Date()]
    );
    const used = parseFloat(dailyUsed.rows[0]?.total || 0);
    if (used + amount > parseFloat(daily.max_amount)) {
      checks.push({
        passed: false, limitType: 'DAILY', max: daily.max_amount, used,
        remaining: Math.max(0, parseFloat(daily.max_amount) - used), requested: amount,
        message: `Kikomo cha siku kimefikiwa. Umeshatumia TSh ${used.toLocaleString()} / TSh ${parseFloat(daily.max_amount).toLocaleString()}`,
      });
    } else {
      checks.push({ passed: true, limitType: 'DAILY', remaining: parseFloat(daily.max_amount) - used });
    }
  }

  const monthly = await getLimit(userId, 'MONTHLY', txType);
  if (monthly) {
    const monthlyUsed = await pool.query(
      `SELECT COALESCE(SUM(total_charged), 0)::numeric AS total
       FROM transactions
       WHERE user_id = $1 AND status = 'SUCCESS' AND created_at >= $2`,
      [userId, monthly.period_start || new Date()]
    );
    const used = parseFloat(monthlyUsed.rows[0]?.total || 0);
    if (used + amount > parseFloat(monthly.max_amount)) {
      checks.push({
        passed: false, limitType: 'MONTHLY', max: monthly.max_amount, used,
        remaining: Math.max(0, parseFloat(monthly.max_amount) - used), requested: amount,
        message: `Kikomo wa mwezi kimefikiwa. Umeshatumia TSh ${used.toLocaleString()} / TSh ${parseFloat(monthly.max_amount).toLocaleString()}`,
      });
    } else {
      checks.push({ passed: true, limitType: 'MONTHLY', remaining: parseFloat(monthly.max_amount) - used });
    }
  }

  const failed = checks.filter((c) => !c.passed);
  return { allowed: failed.length === 0, checks, failures: failed };
}

async function setLimit(userId, limitType, txType, maxAmount) {
  const result = await pool.query(
    `INSERT INTO transaction_limits (user_id, limit_type, transaction_type, max_amount, period_end)
     VALUES ($1, $2, $3, $4,
       CASE $2 WHEN 'DAILY' THEN NOW() + INTERVAL '1 day' WHEN 'MONTHLY' THEN NOW() + INTERVAL '1 month' ELSE NULL END)
     ON CONFLICT (user_id, limit_type, transaction_type)
     DO UPDATE SET max_amount = $4, updated_at = NOW()
     RETURNING *`,
    [userId, limitType, txType, maxAmount]
  );
  return result.rows[0];
}

async function getUserLimits(userId) {
  const result = await pool.query(
    `SELECT * FROM transaction_limits WHERE user_id = $1 ORDER BY limit_type, transaction_type`,
    [userId]
  );
  return result.rows;
}

async function resetExpiredLimits() {
  const result = await pool.query(
    `UPDATE transaction_limits
     SET used_amount = 0, period_start = NOW(),
         period_end = CASE limit_type
           WHEN 'DAILY' THEN NOW() + INTERVAL '1 day'
           WHEN 'MONTHLY' THEN NOW() + INTERVAL '1 month'
         END
     WHERE period_end IS NOT NULL AND period_end < NOW()
     RETURNING *`
  );
  if (result.rows.length > 0) {
    logger.info('LIMITS', `Reset ${result.rows.length} expired limits`);
  }
  return result.rows.length;
}

module.exports = { checkLimits, setLimit, getUserLimits, resetExpiredLimits, DEFAULT_LIMITS };
