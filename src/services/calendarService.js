/**
 * Financial Calendar Service
 * Due dates, reminders, events.
 */

const pool = require('../config/db');

async function createEvent(userId, { title, description, event_type, event_date, amount, is_recurring, recurrence_pattern, reminder_days, related_id }) {
  if (!title || !event_date) throw new Error('Jina na tarehe vinahitajika.');

  const result = await pool.query(
    `INSERT INTO calendar_events (user_id, title, description, event_type, event_date, amount, is_recurring, recurrence_pattern, reminder_days, related_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [userId, title, description || null, event_type || 'CUSTOM', event_date, amount || null,
     is_recurring || false, recurrence_pattern || null, reminder_days || 1, related_id || null]
  );
  return result.rows[0];
}

async function getEvents(userId, month = null, year = null) {
  let query = `SELECT * FROM calendar_events WHERE user_id = $1`;
  const params = [userId];
  let idx = 2;

  if (month && year) {
    query += ` AND EXTRACT(MONTH FROM event_date) = $${idx++} AND EXTRACT(YEAR FROM event_date) = $${idx++}`;
    params.push(month, year);
  }

  query += ` ORDER BY event_date ASC`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function getUpcoming(userId, days = 30) {
  const result = await pool.query(
    `SELECT * FROM calendar_events
     WHERE user_id = $1 AND event_date BETWEEN NOW() AND NOW() + $2::interval AND is_completed = FALSE
     ORDER BY event_date ASC`,
    [userId, `${days} days`]
  );
  return result.rows;
}

async function completeEvent(userId, eventId) {
  const result = await pool.query(
    `UPDATE calendar_events SET is_completed = TRUE WHERE id = $1 AND user_id = $2 RETURNING *`,
    [eventId, userId]
  );
  return result.rows[0];
}

async function deleteEvent(userId, eventId) {
  const result = await pool.query(
    `DELETE FROM calendar_events WHERE id = $1 AND user_id = $2 RETURNING id`,
    [eventId, userId]
  );
  return result.rows.length > 0;
}

module.exports = { createEvent, getEvents, getUpcoming, completeEvent, deleteEvent };
