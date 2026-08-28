/**
 * KYC Document Service
 * Upload and verify identity documents.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const VALID_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE', 'UTILITY_BILL', 'SELFIE'];

async function uploadDocument(userId, { document_type, file_url, file_hash, expires_at }) {
  if (!VALID_TYPES.includes(document_type)) {
    throw new Error('Aina ya hati batili. Tumia: ' + VALID_TYPES.join(', '));
  }
  if (!file_url) throw new Error('URL ya faili inahitajika.');

  const result = await pool.query(
    `INSERT INTO kyc_documents (user_id, document_type, file_url, file_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, document_type, file_url, file_hash || null, expires_at || null]
  );

  return result.rows[0];
}

async function getDocuments(userId) {
  const result = await pool.query(
    `SELECT * FROM kyc_documents WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function getPendingDocuments() {
  const result = await pool.query(
    `SELECT kd.*, u.phone, u.name
     FROM kyc_documents kd
     LEFT JOIN users u ON kd.user_id = u.id
     WHERE kd.status = 'PENDING'
     ORDER BY kd.created_at ASC`
  );
  return result.rows;
}

async function verifyDocument(documentId, adminId, status, rejectionReason = null) {
  if (!['APPROVED', 'REJECTED'].includes(status)) {
    throw new Error('Hali batili.');
  }

  const result = await pool.query(
    `UPDATE kyc_documents
     SET status = $1, rejection_reason = $2, verified_by = $3, verified_at = NOW()
     WHERE id = $4 RETURNING *`,
    [status, rejectionReason, adminId, documentId]
  );

  if (result.rows.length === 0) throw new Error('Haiwezekani. Hati haipatikani.');

  // Auto-upgrade KYC level if all required docs approved
  const doc = result.rows[0];
  if (status === 'APPROVED') {
    const userDocs = await pool.query(
      `SELECT document_type FROM kyc_documents
       WHERE user_id = $1 AND status = 'APPROVED'`,
      [doc.user_id]
    );

    const approvedTypes = userDocs.rows.map((r) => r.document_type);
    let newLevel = 1;
    if (approvedTypes.includes('NATIONAL_ID') || approvedTypes.includes('PASSPORT')) newLevel = 2;
    if (newLevel >= 2 && approvedTypes.includes('SELFIE')) newLevel = 3;

    await pool.query(
      `UPDATE users SET kyc_level = GREATEST(kyc_level, $1), updated_at = NOW() WHERE id = $2`,
      [newLevel, doc.user_id]
    );
    logger.info('KYC', `User ${doc.user_id} KYC upgraded to level ${newLevel}`);
  }

  return result.rows[0];
}

async function getDocumentStats() {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
       COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
     FROM kyc_documents`
  );
  return result.rows[0];
}

module.exports = { uploadDocument, getDocuments, getPendingDocuments, verifyDocument, getDocumentStats };
