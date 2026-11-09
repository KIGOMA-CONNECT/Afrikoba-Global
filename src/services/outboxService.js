const pool = require('../config/db');
const crypto = require('crypto');

const handlers = new Map();
const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const LEASE_MS = 120000;
const HEARTBEAT_MS = 30000;

function registerHandler(eventType, handler) {
  if (typeof handler !== 'function') throw new Error('Handler lazima iwe function.');
  handlers.set(eventType, handler);
}

async function enqueueOutbox({ eventType, aggregateId = null, payload = {}, reference, tx, maxAttempts }) {
  if (!eventType || !reference) throw new Error('eventType na reference zinahitajika.');
  const serialized = JSON.stringify(payload || {});
  const q = {
    text: `INSERT INTO outbox_events
             (event_type, aggregate_id, payload, reference_id, max_attempts)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (reference_id) DO NOTHING
           RETURNING id, status`,
    values: [eventType, aggregateId, serialized, reference, maxAttempts || DEFAULT_MAX_ATTEMPTS],
  };
  const db = tx || pool;
  const inserted = await db.query(q);
  if (inserted.rows[0]) {
    return { id: inserted.rows[0].id, queued: true, eventType, reference };
  }

  const conflict = await db.query(
    `SELECT id, event_type, payload
       FROM outbox_events
      WHERE reference_id = $1
        AND (event_type <> $2 OR payload IS DISTINCT FROM $3::jsonb)`,
    [reference, eventType, serialized]
  );
  if (conflict.rows.length) {
    throw new Error(`Outbox reference payload conflict: ${reference}`);
  }

  const existing = await db.query(
    `SELECT id FROM outbox_events WHERE reference_id = $1`,
    [reference]
  );
  if (!existing.rows.length) {
    throw new Error(`Outbox reference conflict could not be resolved: ${reference}`);
  }
  return { id: existing.rows[0].id, queued: false, eventType, reference };
}

function backoffDelayMs(attempts) {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempts - 1), BACKOFF_CAP_MS);
}

async function getOutboxStats() {
  const res = await pool.query(
    `SELECT status, COUNT(*)::int AS total FROM outbox_events GROUP BY status`
  );
  const counts = { PENDING: 0, PROCESSING: 0, DELIVERED: 0, FAILED: 0, DEAD: 0 };
  for (const row of res.rows) counts[row.status] = row.total;
  const oldest = await pool.query(
    `SELECT MIN(created_at)::text AS oldest_pending
       FROM outbox_events WHERE status = 'PENDING'`
  );
  return { counts, oldestPending: oldest.rows[0].oldest_pending };
}

async function listPending(limit = 50, status = 'PENDING') {
  const res = await pool.query(
    `SELECT id, event_type, aggregate_id, reference_id, status, attempts,
            max_attempts, next_attempt_at, locked_until, last_error, created_at
       FROM outbox_events
      WHERE status = $1
      ORDER BY id DESC LIMIT $2`,
    [status, limit]
  );
  return res.rows;
}

async function claimBatch(batchSize, now) {
  const client = await pool.connect();
  const claimed = [];
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE outbox_events
          SET status = 'DEAD',
              lease_token = NULL,
              locked_until = NULL,
              last_error = COALESCE(last_error, 'Processing lease expired after maximum attempts'),
              updated_at = NOW()
        WHERE status = 'PROCESSING'
          AND locked_until <= $1
          AND attempts >= max_attempts`,
      [now]
    );

    const candidates = await client.query(
      `SELECT id, event_type, aggregate_id, payload, reference_id, attempts, max_attempts
         FROM outbox_events
        WHERE (
          (status = 'PENDING' AND next_attempt_at <= $1)
          OR (status = 'PROCESSING' AND locked_until <= $1 AND attempts < max_attempts)
        )
        ORDER BY attempts, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, batchSize]
    );

    for (const row of candidates.rows) {
      const token = crypto.randomUUID();
      const result = await client.query(
        `UPDATE outbox_events
            SET status = 'PROCESSING',
                attempts = attempts + 1,
                lease_token = $1,
                locked_until = $2,
                updated_at = NOW()
          WHERE id = $3
          RETURNING id, event_type, aggregate_id, payload, reference_id, attempts, max_attempts`,
        [token, new Date(now.getTime() + LEASE_MS), row.id]
      );
      if (result.rows[0]) {
        claimed.push({ ...result.rows[0], lease_token: token });
      }
    }

    await client.query('COMMIT');
    return claimed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function updateOwnedEvent(row, sql, values) {
  const result = await pool.query(sql, values);
  return result.rowCount === 1;
}

