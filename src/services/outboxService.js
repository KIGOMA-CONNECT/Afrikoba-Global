const pool = require('../config/db');

/**
 * OUTBOX + EVENT BUS
 * Transaction-aware outbox: producers enqueue events inside the SAME DB
 * transaction that performs the write (atomicity). A dispatcher claims due
 * PENDING rows (FOR UPDATE SKIP LOCKED) and fans them out to registered
 * handlers with exponential backoff; rows exceeding max_attempts go DEAD.
 * reference_id UNIQUE gives exactly-once de-duplication.
 */

const handlers = new Map();
const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

function registerHandler(eventType, handler) {
  if (typeof handler !== 'function') throw new Error('Handler lazima iwe function.');
  handlers.set(eventType, handler);
}

async function enqueueOutbox({ eventType, aggregateId = null, payload = {}, reference, tx, maxAttempts }) {
  if (!eventType || !reference) throw new Error('eventType na reference zinahitajika.');
  const q = {
    text: `INSERT INTO outbox_events (event_type, aggregate_id, payload, reference_id, max_attempts)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (reference_id) DO NOTHING
           RETURNING id, status`,
    values: [eventType, aggregateId, JSON.stringify(payload || {}), reference, maxAttempts || DEFAULT_MAX_ATTEMPTS],
  };
  const res = tx ? await tx.query(q) : await pool.query(q);
  const row = res.rows[0];
  return { id: row ? row.id : null, queued: !!row, eventType, reference };
}

function backoffDelayMs(attempts) {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempts - 1), BACKOFF_CAP_MS);
}

async function getOutboxStats() {
  const res = await pool.query(
    `SELECT status, COUNT(*)::int AS total FROM outbox_events GROUP BY status`
  );
  const counts = { PENDING: 0, DELIVERED: 0, FAILED: 0, DEAD: 0 };
  for (const r of res.rows) counts[r.status] = r.total;
  const oldest = await pool.query(
    `SELECT COALESCE(MIN(created_at) FILTER (WHERE status = 'PENDING'), NULL)::text AS oldest_pending
     FROM outbox_events`
  );
  return { counts, oldestPending: oldest.rows[0].oldest_pending };
}

async function listPending(limit = 50, status = 'PENDING') {
  const res = await pool.query(
    `SELECT id, event_type, aggregate_id, reference_id, status, attempts, max_attempts,
            next_attempt_at, last_error, created_at
     FROM outbox_events WHERE status = $1 ORDER BY id DESC LIMIT $2`,
    [status, limit]
  );
  return res.rows;
}

async function dispatchOutbox({ batchSize = 20, now = new Date() } = {}) {
  const client = await pool.connect();
  const summary = { claimed: 0, delivered: 0, failed: 0, dead: 0, unregistered: 0, processed: 0 };
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `SELECT id, event_type, aggregate_id, payload, attempts, max_attempts
       FROM outbox_events
       WHERE status = 'PENDING' AND next_attempt_at <= $1
       ORDER BY attempts, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, batchSize]
    );
    summary.claimed = claim.rows.length;

    for (const row of claim.rows) {
      const handler = handlers.get(row.event_type);
      summary.processed += 1;
      if (!handler) {
        summary.unregistered += 1;
        // No consumer yet: escalate as FAILED (batch hooks may register later).
        await client.query(
          `UPDATE outbox_events SET status = 'FAILED', last_error = $1, updated_at = NOW() WHERE id = $2`,
          [`No handler registered for ${row.event_type}`, row.id]
        );
        continue;
      }
      const attempt = row.attempts + 1;
      try {
        await handler({ eventType: row.event_type, aggregateId: row.aggregate_id, payload: row.payload });
        await client.query(
          `UPDATE outbox_events SET status = 'DELIVERED', attempts = $1, delivered_at = NOW(), last_error = NULL, updated_at = NOW()
           WHERE id = $2`,
          [attempt, row.id]
        );
        summary.delivered += 1;
      } catch (err) {
        const exceeded = attempt >= row.max_attempts;
        const next = new Date(now.getTime() + backoffDelayMs(attempt));
        await client.query(
          `UPDATE outbox_events
           SET attempts = $1, status = $2, next_attempt_at = $3, last_error = $4, updated_at = NOW()
           WHERE id = $5`,
          [attempt, exceeded ? 'DEAD' : 'PENDING', next, String(err.message || err), row.id]
        );
        if (exceeded) summary.dead += 1;
        else summary.failed += 1;
      }
    }
    await client.query('COMMIT');
    return summary;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function requeueDead(batchSize = 100) {
  const res = await pool.query(
    `UPDATE outbox_events
     SET status = 'PENDING', attempts = 0, next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
     WHERE id IN (SELECT id FROM outbox_events WHERE status = 'DEAD' ORDER BY id LIMIT $1)
     RETURNING id`,
    [batchSize]
  );
  return { requeued: res.rows.length };
}

module.exports = {
  registerHandler,
  enqueueOutbox,
  dispatchOutbox,
  getOutboxStats,
  listPending,
  requeueDead,
  _backoffDelayMs: backoffDelayMs,
};