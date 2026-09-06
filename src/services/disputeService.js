/**
 * Dispute Resolution Service
 * Full lifecycle: report -> review (assignment) -> mediation escalation
 * -> typed decision (REFUND via the ledger / REJECT) with notes + audit.
 * Marketplace escrow disputes share this table but keep their own
 * escrow-aware resolution (see marketplaceService.resolveMarketplaceDispute).
 */

const pool = require('../config/db');
const logger = require('../utils/logger');
const { generateReference } = require('../utils/helpers');
const { logAction } = require('./auditService');
const fin = require('./financialEngine');

const VALID_REASONS = ['UNAUTHORIZED', 'WRONG_AMOUNT', 'DUPLICATE', 'NOT_RECEIVED', 'FRAUD', 'OTHER'];
const VALID_STATUSES = ['OPEN', 'UNDER_REVIEW', 'MEDIATION', 'RESOLVED', 'REJECTED'];
const REVIEWER_ROLES = ['ADMIN', 'SUPPORT', 'COMPLIANCE'];

function badge(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/** Refund the disputed amount back through the ledger (double-entry). */
async function refundFromLedger(client, userId, amount, ref, description) {
  await fin.creditWallet({ client, userId, amount, reference: ref, fromAccount: 'SUSPENSE', description });
  await client.query(
    `INSERT INTO transactions (user_id, type, total_charged, wallet_amount, commission, status, reference_id, meta)
     VALUES ($1, 'TRANSFER', $2, $2, 0, 'SUCCESS', $3, $4::jsonb)`,
    [userId, amount, ref, JSON.stringify({ feature: 'dispute_refund', note: description })]
  );
}

/**
 * Create dispute.
 */
async function createDispute(userId, transactionId, reason, description, amountDisputed) {
  if (!VALID_REASONS.includes(reason)) {
    throw badge('Sababu batili. Sababu zinazokubalika: ' + VALID_REASONS.join(', '));
  }

  // Verify transaction exists and belongs to user
  const tx = await pool.query(
    `SELECT id, total_charged, wallet_amount, user_id, type FROM transactions WHERE id = $1`,
    [transactionId]
  );

  if (tx.rows.length === 0) throw badge('Muamala haupatikani.', 404);
  if (tx.rows[0].user_id !== userId) throw badge('Huwezi kuchangia muamala wa mtu mwingine.', 403);

  // Check if dispute already exists
  const existing = await pool.query(
    `SELECT id FROM disputes WHERE user_id = $1 AND transaction_id = $2 AND status != 'REJECTED'`,
    [userId, transactionId]
  );

  if (existing.rows.length > 0) throw badge('Mjadala kwa muamala huu tayari umefunguliwa.', 409);

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

  await logAction(userId, 'DISPUTE_OPENED', 'DISPUTE', result.rows[0].id, { transaction_id: transactionId }, null);

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
 * Get all disputes (admin review queue). Covers banking and marketplace.
 */
async function getAllDisputes(status = null, limit = 50, offset = 0) {
  let query = `SELECT d.*, u.phone_number AS user_phone, u.full_name AS user_name,
               t.total_charged AS transaction_amount, t.type AS transaction_type,
               o.reference AS order_reference, o.title AS order_title
               FROM disputes d
               LEFT JOIN users u ON d.user_id = u.id
               LEFT JOIN transactions t ON d.transaction_id = t.id
               LEFT JOIN marketplace_orders o ON d.marketplace_order_id = o.id`;
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

async function listDisputeStats() {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
       COUNT(*) FILTER (WHERE status = 'UNDER_REVIEW')::int AS under_review,
       COUNT(*) FILTER (WHERE status = 'MEDIATION')::int AS mediation,
       COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved,
       COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
     FROM disputes`
  );
  return result.rows[0];
}

async function getDisputeDetail(disputeId) {
  const result = await pool.query(
    `SELECT d.*, u.phone_number AS user_phone, u.full_name AS user_name,
            t.total_charged AS transaction_amount, t.type AS transaction_type,
            o.reference AS order_reference, o.title AS order_title
       FROM disputes d
       LEFT JOIN users u ON d.user_id = u.id
       LEFT JOIN transactions t ON d.transaction_id = t.id
       LEFT JOIN marketplace_orders o ON d.marketplace_order_id = o.id
      WHERE d.id = $1`,
    [disputeId]
  );
  if (result.rows.length === 0) throw badge('Mjadala haupatikani.', 404);
  return result.rows[0];
}

/** Append a note to the dispute timeline (collaboration history). */
async function addDisputeNote(disputeId, actorId, note) {
  if (!note || !String(note).trim()) throw badge('Ujumbe unahitajika.');
  const safeNote = String(note).slice(0, 1000);
  const result = await pool.query(
    `UPDATE disputes SET notes = array_append(COALESCE(notes, '{}'), $2), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [disputeId, `${actorId}: ${safeNote}`]
  );
  if (result.rows.length === 0) throw badge('Mjadala haupatikani.', 404);
  const dispute = result.rows[0];
  await logAction(actorId, 'DISPUTE_NOTE_ADDED', 'DISPUTE', disputeId, { note: safeNote }, null);
  return dispute;
}

/** Assign reviewer and move an OPEN dispute into UNDER_REVIEW. */
async function startDisputeReview(disputeId, reviewerId, note = null) {
  const result = await pool.query(
    `UPDATE disputes
        SET status = 'UNDER_REVIEW', assigned_to = $2,
            notes = CASE WHEN $3::text IS NULL OR $3::text = '' THEN COALESCE(notes, '{}')
                         ELSE array_append(COALESCE(notes, '{}'), $3::text) END,
            updated_at = NOW()
      WHERE id = $1 AND status = 'OPEN'
      RETURNING *`,
    [disputeId, reviewerId, note ? `${reviewerId}: ${String(note).slice(0, 1000)}` : null]
  );
  if (result.rows.length === 0) throw badge('Mjadala haupatikani au hauko katika hali ya OPEN.', 409);
  await logAction(reviewerId, 'DISPUTE_REVIEW_STARTED', 'DISPUTE', disputeId, {}, null);
  return result.rows[0];
}

/** Escalate an UNDER_REVIEW dispute to mediation. */
async function escalateDispute(disputeId, reviewerId, note = null) {
  const result = await pool.query(
    `UPDATE disputes
        SET status = 'MEDIATION', escalated_at = NOW(), assigned_to = $2,
            notes = CASE WHEN $3::text IS NULL OR $3::text = '' THEN COALESCE(notes, '{}')
                         ELSE array_append(COALESCE(notes, '{}'), $3::text) END,
            updated_at = NOW()
      WHERE id = $1 AND status = 'UNDER_REVIEW'
      RETURNING *`,
    [disputeId, reviewerId, note ? `${reviewerId}: ${String(note).slice(0, 1000)}` : null]
  );
  if (result.rows.length === 0) throw badge('Mjadala haupatikani au hauko UNDER_REVIEW.', 409);
  await logAction(reviewerId, 'DISPUTE_ESCALATED', 'DISPUTE', disputeId, {}, null);
  return result.rows[0];
}

/**
 * Final decision on a banking dispute (transaction-linked).
 * action = 'REFUND' (ledger credit) | 'REJECT' (denied).
 * Marketplace escrow disputes must go through resolveMarketplaceDispute.
 */
async function decideDispute(disputeId, reviewerId, { action, note = null, amount = null }) {
  const resolvedAction = String(action || '').toUpperCase();
  if (!['REFUND', 'REJECT'].includes(resolvedAction)) throw badge('Uamuzi batili: REFUND | REJECT.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await client.query(
      `SELECT * FROM disputes WHERE id = $1 AND status IN ('OPEN','UNDER_REVIEW','MEDIATION') FOR UPDATE`,
      [disputeId]
    );
    if (d.rows.length === 0) throw badge('Mjadala haupatikani au tayari umeamuliwa.', 409);
    const dispute = d.rows[0];
    if (dispute.marketplace_order_id) {
      throw badge('Mjadala wa escrow unahitaji uamuzi wa marketplace (BUYER_REFUND/SELLER_PAYOUT/SPLIT).', 409);
    }

    const refundedAmount = amount != null && amount !== '' ? Number(amount) : Number(dispute.amount_disputed);
    if (!Number.isFinite(refundedAmount) || refundedAmount < 0) throw badge('Kiasi batili.');

    const noteText = note ? `${reviewerId}: ${String(note).slice(0, 1000)}` : null;

    const result = await client.query(
      `UPDATE disputes
          SET status = $2, resolution_type = $3, resolved_amount = $4,
              resolution = $5, resolved_by = $6, resolved_at = NOW(),
              notes = CASE WHEN $7::text IS NULL OR $7::text = '' THEN COALESCE(notes, '{}')
                           ELSE array_append(COALESCE(notes, '{}'), $7::text) END,
              updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [disputeId, resolvedAction === 'REFUND' ? 'RESOLVED' : 'REJECTED',
       resolvedAction === 'REFUND' ? 'REFUND' : 'REJECTED',
       resolvedAction === 'REFUND' ? refundedAmount : null,
       resolvedAction === 'REFUND' ? `Refund ya TSh ${refundedAmount} imetolewa.` : 'Mjadala umekataliwa.',
       reviewerId, noteText]
    );

    const disputeAfter = result.rows[0];

    if (resolvedAction === 'REFUND' && refundedAmount > 0) {
      const ref = generateReference('DSP');
      await refundFromLedger(client, disputeAfter.user_id, refundedAmount, ref, `Mrejesho kwa mjadala #${disputeAfter.id}`);
      await client.query(`UPDATE transactions SET dispute_id = $1 WHERE id = $2`, [disputeAfter.id, disputeAfter.transaction_id]);
    }

    await client.query('COMMIT');
    await logAction(reviewerId, 'DISPUTE_DECIDED', 'DISPUTE', disputeId, { action: resolvedAction, amount: refundedAmount }, null);
    logger.info('DISPUTE', `Dispute #${disputeId} ${resolvedAction} by reviewer ${reviewerId}`);
    return disputeAfter;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createDispute,
  getUserDisputes,
  getAllDisputes,
  listDisputeStats,
  getDisputeDetail,
  addDisputeNote,
  startDisputeReview,
  escalateDispute,
  decideDispute,
  VALID_REASONS,
  VALID_STATUSES,
  REVIEWER_ROLES,
};