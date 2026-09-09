/**
 * Support Ticketing Service
 * Customer support with ticket management.
 */

const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');

function generateTicketId() {
  return 'TKT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function createTicket(userId, { category, priority, subject, description }) {
  const validCategories = ['ACCOUNT', 'TRANSACTION', 'KYC', 'TECHNICAL', 'OTHER'];
  const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
  if (!validCategories.includes(category)) throw createAppError('SUPPORT_CATEGORY_INVALID');
  if (!validPriorities.includes(priority)) priority = 'MEDIUM';

  const ticketId = generateTicketId();
  const result = await pool.query(
    `INSERT INTO support_tickets (user_id, ticket_id, category, priority, subject, description, assigned_to)
     VALUES ($1, $2, $3, $4, $5, $6,
             (SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1))
     RETURNING *`,
    [userId, ticketId, category, priority, subject, description]
  );

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
  if (ticket.rows.length === 0) throw createAppError('SUPPORT_TICKET_NOT_FOUND');

  const messages = await pool.query(
    `SELECT sm.*, u.phone_number AS sender_phone
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
    `SELECT id, user_id, assigned_to, status FROM support_tickets WHERE id = $1`,
    [ticketId]
  );
  if (ticket.rows.length === 0) throw createAppError('SUPPORT_TICKET_NOT_FOUND');

  // Only the ticket owner, the assigned agent, or a support role may reply.
  const sender = await pool.query(`SELECT role FROM users WHERE id = $1`, [senderId]);
  const senderRole = sender.rows[0] ? sender.rows[0].role : null;
  const t = ticket.rows[0];
  const isAgent = t.assigned_to === senderId || ['ADMIN', 'SUPPORT', 'COMPLIANCE'].includes(senderRole);
  if (t.user_id !== senderId && !isAgent) throw createAppError('AUTH_INSUFFICIENT_SCOPE');

  const result = await pool.query(
    `INSERT INTO support_messages (ticket_id, sender_id, message) VALUES ($1, $2, $3) RETURNING *`,
    [ticketId, senderId, message]
  );

  // Reopen if was resolved
  if (t.status === 'RESOLVED' || t.status === 'CLOSED') {
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
  if (!validStatuses.includes(status)) throw createAppError('SUPPORT_STATUS_INVALID');

  const exists = await pool.query(`SELECT id FROM support_tickets WHERE id = $1`, [ticketId]);
  if (exists.rows.length === 0) throw createAppError('SUPPORT_TICKET_NOT_FOUND');

  const isResolving = status === 'RESOLVED' || status === 'CLOSED';
  const result = await pool.query(
    `UPDATE support_tickets
     SET status = $1, resolution = COALESCE($2, resolution),
         resolved_at = CASE WHEN $4 THEN NOW() ELSE resolved_at END,
         updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status, resolution, ticketId, isResolving]
  );
  return result.rows[0];
}

async function getAllTickets(status = null, limit = 50, offset = 0) {
  let query = `SELECT st.*, u.phone_number AS user_phone
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
