/**
 * Account Lockout Middleware
 * Locks account after MAX_FAILED_ATTEMPTS for LOCKOUT_DURATION_MS.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

async function checkAccountLockout(phoneNumber) {
  const res = await pool.query(
    `SELECT id, failed_login_attempts, locked_until
     FROM users WHERE phone_number = $1`,
    [phoneNumber]
  );
  if (res.rows.length === 0) return { locked: false };

  const user = res.rows[0];
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const remainingMs = new Date(user.locked_until) - new Date();
    const remainingMin = Math.ceil(remainingMs / 60000);
    logger.warn('SECURITY', `Locked account login attempt: ${phoneNumber} (${remainingMin} min remaining)`);
    return { locked: true, remainingMin };
  }
  return { locked: false, userId: user.id, attempts: user.failed_login_attempts || 0 };
}

async function recordFailedLogin(userId) {
  await pool.query(
    `UPDATE users
     SET failed_login_attempts = failed_login_attempts + 1,
         last_failed_login = NOW(),
         locked_until = CASE
           WHEN failed_login_attempts + 1 >= $2 THEN NOW() + INTERVAL '15 minutes'
           ELSE locked_until
         END
     WHERE id = $1`,
    [userId, MAX_FAILED_ATTEMPTS]
  );
}

async function resetFailedLogins(userId) {
  await pool.query(
    `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
    [userId]
  );
}

function lockoutGuard(handler) {
  return async (req, res, next) => {
    try {
      const phoneNumber = req.body?.phoneNumber || req.body?.phone_number;
      if (!phoneNumber) return handler(req, res, next);

      const lockStatus = await checkAccountLockout(phoneNumber);
      if (lockStatus.locked) {
        return res.status(423).json({
          success: false,
          code: 'ACCOUNT_LOCKED',
          message: `Akaunti imefungwa kwa dakika ${lockStatus.remainingMin}. Jaribu tena baadaye.`,
        });
      }
      req._lockoutUserId = lockStatus.userId;
      req._lockoutAttempts = lockStatus.attempts;
      handler(req, res, next);
    } catch (err) {
      handler(req, res, next);
    }
  };
}

module.exports = { checkAccountLockout, recordFailedLogin, resetFailedLogins, lockoutGuard, MAX_FAILED_ATTEMPTS };