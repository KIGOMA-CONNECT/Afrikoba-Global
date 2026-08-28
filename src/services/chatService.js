/**
 * In-App Chat Service
 * Direct messaging between users.
 */

const pool = require('../config/db');

async function getOrCreateConversation(userId, otherUserId) {
  // Check existing direct conversation
  const existing = await pool.query(
    `SELECT c.id FROM conversations c
     JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = $1
     JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = $2
     WHERE c.type = 'DIRECT'`,
    [userId, otherUserId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // Create new conversation
  const conv = await pool.query(
    `INSERT INTO conversations (type) VALUES ('DIRECT') RETURNING id`
  );
  const convId = conv.rows[0].id;

  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
    [convId, userId, otherUserId]
  );

  return convId;
}

async function getConversations(userId) {
  const result = await pool.query(
    `SELECT c.*, cm.last_read_at,
       (SELECT content FROM messages WHERE conversation_id = c.id AND is_deleted = FALSE ORDER BY created_at DESC LIMIT 1) AS last_message,
       (SELECT sender_id FROM messages WHERE conversation_id = c.id AND is_deleted = FALSE ORDER BY created_at DESC LIMIT 1) AS last_sender,
       (SELECT created_at FROM messages WHERE conversation_id = c.id AND is_deleted = FALSE ORDER BY created_at DESC LIMIT 1) AS last_message_at,
       (SELECT COUNT(*)::int FROM messages WHERE conversation_id = c.id AND created_at > cm.last_read_at AND sender_id != $1 AND is_deleted = FALSE) AS unread_count
     FROM conversations c
     JOIN conversation_members cm ON c.id = cm.conversation_id AND cm.user_id = $1
     ORDER BY last_message_at DESC NULLS LAST`,
    [userId]
  );
  return result.rows;
}

async function getMessages(conversationId, userId, limit = 50, offset = 0) {
  // Verify membership
  const member = await pool.query(
    `SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  if (member.rows.length === 0) throw new Error('Huna ruhusa ya kuona ujumbe huu.');

  const messages = await pool.query(
    `SELECT m.*, u.phone AS sender_phone
     FROM messages m LEFT JOIN users u ON m.sender_id = u.id
     WHERE m.conversation_id = $1 AND m.is_deleted = FALSE
     ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
    [conversationId, limit, offset]
  );

  // Mark as read
  await pool.query(
    `UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );

  return messages.rows;
}

async function sendMessage(conversationId, senderId, { content, message_type, metadata }) {
  // Verify membership
  const member = await pool.query(
    `SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, senderId]
  );
  if (member.rows.length === 0) throw new Error('Huna ruhusa kutuma ujumbe.');

  const result = await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, content, message_type, metadata)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [conversationId, senderId, content, message_type || 'TEXT', metadata ? JSON.stringify(metadata) : null]
  );

  // Update conversation timestamp
  await pool.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);

  return result.rows[0];
}

async function deleteMessage(messageId, userId) {
  const result = await pool.query(
    `UPDATE messages SET is_deleted = TRUE WHERE id = $1 AND sender_id = $2 RETURNING id`,
    [messageId, userId]
  );
  return result.rows.length > 0;
}

async function getUnreadCount(userId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM messages m
     JOIN conversation_members cm ON m.conversation_id = cm.conversation_id
     WHERE cm.user_id = $1 AND m.created_at > cm.last_read_at AND m.sender_id != $1 AND m.is_deleted = FALSE`,
    [userId]
  );
  return result.rows[0].count;
}

module.exports = { getOrCreateConversation, getConversations, getMessages, sendMessage, deleteMessage, getUnreadCount };
