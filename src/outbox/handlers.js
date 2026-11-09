'use strict';

/**
 * Outbox handler registry (Phase 71 / Step A).
 *
 * All outbox handlers are registered here via registerAll(outbox), so the
 * contract test can load the exact production handler set without starting
 * the HTTP server.
 *
 * The four close-out handlers (PROJECT_COMPLETED, PROJECT_LIQUIDATED,
 * PROJECT_RESERVE_RELEASED, PROJECT_RESIDUAL_RELEASED) are VERIFY-ONLY:
 * projectFinanceService already notifies owner and investors directly after
 * COMMIT, so these handlers only confirm (SELECT only) that the financial
 * record identified by the event's reference exists, and throw otherwise.
 * Their notifications move into handlers in Phase 72 (after Steps B and D).
 */

const defaultPool = require('../config/db');
const {
  createNotification: defaultCreateNotification,
  SOURCE_EVENT_REFERENCE_MAX,
} = require('../services/notificationService');

// Event type -> project_reserve_releases.reserve_type
// (mirrors CLOSE_OUT_FUNDS in src/services/projectFinanceService.js).
const RELEASE_RESERVE_TYPES = {
  PROJECT_RESERVE_RELEASED: 'DISTRIBUTION_RESERVE',
  PROJECT_RESIDUAL_RELEASED: 'OWNER_RESIDUAL',
};

function requireReference(eventType, payload) {
  const reference = payload && typeof payload.reference === 'string' ? payload.reference.trim() : '';
  const projectId = payload ? Number(payload.projectId) : NaN;
  if (!reference) throw new Error(`${eventType}: payload.reference is required`);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error(`${eventType}: payload.projectId must be a positive integer`);
  }
  return { reference, projectId };
}

// Phase 71 / Step B: idempotency key for notifications created by a handler.
// One notification per (outbox event, user); a redelivery returns the existing one.
function sourceEventReference(eventType, referenceId, userId) {
  const ref = typeof referenceId === 'string' ? referenceId.trim() : '';
  if (!ref) throw new Error(`${eventType}: referenceId is required for an idempotent notification`);
  const value = `${ref}:u${userId}`;
  const length = Array.from(value).length;
  if (length > SOURCE_EVENT_REFERENCE_MAX) {
    throw new Error(
      `${eventType}: sourceEventReference exceeds ${SOURCE_EVENT_REFERENCE_MAX} characters (got ${length})`
    );
  }
  return value;
}

