/**
 * Dispute Resolution Service
 * Allow users to report and track transaction disputes.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');
const { generateReference } = require('../utils/helpers');
const fin = require('./financialEngine');

const VALID_REASONS = ['UNAUTHORIZED', 'WRONG_AMOUNT', 'DUPLICATE', 'NOT_RECEIVED', 'FRAUD', 'OTHER'];
const VALID_STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED'];

/**
 * Create dispute.
 */
async function createDispute(userId, transactionId, reason, description, amountDisputed) {
  if (!VALID_REASONS.includes(reason)) {
    throw new Error('Sababu batili. Sababu zinazokubalika: ' + VALID_REASONS.join(', '));
  }

  // Verify transaction exists and belongs to user
  const tx = await pool.query(
    `SELECT id, total_charged, wallet_amount, user_id, type FROM transactions WHERE id = $1`,
    [transactionId]
  );

  if (tx.rows.length === 0) {
    throw new Error('Muamala haupatikani.');
  }

  if (tx.rows[0].user_id !== userId) {
    throw new Error('Huwezi kuchangia muamala wa mtu mwingine.');
  }

  // Check if dispute already exists
  const existing = await pool.query(
    `SELECT id FROM disputes WHERE user_id = $1 AND transaction_id = $2 AND status != 'REJECTED'`,
    [userId, transactionId]
  );

  if (existing.rows.length > 0) {
    throw new Error('Mjadala kwa muamala huu tayari umefunguliwa.');
  }

  const result = await pool.query(
    `INSERT INTO disputes (user_id, transaction_id, reason, description, amount_disputed)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
     [userId, transactionId, reason, description, amountDisputed || tx.rows[0].total_charged]
  );

  // Update transaction with dispute reference
  await pool.query(
    `UPDATE transactions SET dispute_id = $1 WHERE id = $2`,
    [result.rows[0].id, transactionId]
  );

  // Alert if FRAUD or UNAUTHORIZED
  if (reason === 'FRAUD' || reason === 'UNAUTHORIZED') {
    await pool.query(
      `INSERT INTO fraud_alerts (user_id, alert_type, severity, description, transaction_id)
       VALUES ($1, $2, 'HIGH', $3, $4)`,
      [userId, reason, description, transactionId]
    );
    logger.warn('FRAUD', `Dispute #${result.rows[0].id}: ${reason} by user ${userId}`);
  }

  return result.rows[0];
}

/**
 * Get user disputes.
 */
async function getUserDisputes(userId, status = null) {
  let query = `SELECT d.*, t.total_charged AS transaction_amount, t.type AS transaction_type,
               t.created_at AS transaction_date
               FROM disputes d
               LEFT JOIN transactions t ON d.transaction_id = t.id
               WHERE d.user_id = $1`;
  const params = [userId];

  if (status) {
    query += ` AND d.status = $2`;
    params.push(status);
  }

  query += ` ORDER BY d.created_at DESC`;
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get all disputes (admin).
 */
async function getAllDisputes(status = null, limit = 50, offset = 0) {
  let query = `SELECT d.*, u.phone AS user_phone, t.total_charged AS transaction_amount,
               t.type AS transaction_type
               FROM disputes d
               LEFT JOIN users u ON d.user_id = u.id
               LEFT JOIN transactions t ON d.transaction_id = t.id`;
  const params = [];

  if (status) {
    query += ` WHERE d.status = $1`;
    params.push(status);
  }

  query += ` ORDER BY d.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Resolve dispute (admin).
 */
async function resolveDispute(disputeId, adminId, resolution, status = 'RESOLVED') {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error('Hali batili.');
  }

  const result = await pool.query(
    `UPDATE disputes
     SET status = $1, resolution = $2, resolved_by = $3, resolved_at = NOW(), updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [status, resolution, adminId, disputeId]
  );

  if (result.rows.length === 0) {
    throw new Error('Mjadala haupatikani.');
  }

  // If resolved in favor of user, refund
  if (status === 'RESOLVED' && result.rows[0].transaction_id) {
    const dispute = result.rows[0];
    if (dispute.reason === 'DUPLICATE' || dispute.reason === 'NOT_RECEIVED') {
      // Auto-credit back to user
      const ref = generateReference('DSP');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await fin.creditWallet({
          client, userId: dispute.user_id, amount: dispute.amount_disputed,
          reference: ref, fromAccount: 'SUSPENSE',
          description: 'Dispute refund'
        });

        await client.query(
          `INSERT INTO transactions (user_id, type, amount, status, description, reference_type, reference_id)
           VALUES ($1, 'DISPUTE_REFUND', $2, 'COMPLETED', $3, 'DISPUTE', $4)`,
          [dispute.user_id, dispute.amount_disputed, `Mrejesho kwa mjadala #${disputeId}`, ref]
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      logger.info('DISPUTE', `Refund TSh ${dispute.amount_disputed} for dispute #${disputeId}`);
    }
  }

  return result.rows[0];
}

module.exports = { createDispute, getUserDisputes, getAllDisputes, resolveDispute };
