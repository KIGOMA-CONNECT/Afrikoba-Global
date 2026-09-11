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
async function addBeneficiary(userId, phone, name, nickname, extras = {}) {
  const { country_code, currency_code, payout_method } = extras;
  const result = await pool.query(
    `INSERT INTO beneficiaries (user_id, phone, name, nickname, country_code, currency_code, payout_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, phone) DO UPDATE SET
       name = $3, nickname = $4,
       country_code = COALESCE($5, beneficiaries.country_code),
       currency_code = COALESCE($6, beneficiaries.currency_code),
       payout_method = COALESCE($7, beneficiaries.payout_method),
       updated_at = NOW()
     RETURNING *`,
    [userId, phone, name, nickname || name, country_code || null, currency_code || null, payout_method || 'WALLET']
  );
  return result.rows[0];
}

/**
 * Update beneficiary.
 */
async function updateBeneficiary(userId, beneficiaryId, updates) {
  const { name, nickname, is_favorite, country_code, currency_code, payout_method } = updates;
  const result = await pool.query(
    `UPDATE beneficiaries
     SET name = COALESCE($1, name),
         nickname = COALESCE($2, nickname),
         is_favorite = COALESCE($3, is_favorite),
         country_code = COALESCE($4, country_code),
         currency_code = COALESCE($5, currency_code),
         payout_method = COALESCE($6, payout_method),
         updated_at = NOW()
     WHERE id = $7 AND user_id = $8
     RETURNING *`,
    [name, nickname, is_favorite, country_code, currency_code, payout_method, beneficiaryId, userId]
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