function registerAll(outbox, deps = {}) {
  const pool = deps.pool || defaultPool;
  const createNotification = deps.createNotification || defaultCreateNotification;
  let outboxRetryCount = 0;

  // ---- Handlers moved from src/server.js (Step A); notifying handlers ----
  // ---- pass sourceEventReference since Step B ---------------------------

  outbox.registerHandler('MERCHANT_PAYOUT_EXECUTED', async ({ payload, referenceId }) => {
    const m = (await pool.query('SELECT user_id FROM merchants WHERE id = $1', [payload.merchantId])).rows[0];
    const userId = m ? m.user_id : payload.userId;
    const n1 = await createNotification(userId, {
      title: 'Malipo ya mfanyabiashara yametumwa',
      body: payload.reference ? `Rejea: ${payload.reference}` : 'Malipo yametumwa.',
      type: 'FRAUD_TRANSACTION',
      sourceEventReference: sourceEventReference('MERCHANT_PAYOUT_EXECUTED', referenceId, userId),
    });
    if (n1 === null) throw new Error('Notification persistence failed for MERCHANT_PAYOUT_EXECUTED');
  });

  outbox.registerHandler('VICOBA_LOAN_APPROVED', async ({ payload, referenceId }) => {
    const n2 = await createNotification(payload.applicantUserId, {
      title: 'Mkopo wa VICOBA umetolewa',
      body: `Mkopo wa TZS ${payload.amount} umewekwa kwenye wallet yako.`,
      type: 'TRANSACTION',
      sourceEventReference: sourceEventReference('VICOBA_LOAN_APPROVED', referenceId, payload.applicantUserId),
    });
    if (n2 === null) throw new Error('Notification persistence failed for VICOBA_LOAN_APPROVED');
  });

  outbox.registerHandler('OUTBOX_TEST', async ({ payload, referenceId }) => {
    const n3 = await createNotification(payload.userId, {
      title: 'Outbox heartbeat',
      body: 'delivered',
      sourceEventReference: sourceEventReference('OUTBOX_TEST', referenceId, payload.userId),
    });
    if (n3 === null) throw new Error('Notification persistence failed for OUTBOX_TEST');
  });

  outbox.registerHandler('OUTBOX_RETRY', async () => {
    outboxRetryCount += 1;
    if (outboxRetryCount % 3 !== 0) throw new Error('sigui bado');
  });

  outbox.registerHandler('PROJECT_REVENUE_PROCESSED', async ({ payload, referenceId }) => {
    const { projectId, amount, reference, allocations = [] } = payload;
    const p = await pool.query('SELECT id, owner_user_id, name FROM projects WHERE id = $1', [projectId]);
    if (p.rows.length === 0) return;
    const summary = allocations.map((a) => `${a.step}: ${a.amount}`).join(', ');
    const n4 = await createNotification(p.rows[0].owner_user_id, {
      title: 'Mapato na mgawanyo kwenye waterfall',
      body: `Mradi "${p.rows[0].name}": TZS ${amount} yamegawanywa (${summary}).`,
      type: 'PROJECT',
      entityType: 'PROJECT',
      entityId: projectId,
      sourceEventReference: sourceEventReference('PROJECT_REVENUE_PROCESSED', referenceId, p.rows[0].owner_user_id),
    });
    if (n4 === null) throw new Error('Notification persistence failed for PROJECT_REVENUE_PROCESSED');
  });

  outbox.registerHandler('PROJECT_DIVIDEND_PAID', async ({ payload, referenceId }) => {
    const { projectId, name, reference, paid = [] } = payload;
    const p = await pool.query('SELECT owner_user_id FROM projects WHERE id = $1', [projectId]);
    if (p.rows.length === 0) return;
    const total = paid.reduce((s, x) => s + Number(x.amount || 0), 0);
    const n5 = await createNotification(p.rows[0].owner_user_id, {
      title: 'Mgawanyo wa faida umetolewa',
      body: `Wawekezaji ${paid.length} wa mradi "${name}" wamelipwa jumla ya TZS ${total}. Rejea: ${reference}`,
      type: 'PROJECT',
      entityType: 'PROJECT',
      entityId: projectId,
      sourceEventReference: sourceEventReference('PROJECT_DIVIDEND_PAID', referenceId, p.rows[0].owner_user_id),
    });
    if (n5 === null) throw new Error('Notification persistence failed for PROJECT_DIVIDEND_PAID');
  });

  outbox.registerHandler('PROJECT_SPLIT_SMS', async ({ payload }) => {
    const { sendSMS } = require('../services/smsService');
    const phone = String(payload && payload.phone || '').trim();
    const body = String(payload && payload.body || '').trim();
    if (!phone || !body) {
      throw new Error('PROJECT_SPLIT_SMS: phone and body are required');
    }
    const result = await sendSMS(phone, body);
    if (!result || result.success !== true) {
      throw new Error(
        `PROJECT_SPLIT_SMS provider failure: ${
          result && result.error || 'Provider returned success=false'
        }`
      );
    }
    return {
      success: true,
      simulated: result.simulated === true,
      provider: result.provider || null,
    };
  });

  // ---- Phase 71 / Step A: verify-only close-out handlers (SELECT only) ---

  // project_settlements has no reference column; completeProject stores
  // settleRef in summary->>'reference' (migration 134).
  outbox.registerHandler('PROJECT_COMPLETED', async ({ payload }) => {
    const { reference, projectId } = requireReference('PROJECT_COMPLETED', payload);
    const r = await pool.query(
      `SELECT id FROM project_settlements
        WHERE project_id = $1 AND summary->>'reference' = $2`,
      [projectId, reference]
    );
    if (r.rows.length !== 1) {
      throw new Error(`PROJECT_COMPLETED: no project_settlements row for project ${projectId} reference ${reference}`);
    }
    return { verified: true, settlementId: r.rows[0].id };
  });

  outbox.registerHandler('PROJECT_LIQUIDATED', async ({ payload }) => {
    const { reference, projectId } = requireReference('PROJECT_LIQUIDATED', payload);
    const r = await pool.query(
      `SELECT id FROM project_liquidations
        WHERE project_id = $1 AND reference = $2 AND status = 'LIQUIDATED'`,
      [projectId, reference]
    );
    if (r.rows.length !== 1) {
      throw new Error(`PROJECT_LIQUIDATED: no project_liquidations row for project ${projectId} reference ${reference}`);
    }
    return { verified: true, liquidationId: r.rows[0].id };
  });

  for (const [eventType, reserveType] of Object.entries(RELEASE_RESERVE_TYPES)) {
    outbox.registerHandler(eventType, async ({ payload }) => {
      const { reference, projectId } = requireReference(eventType, payload);
      const r = await pool.query(
        `SELECT id FROM project_reserve_releases
          WHERE project_id = $1 AND reference = $2
            AND reserve_type = $3 AND status = 'RELEASED'`,
        [projectId, reference, reserveType]
      );
      if (r.rows.length !== 1) {
        throw new Error(
          `${eventType}: no project_reserve_releases row (${reserveType}) for project ${projectId} reference ${reference}`
        );
      }
      return { verified: true, releaseId: r.rows[0].id };
    });
  }
}

module.exports = { registerAll, RELEASE_RESERVE_TYPES };
