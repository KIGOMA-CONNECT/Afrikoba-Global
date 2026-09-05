/* ============================================================
 * A/B experimentation engine layered on feature flags.
 * Deterministic weighted variant assignment per user, event
 * tracking, and experiment reports with uplift + z-score.
 * ============================================================ */
const crypto = require('crypto');
const pool = require('../config/db');
const ff = require('./featureFlagService');

const KEY_RE = /^[A-Z0-9_-]{3,64}$/;
const STATUSES = ['DRAFT', 'RUNNING', 'PAUSED', 'STOPPED', 'ARCHIVED'];

function shaToU32(key, userId) {
  const h = crypto.createHash('sha256').update(`${key}:${userId}`).digest();
  return h.readUInt32BE(0);
}

function pickVariant(experimentKey, userId, variants) {
  const total = variants.reduce((s, v) => s + Math.max(0, Number(v.weight) || 0), 0);
  const pos = shaToU32(experimentKey, userId) % Math.max(1, total);
  let acc = 0;
  for (const v of variants) {
    acc += Math.max(0, Number(v.weight) || 0);
    if (pos < acc) return v;
  }
  return variants[variants.length - 1];
}

function parseVariants(raw) {
  const variants = Array.isArray(raw) ? raw : [];
  if (variants.length < 1) throw Object.assign(new Error('Variants angalau moja inahitajika.'), { status: 400 });
  const keys = variants.map((v) => String(v.key || ''));
  if (keys.some((k) => !k)) throw Object.assign(new Error('Kila variant inahitaji key.'), { status: 400 });
  if (new Set(keys).size !== keys.length) throw Object.assign(new Error('Variant keys nafasi zimejirudia.'), { status: 400 });
  return variants.map((v) => ({ key: String(v.key), weight: Math.max(0, Number(v.weight) ?? 1) }));
}

async function findExperiment(keyOrId) {
  const isId = /^\d+$/.test(String(keyOrId));
  const r = await pool.query(
    `SELECT * FROM experiments WHERE ${isId ? 'id = $1' : 'key = $1'}`,
    [keyOrId]
  );
  if (r.rows.length === 0) throw Object.assign(new Error('Experiment haijapatikana.'), { status: 404 });
  return r.rows[0];
}

async function createExperiment(data, actorId) {
  const key = String(data.key || '').trim().toUpperCase();
  if (!KEY_RE.test(key)) throw Object.assign(new Error('key lazima iwe herufi 3-64 za A-Z, 0-9, underscore au dash.'), { status: 400 });
  const flagKey = String(data.flag_key || '').trim().toUpperCase();
  if (!flagKey) throw Object.assign(new Error('flag_key inahitajika.'), { status: 400 });
  try { await findExperiment(key); throw Object.assign(new Error('Experiment key tayari ipo.'), { status: 409 }); } catch (e) { if (e.status === 409) throw e; }
  const variants = parseVariants(data.variants);
  const r = await pool.query(
    `INSERT INTO experiments (key, flag_key, name, description, start_at, end_at, variants, audience, metrics, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      key,
      flagKey,
      String(data.name || key),
      String(data.description || ''),
      data.start_at || null,
      data.end_at || null,
      JSON.stringify(variants),
      JSON.stringify(data.audience || {}),
      JSON.stringify(data.metrics || { primary: null, secondary: [] }),
      actorId || null,
    ]
  );
  return r.rows[0];
}

async function updateExperiment(keyOrId, data, actorId) {
  const exp = await findExperiment(keyOrId);
  const running = exp.status === 'RUNNING';
  const variants = data.variants !== undefined ? parseVariants(data.variants) : exp.variants;
  if (running && data.variants !== undefined) {
    throw Object.assign(new Error('Variants haziwezi kubadilishwa wakati experiment inaendesha.'), { status: 409 });
  }
  const r = await pool.query(
    `UPDATE experiments SET
       name = $2, description = $3, start_at = $4, end_at = $5,
       variants = $6, audience = $7, metrics = $8, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      exp.id,
      String(data.name ?? exp.name),
      String(data.description ?? exp.description),
      data.start_at !== undefined ? data.start_at : exp.start_at,
      data.end_at !== undefined ? data.end_at : exp.end_at,
      JSON.stringify(variants),
      JSON.stringify(data.audience ?? exp.audience),
      JSON.stringify(data.metrics ?? exp.metrics),
    ]
  );
  return r.rows[0];
}

