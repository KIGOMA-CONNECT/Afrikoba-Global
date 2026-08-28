/**
 * Financial Tips Service
 * In-app financial literacy tips.
 */

const pool = require('../config/db');

async function getTips(category = null, language = 'sw', limit = 5) {
  let query = `SELECT * FROM financial_tips WHERE is_active = TRUE AND language = $1`;
  const params = [language];
  if (category) { query += ` AND category = $2`; params.push(category); }
  query += ` ORDER BY RANDOM() LIMIT $${params.length + 1}`;
  params.push(limit);
  const result = await pool.query(query, params);
  return result.rows;
}

async function getTipCategories() {
  const result = await pool.query(
    `SELECT category, COUNT(*)::int AS count FROM financial_tips WHERE is_active = TRUE GROUP BY category`
  );
  return result.rows;
}

async function trackDisplay(tipId) {
  await pool.query(
    `UPDATE financial_tips SET display_count = display_count + 1 WHERE id = $1`,
    [tipId]
  );
}

module.exports = { getTips, getTipCategories, trackDisplay };
