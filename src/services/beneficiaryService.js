/**
 * Beneficiary Management Service
 * Save frequent recipients for quick transfers.
 */

const pool = require('../config/db');

/**
 * Get all beneficiaries for user.
 */
async function getBeneficiaries(userId, favoritesOnly = false) {
  let query = `SELECT * FROM beneficiaries WHERE user_id = $1`;
  if (favoritesOnly) query += ` AND is_favorite = TRUE`;
  query += ` ORDER BY is_favorite DESC, usage_count DESC, name ASC`;
  const result = await pool.query(query, [userId]);
  return result.rows;
}

/**
 * Add beneficiary.
 */
async function addBeneficiary(userId, phone, name, nickname) {
  const result = await pool.query(
    `INSERT INTO beneficiaries (user_id, phone, name, nickname)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, phone) DO UPDATE SET name = $3, nickname = $4, updated_at = NOW()
     RETURNING *`,
    [userId, phone, name, nickname || name]
  );
  return result.rows[0];
}

/**
 * Update beneficiary.
 */
async function updateBeneficiary(userId, beneficiaryId, updates) {
  const { name, nickname, is_favorite } = updates;
  const result = await pool.query(
    `UPDATE beneficiaries
     SET name = COALESCE($1, name),
         nickname = COALESCE($2, nickname),
         is_favorite = COALESCE($3, is_favorite),
         updated_at = NOW()
     WHERE id = $4 AND user_id = $5
     RETURNING *`,
    [name, nickname, is_favorite, beneficiaryId, userId]
  );
  return result.rows[0];
}

/**
 * Delete beneficiary.
 */
async function deleteBeneficiary(userId, beneficiaryId) {
  const result = await pool.query(
    `DELETE FROM beneficiaries WHERE id = $1 AND user_id = $2 RETURNING id`,
    [beneficiaryId, userId]
  );
  return result.rows.length > 0;
}

/**
 * Increment usage count when transferring to beneficiary.
 */
async function incrementUsage(userId, phone) {
  await pool.query(
    `UPDATE beneficiaries SET usage_count = usage_count + 1, updated_at = NOW()
     WHERE user_id = $1 AND phone = $2`,
    [userId, phone]
  );
}

module.exports = { getBeneficiaries, addBeneficiary, updateBeneficiary, deleteBeneficiary, incrementUsage };
