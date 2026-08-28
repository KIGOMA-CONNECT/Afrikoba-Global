/**
 * 2FA Backup Codes Service
 * Generate and use backup codes for 2FA recovery.
 */

const pool = require('../config/db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

async function generateBackupCodes(userId) {
  // Invalidate old codes
  await pool.query(`DELETE FROM backup_codes WHERE user_id = $1`, [userId]);

  const codes = [];
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hash = await bcrypt.hash(code, 10);
    await pool.query(
      `INSERT INTO backup_codes (user_id, code_hash) VALUES ($1, $2)`,
      [userId, hash]
    );
    codes.push(code);
  }

  return codes;
}

async function verifyBackupCode(userId, code) {
  const result = await pool.query(
    `SELECT id, code_hash FROM backup_codes WHERE user_id = $1 AND is_used = FALSE`,
    [userId]
  );

  for (const row of result.rows) {
    const match = await bcrypt.compare(code, row.code_hash);
    if (match) {
      await pool.query(
        `UPDATE backup_codes SET is_used = TRUE, used_at = NOW() WHERE id = $1`,
        [row.id]
      );
      return true;
    }
  }

  return false;
}

async function getRemainingCodes(userId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM backup_codes WHERE user_id = $1 AND is_used = FALSE`,
    [userId]
  );
  return result.rows[0].count;
}

module.exports = { generateBackupCodes, verifyBackupCode, getRemainingCodes };
