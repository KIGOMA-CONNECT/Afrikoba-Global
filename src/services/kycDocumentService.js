/**
 * KYC Document Service
 * Upload and verify identity documents + biographic identity profile.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const VALID_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE', 'UTILITY_BILL', 'SELFIE'];

async function uploadDocument(userId, { document_type, document_url, file_hash, document_number, issued_country, submitted_via, expires_at }) {
  if (!VALID_TYPES.includes(document_type)) {
    throw Object.assign(new Error('Aina ya hati batili. Tumia: ' + VALID_TYPES.join(', ')), { statusCode: 400 });
  }
  if (!document_url) throw Object.assign(new Error('URL ya faili inahitajika.'), { statusCode: 400 });

  const result = await pool.query(
    `INSERT INTO kyc_documents (user_id, document_type, document_url, file_hash, document_number, issued_country, submitted_via, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, document_type, document_url, file_hash || null, document_number || null, issued_country || 'TZ', submitted_via || 'WEB', expires_at || null]
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
    `SELECT kd.*, u.phone_number, u.full_name
     FROM kyc_documents kd
     LEFT JOIN users u ON kd.user_id = u.id
     WHERE kd.status = 'PENDING'
     ORDER BY kd.created_at ASC`
  );
  return result.rows;
}

async function verifyDocument(documentId, adminId, status, rejectionReason = null, reviewerNote = null) {
  if (!['APPROVED', 'REJECTED'].includes(status)) {
    throw new Error('Hali batili.');
  }

  const result = await pool.query(
    `UPDATE kyc_documents
     SET status = $1, rejection_reason = $2, verified_by = $3, verified_at = NOW(), reviewed_at = NOW(), reviewer_note = COALESCE($5, reviewer_note)
     WHERE id = $4 RETURNING *`,
    [status, rejectionReason, adminId, documentId, reviewerNote]
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

async function upsertBiographicProfile(userId, { nida_number, residential_address, id_document_url }) {
  if (!nida_number && !residential_address && !id_document_url) {
    throw Object.assign(new Error('Angalau sehemu moja inahitajika (nida_number, residential_address, id_document_url).'), { statusCode: 400 });
  }
  const result = await pool.query(
    `UPDATE users
     SET nida_number = COALESCE($2, nida_number),
         residential_address = COALESCE($3, residential_address),
         id_document_url = COALESCE($4, id_document_url),
         updated_at = NOW()
     WHERE id = $1 RETURNING id, nida_number, residential_address, id_document_url, kyc_level`,
    [userId, nida_number || null, residential_address || null, id_document_url || null]
  ).catch((err) => {
    if (err.code === '23505') throw Object.assign(new Error('Namba ya NIDA imeshatumiwa na mtumiaji mwingine.'), { statusCode: 409 });
    throw err;
  });
  if (result.rows.length === 0) throw new Error('Mtumiaji hapatikani.');
  return result.rows[0];
}

async function getKycStatus(userId) {
  const user = await pool.query(
    `SELECT kyc_level, nida_number, residential_address, id_document_url FROM users WHERE id = $1`,
    [userId]
  );
  if (user.rows.length === 0) throw Object.assign(new Error('Mtumiaji hapatikani.'), { statusCode: 404 });
  const docs = await pool.query(
    `SELECT id, document_type, document_url, document_number, issued_country, status, rejection_reason, expires_at, created_at, reviewed_at
     FROM kyc_documents WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return { ...user.rows[0], documents: docs.rows };
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

module.exports = { uploadDocument, getDocuments, getPendingDocuments, verifyDocument, upsertBiographicProfile, getKycStatus, getDocumentStats };