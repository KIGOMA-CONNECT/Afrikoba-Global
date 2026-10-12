/**
 * SACCOS Digital Core - Standing Orders / Recurring Contributions
 * (increment 17).
 * A member instructs a monthly auto-move (day_of_month 1-28) of a fixed
 * amount into one of four targets, executed through the normal member
 * flows so every transfer stays on the shared double-entry ledger:
 *   SAVINGS_DEPOSIT      -> saccosSavingsService.deposit
 *   FUND_CONTRIBUTION    -> saccosFundsService.contributeFund
 *   WELFARE_CONTRIBUTION -> saccosWelfareService.contribute
 *   LOAN_REPAYMENT       -> saccosCreditService.repayLoan
 *
 * An order is DUE when `next_run_at` is NULL (fresh, first trigger) or
 * not in the future. A successful run journals the payment and advances
 * `next_run_at` one month to `day_of_month`; a failed run is retried on
 * the next trigger (member payout / cron) and the order is DEACTIVATED
 * after 3 consecutive failures. Execution is gated per-entity for the
 * API (OWNER/BOARD) and runs globally for the daily cron job.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const saccosCore = require('./saccosService');
const savings = require('./saccosSavingsService');
const funds = require('./saccosFundsService');
const credit = require('./saccosCreditService');
const welfare = require('./saccosWelfareService');

const VALID_TYPES = [
  'SAVINGS_DEPOSIT',
  'FUND_CONTRIBUTION',
  'WELFARE_CONTRIBUTION',
  'LOAN_REPAYMENT',
];
function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function fetchOrder(saccosId, orderId) {
  const r = await pool.query('SELECT * FROM saccos_standing_orders WHERE id = $1 AND saccos_id = $2', [orderId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_STANDING_ORDER_NOT_FOUND');
  return r.rows[0];
}

/** Validate that an order's target exists and is usable; returns the target id. */
async function validateTarget(saccosId, memberId, targetType, rawTargetId) {
  const targetId = rawTargetId === undefined || rawTargetId === null ? null : Number(rawTargetId);
  if (targetType === 'SAVINGS_DEPOSIT') {
    if (targetId !== null) throw createAppError('SACCOS_STANDING_ORDER_TARGET');
    return null;
  }
  if (targetType === 'FUND_CONTRIBUTION') {
    const r = await pool.query(
      'SELECT id FROM saccos_funds WHERE id = $1 AND saccos_id = $2 AND status = $3',
      [targetId, saccosId, 'ACTIVE']
    );
    if (!r.rows.length) throw createAppError('SACCOS_STANDING_ORDER_TARGET');
    return targetId;
  }
  if (targetType === 'WELFARE_CONTRIBUTION') {
    const r = await pool.query(
      'SELECT id FROM saccos_welfare_schemes WHERE id = $1 AND saccos_id = $2 AND status = $3',
      [targetId, saccosId, 'ACTIVE']
    );
    if (!r.rows.length) throw createAppError('SACCOS_STANDING_ORDER_TARGET');
    return targetId;
  }
  if (targetType === 'LOAN_REPAYMENT') {
    const r = await pool.query(
      'SELECT id FROM saccos_loans WHERE id = $1 AND saccos_id = $2 AND member_id = $3 AND status = $4',
      [targetId, saccosId, memberId, 'ACTIVE']
    );
    if (!r.rows.length) throw createAppError('SACCOS_STANDING_ORDER_TARGET');
    return targetId;
  }
  throw createAppError('SACCOS_STANDING_ORDER_TYPE');
}

async function createOrder(actorId, saccosId, { targetType, targetId, amount, dayOfMonth }) {
  const membership = await requireActiveMember(actorId, saccosId);
  const type = String(targetType || '').toUpperCase();
  if (!VALID_TYPES.includes(type)) throw createAppError('SACCOS_STANDING_ORDER_TYPE');
  const amountN = Number(amount);
  if (!Number.isFinite(amountN) || amountN <= 0) throw createAppError('SACCOS_STANDING_ORDER_AMOUNT');
  const day = Number(dayOfMonth);
  if (!Number.isInteger(day) || day < 1 || day > 28) throw createAppError('SACCOS_STANDING_ORDER_DAY');

  const tid = await validateTarget(saccosId, membership.id, type, targetId);
  const ref = newRef('SO');
  const r = await pool.query(
    `INSERT INTO saccos_standing_orders
       (saccos_id, member_id, reference_id, target_type, target_id, amount, day_of_month)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [saccosId, membership.id, ref, type, tid, amountN, day]
  );
  await logAudit(actorId, 'SACCOS_STANDING_ORDER_CREATED', {
    referenceId: saccosId,
    details: { reference: ref, orderId: r.rows[0].id, targetType: type, amount: amountN, dayOfMonth: day },
  }).catch(() => {});
  return { ...r.rows[0], amount: Number(r.rows[0].amount) };
}

async function listMyOrders(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT * FROM saccos_standing_orders WHERE saccos_id = $1 AND member_id = $2 ORDER BY created_at DESC`,
    [saccosId, membership.id]
  );
  return r.rows.map((x) => ({ ...x, amount: Number(x.amount) }));
}

