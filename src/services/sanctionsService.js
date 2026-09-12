const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');

// ---------- Name normalization ----------

function stripDiacritics(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeName(s) {
  return stripDiacritics(String(s).toLowerCase()).replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizePhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  // E.164-ish: if starts with 0, assume local TZ (255)
  if (digits.startsWith('0') && digits.length >= 9) return '255' + digits.slice(1);
  return digits;
}

// ---------- Simple Levenshtein for name matching ----------

function levenshtein(a, b) {
  if (!a || !b) return Math.max((a || '').length, (b || '').length);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

// ---------- Watchlist CRUD (admin) ----------

async function addEntry({ source, category, full_name, phone_number, document_type, document_number, country_code, birth_date, reference, notes, createdBy }) {
  if (!source || !full_name) throw createAppError('SANCTIONS_SOURCE_REQUIRED');
  const normalized = normalizeName(full_name);
  const phone = normalizePhone(phone_number);
  const r = await pool.query(
    `INSERT INTO sanctions_watchlist (source, category, full_name, normalized_name, phone_number, document_type, document_number, country_code, birth_date, reference, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [source, category || 'INDIVIDUAL', full_name, normalized, phone, document_type || null, document_number || null, country_code || null, birth_date || null, reference || null, notes || null, createdBy || null]
  );
  return r.rows[0];
}

async function updateEntry(id, patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  for (const key of ['source', 'category', 'phone_number', 'document_type', 'document_number', 'country_code', 'birth_date', 'reference', 'notes', 'status']) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = $${i++}`);
      vals.push(key === 'phone_number' ? normalizePhone(patch[key]) : patch[key]);
    }
  }
  if (patch.full_name !== undefined) {
    fields.push(`full_name = $${i++}`, `normalized_name = $${i++}`);
    vals.push(patch.full_name, normalizeName(patch.full_name));
  }
  if (!fields.length) throw createAppError('SANCTIONS_SOURCE_REQUIRED'); // nothing to update
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const r = await pool.query(`UPDATE sanctions_watchlist SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  return r.rows[0];
}

async function listEntries({ source, status, limit = 50, offset = 0 } = {}) {
  const conds = [];
  const p = [];
  if (source) { conds.push(`source = $${p.length + 1}`); p.push(source); }
  if (status) { conds.push(`status = $${p.length + 1}`); p.push(status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  p.push(limit, offset);
  const r = await pool.query(
    `SELECT * FROM sanctions_watchlist ${where} ORDER BY id DESC LIMIT $${p.length - 1} OFFSET $${p.length}`,
    p
  );
  return r.rows;
}

async function getEntry(id) {
  const r = await pool.query('SELECT * FROM sanctions_watchlist WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// ---------- Name/phone/doc matching ----------

function nameSimilarity(normA, normB) {
  if (!normA || !normB) return 0;
  // Full name containment
  if (normA.includes(normB) || normB.includes(normA)) return 95;
  const tokensA = normA.split(/\s+/).filter(Boolean);
  const tokensB = normB.split(/\s+/).filter(Boolean);
  // Any single token exact match
  for (const a of tokensA) {
    for (const b of tokensB) {
      if (a === b) return 90;
      // Close match on short tokens
      if (a.length >= 3 && b.length >= 3 && levenshtein(a, b) <= 1) return 80;
    }
  }
  // Whole-name Levenshtein ratio
  const dist = levenshtein(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 0;
  const ratio = (1 - dist / maxLen) * 100;
  return ratio >= 60 ? Math.round(ratio) : 0;
}

// ---------- Core screening ----------

async function screenSubject({ type, id, name, phone, documentType, documentNumber }) {
  const normName = normalizeName(name);
  const normPhone = normalizePhone(phone);
  const entries = await pool.query(`SELECT * FROM sanctions_watchlist WHERE status = 'ACTIVE'`);
  const hits = [];
  for (const e of entries.rows) {
    // Phone match
    if (normPhone && e.phone_number && normPhone === e.phone_number) {
      hits.push({ watchlistId: e.id, field: 'phone', score: 100, severity: 'CRITICAL', entry: e });
    }
    // Document match
    if (documentType && documentNumber && e.document_type === documentType && e.document_number && e.document_number === documentNumber) {
      hits.push({ watchlistId: e.id, field: 'document', score: 100, severity: 'CRITICAL', entry: e });
    }
    // Name match
    if (normName) {
      const score = nameSimilarity(normName, e.normalized_name);
      if (score >= 60) {
        const severity = score >= 90 ? 'CRITICAL' : score >= 75 ? 'HIGH' : 'MEDIUM';
        hits.push({ watchlistId: e.id, field: 'full_name', score, severity, entry: e });
      }
    }
  }
  return hits;
}

// ---------- Persist hits and return them ----------

async function recordHits(hits, { subjectType, subjectId, subjectName, subjectPhone }) {
  const recorded = [];
  for (const h of hits) {
    // Deduplicate: skip if same subject+watchlist+disposition PENDING already exists
    const existing = await pool.query(
      `SELECT id FROM sanctions_screening_hits WHERE watchlist_id = $1 AND subject_type = $2 AND subject_id = $3 AND disposition = 'PENDING' LIMIT 1`,
      [h.watchlistId, subjectType, subjectId || null]
    );
    if (existing.rows.length) { recorded.push(existing.rows[0]); continue; }
    const r = await pool.query(
      `INSERT INTO sanctions_screening_hits (watchlist_id, subject_type, subject_id, subject_name, subject_phone, matched_field, match_score, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [h.watchlistId, subjectType, subjectId || null, subjectName || null, subjectPhone || null, h.field, h.score, h.severity]
    );
    recorded.push(r.rows[0]);
  }
  return recorded;
}

