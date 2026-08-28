/**
 * Debt Tracker Service
 * Track money lent and owed.
 */

const pool = require('../config/db');

async function createDebt(userId, { direction, counterparty_phone, counterparty_name, amount, description, due_date }) {
  if (!['LENT', 'OWED'].includes(direction)) throw new Error('Mwelekeo batili.');
  if (amount <= 0) throw new Error('Kiasi lazima kiwe chanya.');

  const result = await pool.query(
    `INSERT INTO debts (user_id, direction, counterparty_phone, counterparty_name, amount, description, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, direction, counterparty_phone, counterparty_name || null, amount, description || null, due_date || null]
  );
  return result.rows[0];
}

async function getDebts(userId, direction = null, status = null) {
  let query = `SELECT * FROM debts WHERE user_id = $1`;
  const params = [userId];
  let idx = 2;
  if (direction) { query += ` AND direction = $${idx++}`; params.push(direction); }
  if (status) { query += ` AND status = $${idx++}`; params.push(status); }
  query += ` ORDER BY created_at DESC`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function getDebtSummary(userId) {
  const result = await pool.query(
    `SELECT direction,
       COUNT(*)::int AS count,
       COALESCE(SUM(amount), 0)::numeric AS total_amount,
       COALESCE(SUM(amount_paid), 0)::numeric AS total_paid,
       COALESCE(SUM(amount - amount_paid), 0)::numeric AS total_outstanding
     FROM debts WHERE user_id = $1 AND status != 'WRITTEN_OFF'
     GROUP BY direction`,
    [userId]
  );

  const summary = { LENT: { count: 0, total: 0, paid: 0, outstanding: 0 }, OWED: { count: 0, total: 0, paid: 0, outstanding: 0 } };
  for (const row of result.rows) {
    summary[row.direction] = {
      count: row.count,
      total: parseFloat(row.total_amount),
      paid: parseFloat(row.total_paid),
      outstanding: parseFloat(row.total_outstanding),
    };
  }
  summary.net = summary.LENT.outstanding - summary.OWED.outstanding;
  return summary;
}

async function recordPayment(debtId, userId, amount) {
  if (amount <= 0) throw new Error('Kiasi lazima kiwe chanya.');

  const debt = await pool.query(`SELECT * FROM debts WHERE id = $1 AND user_id = $2`, [debtId, userId]);
  if (debt.rows.length === 0) throw new Error('Deni haipatikani.');

  const d = debt.rows[0];
  const newPaid = parseFloat(d.amount_paid) + amount;
  if (newPaid > parseFloat(d.amount)) throw new Error('Kiasi kikubwa kuliko deni.');

  const newStatus = newPaid >= parseFloat(d.amount) ? 'PAID' : 'PARTIAL';

  const result = await pool.query(
    `UPDATE debts SET amount_paid = $1, status = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
    [newPaid, newStatus, debtId]
  );

  return result.rows[0];
}

async function writeOff(debtId, userId) {
  const result = await pool.query(
    `UPDATE debts SET status = 'WRITTEN_OFF', updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
    [debtId, userId]
  );
  return result.rows[0];
}

async function deleteDebt(debtId, userId) {
  const result = await pool.query(
    `DELETE FROM debts WHERE id = $1 AND user_id = $2 AND status = 'PENDING' RETURNING id`,
    [debtId, userId]
  );
  return result.rows.length > 0;
}

module.exports = { createDebt, getDebts, getDebtSummary, recordPayment, writeOff, deleteDebt };
