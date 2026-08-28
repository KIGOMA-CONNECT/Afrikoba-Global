/**
 * Support Ticketing Service
 * Customer support with ticket management.
 */

const pool = require('../config/db');
const crypto = require('crypto');

function generateTicketId() {
  return 'TKT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function createTicket(userId, { category, priority, subject, description }) {
  const validCategories = ['ACCOUNT', 'TRANSACTION', 'KYC', 'TECHNICAL', 'OTHER'];
  const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
  if (!validCategories.includes(category)) throw new Error('Kategoria batili.');
  if (!validPriorities.includes(priority)) priority = 'MEDIUM';

  const ticketId = generateTicketId();
  const result = await pool.query(
    `INSERT INTO support_tickets (user_id, ticket_id, category, priority, subject, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, ticketId, category, priority, subject, description]
  );

  // Auto-assign to admin
  const admins = await pool.query(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`);
  if (admins.rows.length > 0) {
    await pool.query(
      `UPDATE support_tickets SET assigned_to = $1 WHERE id = $2`,
      [admins.rows[0].id, result.rows[0].id]
    );
  }

  return result.rows[0];
}

async function getTickets(userId, status = null) {
  let query = `SELECT * FROM support_tickets WHERE user_id = $1`;
  const params = [userId];
  if (status) { query += ` AND status = $2`; params.push(status); }
  query += ` ORDER BY created_at DESC`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function getTicketDetail(userId, ticketInternalId) {
  const ticket = await pool.query(
    `SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2`,
    [ticketInternalId, userId]
  );
  if (ticket.rows.length === 0) throw new Error('Tikiti haipatikani.');

  const messages = await pool.query(
    `SELECT sm.*, u.phone AS sender_phone
     FROM support_messages sm
     LEFT JOIN users u ON sm.sender_id = u.id
     WHERE sm.ticket_id = $1 AND sm.is_internal = FALSE
     ORDER BY sm.created_at ASC`,
    [ticketInternalId]
  );

  return { ticket: ticket.rows[0], messages: messages.rows };
}

async function addMessage(ticketId, senderId, message) {
  const ticket = await pool.query(
    `SELECT id, user_id, status FROM support_tickets WHERE id = $1`,
    [ticketId]
  );
  if (ticket.rows.length === 0) throw new Error('Tikiti haipatikani.');

  // Allow both ticket creator and assigned agent
  const result = await pool.query(
    `INSERT INTO support_messages (ticket_id, sender_id, message) VALUES ($1, $2, $3) RETURNING *`,
    [ticketId, senderId, message]
  );

  // Reopen if was resolved
  if (ticket.rows[0].status === 'RESOLVED' || ticket.rows[0].status === 'CLOSED') {
    await pool.query(
      `UPDATE support_tickets SET status = 'OPEN', updated_at = NOW() WHERE id = $1`,
      [ticketId]
    );
  } else {
    await pool.query(`UPDATE support_tickets SET updated_at = NOW() WHERE id = $1`, [ticketId]);
  }

  return result.rows[0];
}

async function updateStatus(ticketId, status, resolution = null) {
  const validStatuses = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'];
  if (!validStatuses.includes(status)) throw new Error('Hali batili.');

  const updates = { status, updated_at: new Date() };
  if (resolution) updates.resolution = resolution;
  if (status === 'RESOLVED' || status === 'CLOSED') updates.resolved_at = new Date();

  const result = await pool.query(
    `UPDATE support_tickets
     SET status = $1, resolution = COALESCE($2, resolution),
         resolved_at = CASE WHEN $1 IN ('RESOLVED', 'CLOSED') THEN NOW() ELSE resolved_at END,
         updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status, resolution, ticketId]
  );
  return result.rows[0];
}

async function getAllTickets(status = null, limit = 50, offset = 0) {
  let query = `SELECT st.*, u.phone AS user_phone
               FROM support_tickets st
               LEFT JOIN users u ON st.user_id = u.id`;
  const params = [];
  if (status) { query += ` WHERE st.status = $1`; params.push(status); }
  query += ` ORDER BY st.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  const result = await pool.query(query, params);
  return result.rows;
}

async function getTicketStats() {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
       COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
       COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved,
       COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed
     FROM support_tickets`
  );
  return result.rows[0];
}

module.exports = { createTicket, getTickets, getTicketDetail, addMessage, updateStatus, getAllTickets, getTicketStats };
