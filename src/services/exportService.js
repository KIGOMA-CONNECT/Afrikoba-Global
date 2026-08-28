/**
 * Data Export Service
 * Export transactions, analytics to CSV.
 */

const pool = require('../config/db');

async function exportTransactions(userId, { startDate, endDate, type, format = 'csv' }) {
  let query = `SELECT * FROM transactions WHERE user_id = $1`;
  const params = [userId];
  let idx = 2;

  if (startDate) { query += ` AND created_at >= $${idx++}`; params.push(startDate); }
  if (endDate) { query += ` AND created_at <= $${idx++}`; params.push(endDate); }
  if (type) { query += ` AND type = $${idx++}`; params.push(type); }

  query += ` ORDER BY created_at DESC`;
  const result = await pool.query(query, params);

  if (format === 'csv') {
    return toCsv(result.rows);
  }

  return result.rows;
}

function toCsv(rows) {
  if (rows.length === 0) return 'No data';
  const headers = Object.keys(rows[0]).join(',');
  const lines = rows.map((row) =>
    Object.values(row).map((v) => {
      if (v === null || v === undefined) return '';
      const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(',')
  );
  return [headers, ...lines].join('\n');
}

async function exportVicobaSummary(userId) {
  const result = await pool.query(
    `SELECT vm.group_id, vg.name AS group_name, vm.role, vm.total_contributed, vm.shares_owned
     FROM vicoba_members vm
     JOIN vicoba_groups vg ON vm.group_id = vg.id
     WHERE vm.user_id = $1`,
    [userId]
  );
  return result.rows;
}

async function exportRoscaSummary(userId) {
  const result = await pool.query(
    `SELECT rp.pool_id, rp.name AS pool_name, rp.status, rpm.position, rpm.total_contributed, rpm.total_received
     FROM rosca_pool_members rpm
     JOIN rosca_pools rp ON rpm.pool_id = rp.id
     WHERE rpm.user_id = $1`,
    [userId]
  );
  return result.rows;
}

module.exports = { exportTransactions, exportVicobaSummary, exportRoscaSummary };