async function transition(keyOrId, to, actorId) {
  if (!STATUSES.includes(to)) throw Object.assign(new Error('Hali si sahihi.'), { status: 400 });
  const exp = await findExperiment(keyOrId);
  if (to === 'RUNNING') {
    if (exp.status === 'STOPPED' || exp.status === 'ARCHIVED') throw Object.assign(new Error('Experiment imefungwa.'), { status: 409 });
    const flagOk = await ff.isEnabled(exp.flag_key, { id: actorId }, { source: 'experiment_start' });
    if (!flagOk) throw Object.assign(new Error(`Feature flag "${exp.flag_key}" imezimwa — washa flag kwanza.`), { status: 403 });
    if (exp.end_at && new Date(exp.end_at) <= new Date()) throw Object.assign(new Error('end_at imepitwa.'), { status: 400 });
    const start = exp.start_at || new Date().toISOString();
  }
  const r = await pool.query(
    `UPDATE experiments SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [exp.id, to]
  );
  return r.rows[0];
}

async function listExperiments(status = null, limit = 100) {
  let query = 'SELECT * FROM experiments';
  const params = [];
  if (status) { query += ` WHERE status = $1`; params.push(status); }
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const r = await pool.query(query, params);
  return r.rows;
}

function audienceAllows(audience, user) {
  if (!audience || typeof audience !== 'object') return true;
  const roles = Array.isArray(audience.roles) ? audience.roles : [];
  if (roles.length > 0 && (!user.role || !roles.includes(user.role))) return false;
  const userIds = Array.isArray(audience.user_ids) ? audience.user_ids.map(Number) : [];
  if (userIds.length > 0 && !userIds.includes(Number(user.id))) return false;
  return true;
}

async function assignVariant(userId, keyOrId) {
  const exp = await findExperiment(keyOrId);
  if (exp.status !== 'RUNNING') throw Object.assign(new Error('Experiment haionesha.'), { status: 409 });
  const urow = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  const user = { id: userId, role: urow.rows.length ? urow.rows[0].role : null };
  const flagOk = await ff.isEnabled(exp.flag_key, user, { source: 'experiment_assign' });
  if (!flagOk) throw Object.assign(new Error(`Feature flag "${exp.flag_key}" imezimwa.`), { status: 403 });
  if (!audienceAllows(exp.audience, user)) throw Object.assign(new Error('Audience hukuruhusu.'), { status: 403 });
  const existing = await pool.query(
    'SELECT variant FROM experiment_assignments WHERE experiment_id = $1 AND user_id = $2',
    [exp.id, userId]
  );
  let variant;
  let firstAssigned = false;
  if (existing.rows.length > 0) {
    variant = existing.rows[0].variant;
  } else {
    const chosen = pickVariant(exp.key, userId, exp.variants);
    variant = chosen.key;
    await pool.query(
      `INSERT INTO experiment_assignments (experiment_id, user_id, variant) VALUES ($1,$2,$3)
       ON CONFLICT (experiment_id, user_id) DO NOTHING`,
      [exp.id, userId, variant]
    );
    firstAssigned = true;
  }
  return { experimentKey: exp.key, variant, firstAssigned };
}

async function trackEvent({ userId, keyOrId, eventName, value = 0, sessionId = null }) {
  if (!eventName) throw Object.assign(new Error('eventName inahitajika.'), { status: 400 });
  const exp = await findExperiment(keyOrId);
  if (exp.status !== 'RUNNING') return { recorded: false, reason: 'not_running' };
  const assignment = await pool.query(
    'SELECT variant FROM experiment_assignments WHERE experiment_id = $1 AND user_id = $2',
    [exp.id, userId]
  );
  if (assignment.rows.length === 0) return { recorded: false, reason: 'not_assigned' };
  const variant = assignment.rows[0].variant;
  await pool.query(
    `INSERT INTO experiment_events (experiment_id, user_id, variant, event_name, value, session_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [exp.id, userId, variant, eventName, Number(value) || 0, sessionId || null]
  );
  return { recorded: true, variant };
}

function zTwoProportion(p1, n1, p2, n2) {
  if (!n1 || !n2) return 0;
  const p = (p1 * n1 + p2 * n2) / (n1 + n2);
  if (p === 0 || p === 1) return 0;
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 0;
  return (p1 - p2) / se;
}

async function experimentReport(keyOrId) {
  const exp = await findExperiment(keyOrId);
  const variants = exp.variants;
  const primary = (exp.metrics && exp.metrics.primary) || null;
  const secondary = (exp.metrics && exp.metrics.secondary) || [];

  const vKeys = variants.map((v) => v.key);
  const perVariant = {};
  const controlKey = vKeys.includes('control') ? 'control' : vKeys[0];
  const primaryBuckets = primary ? {} : null;
  const dailyTrend = primary ? {} : null;

  for (const key of vKeys) {
    perVariant[key] = { key, assigned: 0, events: 0, eventNames: {}, primaryCount: 0, primarySum: 0 };
    if (primary) primaryBuckets[key] = 0;
  }

  const assigned = await pool.query(`SELECT variant, COUNT(*)::int AS n FROM experiment_assignments WHERE experiment_id = $1 GROUP BY variant`, [exp.id]);
  for (const row of assigned.rows) {
    if (perVariant[row.variant]) perVariant[row.variant].assigned = row.n;
  }

  const events = await pool.query(`SELECT variant, event_name, COALESCE(SUM(value),0)::numeric AS total, COUNT(*)::int AS n FROM experiment_events WHERE experiment_id = $1 GROUP BY variant, event_name`, [exp.id]);
  let totalEvents = 0;
  for (const row of events.rows) {
    const pv = perVariant[row.variant];
    if (!pv) continue;
    totalEvents += row.n;
    pv.events += row.n;
    pv.eventNames[row.event_name] = { count: row.n, sum: Number(row.total) };
    if (primary && row.event_name === primary) {
      pv.primaryCount = row.n;
      pv.primarySum = Number(row.total);
      if (primaryBuckets) primaryBuckets[row.variant] = row.n;
    }
  }

  if (primary) {
    const controlRate = perVariant[controlKey].assigned ? perVariant[controlKey].primaryCount / perVariant[controlKey].assigned : 0;
    const trend = await pool.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, variant, event_name, COUNT(*)::int AS n
       FROM experiment_events WHERE experiment_id = $1 AND event_name = $2
       GROUP BY day, variant, event_name ORDER BY day`,
      [exp.id, primary]
    );
    for (const row of trend.rows) {
      if (!dailyTrend[`${row.variant}|${row.day}`]) dailyTrend[`${row.variant}|${row.day}`] = 0;
      dailyTrend[`${row.variant}|${row.day}`] += row.n;
    }
    for (const key of vKeys) {
      const pv = perVariant[key];
      const rate = pv.assigned ? pv.primaryCount / pv.assigned : 0;
      const z = zTwoProportion(rate, pv.assigned, controlRate, perVariant[controlKey].assigned);
      let verdict = 'NEUTRAL';
      if (key !== controlKey && perVariant[controlKey].assigned && pv.assigned && Math.abs(z) > 1.96) {
        verdict = rate > controlRate ? 'WIN' : 'LOSS';
      }
      pv.rate = Number(rate.toFixed(4));
      pv.uplift = controlRate > 0 && key !== controlKey ? Number(((rate - controlRate) / controlRate) * 100).toFixed(2) : 0;
      pv.zScore = Number(z.toFixed(3));
      pv.verdict = key === controlKey ? 'CONTROL' : verdict;
    }
  }

  const trendList = dailyTrend
    ? Object.entries(dailyTrend).map(([k, n]) => {
        const [variant, day] = k.split('|');
        return { variant, day, n };
      })
    : [];

  return {
    experiment: exp,
    variants: vKeys.map((k) => ({ ...perVariant[k], eventNames: undefined })),
    detailByVariant: perVariant,
    controlKey,
    primaryMetric: primary,
    secondaryMetrics: secondary,
    totalEvents,
    dailyTrend: trendList,
  };
}

async function listAssignments(keyOrId, limit = 100) {
  const exp = await findExperiment(keyOrId);
  const r = await pool.query(
    `SELECT a.variant, a.user_id, a.allocated_at, u.full_name, u.phone_number
     FROM experiment_assignments a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.experiment_id = $1 ORDER BY a.allocated_at DESC LIMIT $2`,
    [exp.id, Math.max(1, Math.min(500, Number(limit) || 100))]
  );
  return r.rows;
}

async function listEvents(keyOrId, eventName = null, limit = 100) {
  const exp = await findExperiment(keyOrId);
  let query = `SELECT e.*, u.full_name FROM experiment_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.experiment_id = $1`;
  const params = [exp.id];
  if (eventName) { params.push(eventName); query += ` AND e.event_name = $${params.length}`; }
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  query += ` ORDER BY e.created_at DESC LIMIT $${params.length}`;
  const r = await pool.query(query, params);
  return r.rows;
}

module.exports = {
  createExperiment,
  updateExperiment,
  transition,
  listExperiments,
  findExperiment,
  assignVariant,
  trackEvent,
  experimentReport,
  listAssignments,
  listEvents,
};