// ---------- Guard: block if any CONFIRMED hit exists for subject ----------

async function assertNotSanctioned(type, id) {
  if (!id) return; // manual screens have no id
  const r = await pool.query(
    `SELECT id FROM sanctions_screening_hits WHERE subject_type = $1 AND subject_id = $2 AND disposition = 'CONFIRMED' LIMIT 1`,
    [type, id]
  );
  if (r.rows.length) throw createAppError('AML_SANCTIONS_MATCH');
}

// ---------- Admin disposition ----------

async function dispositionHit(hitId, actorId, disposition, comment) {
  if (!['CONFIRMED', 'FALSE_POSITIVE'].includes(disposition)) throw createAppError('SANCTIONS_SOURCE_REQUIRED');
  let caseId = null;
  if (disposition === 'CONFIRMED') {
    const gov = require('./governanceService');
    const hit = (await pool.query('SELECT * FROM sanctions_screening_hits WHERE id = $1', [hitId])).rows[0];
    if (!hit) throw createAppError('SANCTIONS_ENTRY_NOT_FOUND');
    const c = await gov.openAmlCase({
      userId: hit.subject_id || null,
      caseType: 'SANCTIONS_MATCH',
      riskLevel: hit.severity,
      summary: `Sanctions match confirmed: ${hit.subject_name} (score ${hit.match_score}, field ${hit.matched_field})`,
      authorId: actorId,
    });
    caseId = c.id;
    await pool.query('UPDATE sanctions_screening_hits SET case_id = $1 WHERE id = $2', [caseId, hitId]);
  }
  const r = await pool.query(
    `UPDATE sanctions_screening_hits SET disposition = $1, decided_by = $2, decided_at = NOW() WHERE id = $3 RETURNING *`,
    [disposition, actorId, hitId]
  );
  await logAudit(actorId, 'SANCTIONS_HIT_DECIDED', 'SANCTIONS_HIT', hitId, { disposition, caseId }, null).catch(() => {});
  return r.rows[0];
}

async function listHits({ disposition, subjectType, limit = 50, offset = 0 } = {}) {
  const conds = [];
  const p = [];
  if (disposition) { conds.push(`h.disposition = $${p.length + 1}`); p.push(disposition); }
  if (subjectType) { conds.push(`h.subject_type = $${p.length + 1}`); p.push(subjectType); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  limit = Number(limit); offset = Number(offset);
  p.push(Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50,
          Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0);
  const r = await pool.query(
    `SELECT h.*, w.source AS watchlist_source, w.full_name AS watchlist_name,
            d.full_name AS decided_by_name
     FROM sanctions_screening_hits h
     LEFT JOIN sanctions_watchlist w ON w.id = h.watchlist_id
     LEFT JOIN users d ON d.id = h.decided_by
     ${where}
     ORDER BY h.id DESC
     LIMIT $${p.length - 1} OFFSET $${p.length}`,
    p
  );
  return r.rows;
}

async function getStats() {
  const counts = (await pool.query(
    `SELECT disposition, COUNT(*)::int AS count FROM sanctions_screening_hits GROUP BY disposition`
  )).rows;
  const watchlist = (await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM sanctions_watchlist GROUP BY status`
  )).rows;
  return { hits: Object.fromEntries(counts.map(r => [r.disposition, r.count])), watchlist: Object.fromEntries(watchlist.map(r => [r.status, r.count])) };
}

module.exports = {
  normalizeName,
  normalizePhone,
  stripDiacritics,
  nameSimilarity,
  screenSubject,
  recordHits,
  assertNotSanctioned,
  addEntry,
  updateEntry,
  listEntries,
  getEntry,
  dispositionHit,
  listHits,
  getStats,
};
