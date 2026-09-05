/* ============================================================
 * Feature flags + experimentation framework.
 * Kill-switches, percentage rollout (deterministic bucketing),
 * role targeting, per-user overrides, and evaluation analytics.
 * Fail-closed: a missing flag is always OFF.
 * ============================================================ */
const crypto = require('crypto');
const pool = require('../config/db');

const FLAG_KEY_RE = /^[A-Z0-9_]{3,64}$/;

function hashRollout(flagKey, userId) {
  const h = crypto.createHash('sha256').update(`${flagKey}:${userId}`).digest();
  return h.readUInt32BE(0) % 100;
}

async function getFlagRow(flagKey) {
  const r = await pool.query('SELECT * FROM feature_flags WHERE flag_key = $1', [flagKey]);
  return r.rows[0] || null;
}

async function logEvaluation(flagKey, userId, decision, context = {}) {
  try {
    await pool.query(
      'INSERT INTO flag_evaluations (flag_key, user_id, decision, context) VALUES ($1, $2, $3, $4)',
      [flagKey, userId || null, decision, JSON.stringify(context)]
    );
  } catch (e) {
    // Analytics must never break the request path.
  }
}

async function isEnabled(flagKey, user = null, context = {}) {
  const flag = await getFlagRow(flagKey);
  if (!flag) {
    await logEvaluation(flagKey, user && user.id, 'MISSING', context);
    return false;
  }
  if (flag.expires_at && new Date(flag.expires_at) <= new Date()) {
    await logEvaluation(flagKey, user && user.id, 'EXPIRED', context);
    return false;
  }
  if (!flag.enabled) {
    await logEvaluation(flagKey, user && user.id, 'DISABLED', context);
    return false;
  }
  const userId = user && user.id;
  const role = user && user.role;
  // Per-user override beats everything else.
  const overrides = Array.isArray(flag.override_user_ids) ? flag.override_user_ids : [];
  if (userId && overrides.map(Number).includes(Number(userId))) {
    await logEvaluation(flagKey, userId, 'OVERRIDE_ON', context);
    return true;
  }
  // Role audience targeting.
  const audience = Array.isArray(flag.audience) ? flag.audience : [];
  if (audience.length > 0 && (!role || !audience.includes(role))) {
    await logEvaluation(flagKey, userId, 'ROLE_BLOCKED', context);
    return false;
  }
  // Gradual rollout (deterministic per user).
  if (flag.rollout_percent < 100) {
    if (!userId) {
      await logEvaluation(flagKey, null, 'NO_BUCKET', context);
      return false;
    }
    if (hashRollout(flagKey, userId) >= flag.rollout_percent) {
      await logEvaluation(flagKey, userId, 'ROLLOUT_OFF', context);
      return false;
    }
  }
  await logEvaluation(flagKey, userId, 'ON', context);
  return true;
}

function requireFeature(flagKey) {
  return async (req, res, next) => {
    try {
      const ok = await isEnabled(flagKey, req.user || null, { path: req.path });
      if (!ok) {
        return res.status(403).json({ error: 'FEATURE_DISABLED', message: 'Feature is not enabled for this user.' });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

async function listKeys() {
  const r = await pool.query('SELECT flag_key FROM feature_flags ORDER BY flag_key');
  return r.rows.map((row) => row.flag_key);
}

async function listFlags() {
  const r = await pool.query('SELECT * FROM feature_flags ORDER BY flag_key');
  return r.rows;
}

async function createFlag(data, actorId) {
  const key = String(data.flag_key || '').trim().toUpperCase();
  if (!FLAG_KEY_RE.test(key)) {
    throw Object.assign(new Error('flag_key must be 3-64 chars of A-Z, 0-9 or underscore.'), { status: 400 });
  }
  const rollout = Math.max(0, Math.min(100, Number(data.rollout_percent ?? 100)));
  const r = await pool.query(
    `INSERT INTO feature_flags (flag_key, label, description, enabled, rollout_percent, audience, override_user_ids, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (flag_key) DO UPDATE SET
       label = EXCLUDED.label, description = EXCLUDED.description, enabled = EXCLUDED.enabled,
       rollout_percent = EXCLUDED.rollout_percent, audience = EXCLUDED.audience,
       override_user_ids = EXCLUDED.override_user_ids, expires_at = EXCLUDED.expires_at, updated_at = NOW()
     RETURNING *`,
    [
      key,
      String(data.label || key),
      String(data.description || ''),
      Boolean(data.enabled),
      rollout,
      JSON.stringify(Array.isArray(data.audience) ? data.audience : []),
      Array.isArray(data.override_user_ids) ? data.override_user_ids.map(Number) : [],
      data.expires_at || null,
      actorId || null,
    ]
  );
  return r.rows[0];
}

async function updateFlag(flagKey, data) {
  const existing = await getFlagRow(flagKey);
  if (!existing) throw Object.assign(new Error('Flag not found.'), { status: 404 });
  const rollout = Math.max(0, Math.min(100, Number(data.rollout_percent ?? existing.rollout_percent)));
  const r = await pool.query(
    `UPDATE feature_flags SET
       label = $2, description = $3, enabled = $4, rollout_percent = $5,
       audience = $6, override_user_ids = $7, expires_at = $8, updated_at = NOW()
     WHERE flag_key = $1 RETURNING *`,
    [
      flagKey,
      String(data.label ?? existing.label),
      String(data.description ?? existing.description),
      Boolean(data.enabled ?? existing.enabled),
      rollout,
      JSON.stringify(Array.isArray(data.audience) ? data.audience : existing.audience),
      data.override_user_ids !== undefined ? data.override_user_ids.map(Number) : existing.override_user_ids,
      data.expires_at !== undefined ? data.expires_at : existing.expires_at,
    ]
  );
  return r.rows[0];
}

async function deleteFlag(flagKey) {
  const r = await pool.query('DELETE FROM feature_flags WHERE flag_key = $1 RETURNING *', [flagKey]);
  if (r.rowCount === 0) throw Object.assign(new Error('Flag not found.'), { status: 404 });
  return r.rows[0];
}

async function flagAnalytics(flagKey) {
  const r = await pool.query(
    `SELECT decision, COUNT(*)::int AS n
     FROM flag_evaluations
     WHERE flag_key = $1 AND created_at >= NOW() - INTERVAL '30 days'
     GROUP BY decision ORDER BY n DESC`,
    [flagKey]
  );
  const daily = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
     FROM flag_evaluations
     WHERE flag_key = $1 AND created_at >= NOW() - INTERVAL '14 days'
     GROUP BY day ORDER BY day`,
    [flagKey]
  );
  const total = r.rows.reduce((sum, row) => sum + row.n, 0);
  return { flagKey, windowDays: 30, total, decisions: r.rows, dailyTrend: daily.rows };
}

async function listEvaluations(flagKey, limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const r = await pool.query(
    `SELECT e.*, u.full_name, u.phone_number
     FROM flag_evaluations e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.flag_key = $1 ORDER BY e.created_at DESC LIMIT $2`,
    [flagKey, n]
  );
  return r.rows;
}

module.exports = {
  isEnabled,
  requireFeature,
  listKeys,
  listFlags,
  createFlag,
  updateFlag,
  deleteFlag,
  flagAnalytics,
  listEvaluations,
};