async function listOrders(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const r = await pool.query(
    `SELECT o.*, m.member_number, u.full_name
       FROM saccos_standing_orders o
       JOIN saccos_members m ON m.id = o.member_id
       JOIN users u ON u.id = m.user_id
      WHERE o.saccos_id = $1 ORDER BY o.created_at DESC`,
    [saccosId]
  );
  return r.rows.map((x) => ({ ...x, amount: Number(x.amount) }));
}

async function deactivateOrder(actorId, saccosId, orderId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const governing = ['OWNER', 'BOARD'].includes(membership.role);
  const order = await fetchOrder(saccosId, orderId);
  if (order.status !== 'ACTIVE') throw createAppError('SACCOS_STANDING_ORDER_STATE');
  if (order.member_id !== membership.id && !governing) throw createAppError('SACCOS_RBAC');
  const r = await pool.query(
    `UPDATE saccos_standing_orders
        SET status = 'DEACTIVATED', deactivated_at = NOW()
      WHERE id = $1 AND saccos_id = $2 AND status = 'ACTIVE'
      RETURNING *`,
    [orderId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_STANDING_ORDER_STATE');

  await logAudit(actorId, 'SACCOS_STANDING_ORDER_DEACTIVATED', {
    referenceId: saccosId, details: { orderId, reference: order.reference_id },
  }).catch(() => {});
  return { ...r.rows[0], amount: Number(r.rows[0].amount) };
}

/**
 * Deterministic reference for one standing-order occurrence.
 *
 * The occurrence date is supplied by PostgreSQL CURRENT_DATE so the
 * idempotency key follows the database/business date rather than the
 * Node.js process timezone.
 */
function occurrenceReference(order, occurrenceDate) {
  return `SOR-${order.id}-${String(occurrenceDate).replace(/-/g, '')}`;
}

/** Execute one standing order against its live target flow using the caller's transaction. */
async function executeOrder(client, order, reference) {
  const member = await client.query(
    'SELECT user_id FROM saccos_members WHERE id = $1 FOR UPDATE',
    [order.member_id]
  );
  if (!member.rows.length) throw new Error('member not found');

  const userId = member.rows[0].user_id;
  const amount = Number(order.amount);

  if (order.target_type === 'SAVINGS_DEPOSIT') {
    const result = await savings.deposit(userId, order.saccos_id, {
      amount,
      client,
      reference,
    });
    return { userId, result };
  }

  if (order.target_type === 'FUND_CONTRIBUTION') {
    const result = await funds.contributeFund(
      userId,
      order.saccos_id,
      order.target_id,
      amount,
      { client, reference }
    );
    return { userId, result };
  }

  if (order.target_type === 'WELFARE_CONTRIBUTION') {
    const result = await welfare.contribute(
      userId,
      order.saccos_id,
      {
        schemeId: order.target_id,
        amount,
        client,
        reference,
      }
    );
    return { userId, result };
  }

  if (order.target_type === 'LOAN_REPAYMENT') {
    const result = await credit.repayLoan(
      userId,
      order.saccos_id,
      order.target_id,
      { amount, client, reference }
    );
    return { userId, result };
  }

  throw createAppError('SACCOS_STANDING_ORDER_TYPE');
}

/** Advance the schedule one month on the order's day-of-month. */
function nextRunDate(order) {
  if (order.next_run_at) {
    const ref = new Date(order.next_run_at);
    const d = new Date(
      ref.getUTCFullYear(),
      ref.getUTCMonth() + 1,
      Math.min(Number(order.day_of_month) || 1, 28)
    );
    return d.toISOString().slice(0, 10);
  }

  const now = new Date();
  const d = new Date(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    Math.min(Number(order.day_of_month) || 1, 28)
  );
  return d.toISOString().slice(0, 10);
}

/** Book a successful run on an order row inside the caller's transaction. */
async function recordSuccess(client, order) {
  const r = await client.query(
    `UPDATE saccos_standing_orders
        SET total_runs = total_runs + 1,
            success_runs = success_runs + 1,
            fail_runs = 0,
            last_error = NULL,
            last_run_at = NOW(),
            next_run_at = $2
      WHERE id = $1
        AND status = 'ACTIVE'
      RETURNING *`,
    [order.id, nextRunDate(order)]
  );

  if (!r.rows.length) {
    throw createAppError('SACCOS_STANDING_ORDER_STATE');
  }

  return r.rows[0];
}

/**
 * Book a failed run after the financial savepoint has been rolled back.
 *
 * The row is already locked by the outer transaction, and fail_runs is
 * incremented in SQL rather than calculated from the stale SELECT value.
 */
async function recordFailure(client, order, errorMessage) {
  const r = await client.query(
    `UPDATE saccos_standing_orders
        SET total_runs = total_runs + 1,
            fail_runs = fail_runs + 1,
            last_error = $2,
            last_run_at = NOW(),
            status = CASE
              WHEN fail_runs + 1 >= 3 THEN 'DEACTIVATED'
              ELSE status
            END,
            deactivated_at = CASE
              WHEN fail_runs + 1 >= 3 THEN NOW()
              ELSE deactivated_at
            END
      WHERE id = $1
      RETURNING *`,
    [order.id, String(errorMessage || 'Standing order failed').slice(0, 300)]
  );

  if (!r.rows.length) {
    throw createAppError('SACCOS_STANDING_ORDER_NOT_FOUND');
  }

  return r.rows[0];
}

/**
 * Claim and execute due orders one at a time.
 *
 * FOR UPDATE SKIP LOCKED makes concurrent cron/manual runners safe:
 * a second worker skips an order already claimed by another transaction.
 *
 * The financial operation runs behind a SAVEPOINT. If it fails, only the
 * financial work is rolled back; the outer transaction remains alive so the
 * failure counter and retry/deactivation state can be committed atomically.
 */
async function runDueForSaccos(saccosId) {
  let executed = 0;
  let succeeded = 0;
  let failed = 0;
  const processedIds = new Set();

  while (true) {
    const client = await pool.connect();
    let order = null;
    let outcome = null;
    let errorMessage = null;

    try {
      await client.query('BEGIN');

      const due = await client.query(
        `SELECT *, CURRENT_DATE::text AS occurrence_date
           FROM saccos_standing_orders
          WHERE saccos_id = $1
            AND status = 'ACTIVE'
            AND (next_run_at IS NULL OR next_run_at <= CURRENT_DATE)
            AND NOT (id = ANY($2::int[]))
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [saccosId, Array.from(processedIds)]
      );

      if (!due.rows.length) {
        await client.query('COMMIT');
        break;
      }

      order = due.rows[0];
      processedIds.add(order.id);
      const reference = occurrenceReference(order, order.occurrence_date);

      await client.query('SAVEPOINT standing_order_execution');

      let execution = null;

      try {
        execution = await executeOrder(client, order, reference);
        await client.query('RELEASE SAVEPOINT standing_order_execution');

        await recordSuccess(client, order);

        outcome = 'SUCCESS';
        executed += 1;
        succeeded += 1;
      } catch (e) {
        errorMessage = String(e && e.message ? e.message : e).slice(0, 300);

        await client.query(
          'ROLLBACK TO SAVEPOINT standing_order_execution'
        );

        await recordFailure(client, order, errorMessage);

        outcome = 'FAILURE';
        executed += 1;
        failed += 1;
      }

      await client.query('COMMIT');

      await logAudit(execution?.userId || null, 'SACCOS_STANDING_ORDER_RUN', {
        referenceId: saccosId,
        details: {
          orderId: order.id,
          reference: order.reference_id,
          occurrenceReference: reference,
          targetType: order.target_type,
          amount: Number(order.amount),
          outcome,
          error: errorMessage,
        },
      }).catch(() => {});
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});

      /*
       * A database/control-plane failure is not counted as a financial
       * standing-order failure because recordFailure() itself may not have
       * committed. Surface it to the caller rather than fabricating state.
       */
      throw e;
    } finally {
      client.release();
    }
  }

  return { saccosId, executed, succeeded, failed };
}

/** API trigger: run all due standing orders for an entity (OWNER/BOARD only). */
async function runDue(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const out = await runDueForSaccos(saccosId);
  await logAudit(actorId, 'SACCOS_STANDING_ORDER_RUN', {
    referenceId: saccosId,
    details: { trigger: 'manual', ...out },
  }).catch(() => {});
  return out;
}

/** Global sweep used by the daily cron. */
async function runDueStandingOrders() {
  const saccos = await pool.query('SELECT id FROM saccos WHERE status = $1', ['ACTIVE']);
  const results = [];
  for (const row of saccos.rows) {
    try {
      results.push(await runDueForSaccos(row.id));
    } catch (e) {
      results.push({ saccosId: row.id, error: String(e.message).slice(0, 200) });
    }
  }
  return { entities: results.length, executed: results.reduce((a, r) => a + (r.executed || 0), 0) };
}

module.exports = {
  createOrder,
  listMyOrders,
  listOrders,
  deactivateOrder,
  runDue,
  runDueStandingOrders,
  runDueForSaccos,
  nextRunDate,
};