async function dispatchOutbox({ batchSize = 20, now = new Date() } = {}) {
  const summary = {
    claimed: 0, delivered: 0, failed: 0, dead: 0,
    unregistered: 0, processed: 0, lostLease: 0,
    acknowledgementFailed: 0,
  };

  const rows = await claimBatch(batchSize, now);
  summary.claimed = rows.length;

  for (const row of rows) {
    summary.processed += 1;
    const token = row.lease_token;
    const handler = handlers.get(row.event_type);

    if (!handler) {
      const updated = await updateOwnedEvent(
        row,
        "UPDATE outbox_events SET status = 'FAILED', lease_token = NULL, locked_until = NULL, last_error = $1, updated_at = NOW() WHERE id = $2 AND status = 'PROCESSING' AND lease_token = $3",
        ["No handler registered for " + row.event_type, row.id, token]
      );
      if (updated) summary.unregistered += 1;
      else summary.lostLease += 1;
      continue;
    }

    let leaseLost = false;
    let heartbeatBusy = false;
    let heartbeatError = null;

    const heartbeat = setInterval(async () => {
      if (heartbeatBusy || leaseLost) return;
      heartbeatBusy = true;
      try {
        const renewed = await pool.query(
          "UPDATE outbox_events SET locked_until = NOW() + ($1 * INTERVAL '1 millisecond'), updated_at = NOW() WHERE id = $2 AND status = 'PROCESSING' AND lease_token = $3",
          [LEASE_MS, row.id, token]
        );
        if (renewed.rowCount !== 1) leaseLost = true;
      } catch (error) {
        // A transient heartbeat error does not prove that ownership was lost.
        // The final conditional database update is the authoritative check.
        heartbeatError = String(error && (error.message || error));
      } finally {
        heartbeatBusy = false;
      }
    }, HEARTBEAT_MS);

    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    let handlerFailed = false;
    let handlerError;
    try {
      await handler({
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
      });
    } catch (error) {
      handlerFailed = true;
      handlerError = error;
    } finally {
      clearInterval(heartbeat);
    }

    // Only handler failures enter the retry/dead-letter policy.
    if (handlerFailed) {
      if (leaseLost) {
        summary.lostLease += 1;
        continue;
      }

      const exceeded = row.attempts >= row.max_attempts;
      const next = new Date(Date.now() + backoffDelayMs(row.attempts));
      const updated = await updateOwnedEvent(
        row,
        "UPDATE outbox_events SET status = $1, next_attempt_at = $2, lease_token = NULL, locked_until = NULL, last_error = $3, updated_at = NOW() WHERE id = $4 AND status = 'PROCESSING' AND lease_token = $5",
        [
          exceeded ? 'DEAD' : 'PENDING',
          next,
          String(handlerError && (handlerError.message || handlerError)),
          row.id,
          token,
        ]
      );

      if (!updated) {
        summary.lostLease += 1;
      } else if (exceeded) {
        summary.dead += 1;
      } else {
        summary.failed += 1;
      }
      continue;
    }

    // Handler succeeded. An acknowledgement database error is not a
    // handler failure and must not trigger an immediate retry.
    try {
      const updated = await updateOwnedEvent(
        row,
        "UPDATE outbox_events SET status = 'DELIVERED', delivered_at = NOW(), lease_token = NULL, locked_until = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1 AND status = 'PROCESSING' AND lease_token = $2",
        [row.id, token]
      );

      if (updated) {
        summary.delivered += 1;
      } else {
        summary.lostLease += 1;
      }
    } catch (ackError) {
      summary.acknowledgementFailed += 1;

      const ackMessage = String(ackError && (ackError.message || ackError));
      console.error(
        'OUTBOX_ACKNOWLEDGEMENT_FAILED: handler completed but delivery acknowledgement failed',
        {
          eventId: row.id,
          eventType: row.event_type,
          referenceId: row.reference_id,
          error: ackMessage,
          heartbeatError,
        }
      );

      // Best-effort read only. Never requeue after an uncertain acknowledgement.
      try {
        const verification = await pool.query(
          "SELECT status, lease_token FROM outbox_events WHERE id = $1",
          [row.id]
        );
        const current = verification.rows[0];

        if (current && current.status === 'DELIVERED') {
          summary.delivered += 1;
        } else if (
          current &&
          current.status === 'PROCESSING' &&
          String(current.lease_token) === String(token)
        ) {
          // Keep the current lease. Expiry recovery can retry later.
          // Provider-side idempotency/reconciliation remains necessary.
        } else {
          summary.lostLease += 1;
        }
      } catch (verificationError) {
        console.error(
          'OUTBOX_ACKNOWLEDGEMENT_STATE_UNVERIFIED: processing lease left unchanged',
          {
            eventId: row.id,
            eventType: row.event_type,
            error: String(verificationError && (verificationError.message || verificationError)),
          }
        );
      }
    }
  }

  return summary;
}
async function requeueDead(batchSize = 100) {
  const res = await pool.query(
    `UPDATE outbox_events
        SET status = 'PENDING', attempts = 0, next_attempt_at = NOW(),
            lease_token = NULL, locked_until = NULL,
            last_error = NULL, updated_at = NOW()
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE status = 'DEAD' ORDER BY id LIMIT $1
      )
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
