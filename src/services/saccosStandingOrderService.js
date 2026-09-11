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
const welfare = require('./saccosWelfareService');
const credit = require('./saccosCreditService');

const VALID_TYPES = ['SAVINGS_DEPOSIT', 'FUND_CONTRIBUTION', 'WELFARE_CONTRIBUTION', 'LOAN_REPAYMENT'];
const round2 = (n) => Math.round(Number(n) * 100) / 100;

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
    `UPDATE saccos_standing_orders SET status = 'DEACTIVATED', deactivated_at = NOW() WHERE id = $1 RETURNING *`,
    [orderId]
  );
  await logAudit(actorId, 'SACCOS_STANDING_ORDER_DEACTIVATED', {
    referenceId: saccosId, details: { orderId, reference: order.reference_id },
  }).catch(() => {});
  return { ...r.rows[0], amount: Number(r.rows[0].amount) };
}

/** Execute one standing order against its live target flow. Throws on failure. */
async function executeOrder(client, order) {
  const member = await client.query(
    'SELECT user_id FROM saccos_members WHERE id = $1', [order.member_id]
  );
  if (!member.rows.length) throw new Error('member not found');
  const userId = member.rows[0].user_id;

  if (order.target_type === 'SAVINGS_DEPOSIT') {
    return savings.deposit(userId, order.saccos_id, { amount: Number(order.amount) });
  }
  if (order.target_type === 'FUND_CONTRIBUTION') {
    return funds.contributeFund(userId, order.saccos_id, order.target_id, Number(order.amount));
  }
  if (order.target_type === 'WELFARE_CONTRIBUTION') {
    return welfare.contribute(userId, order.saccos_id, { schemeId: order.target_id, amount: Number(order.amount) });
  }
  if (order.target_type === 'LOAN_REPAYMENT') {
    return credit.repayLoan(userId, order.saccos_id, order.target_id, { amount: Number(order.amount) });
  }
  throw new Error('unknown target type');
}

/** Advance the schedule one month on the order's day-of-month. */
function nextRunDate(order) {
  const ref = order.next_run_at ? new Date(order.next_run_at) : new Date();
  const d = new Date(ref.getFullYear(), ref.getMonth() + 1, Math.min(Number(order.day_of_month) || 1, 28));
  return d.toISOString().slice(0, 10);
}

/** Book a run result on an order row (inside the caller's transaction). */
async function recordRun(client, order, outcome, errorMessage) {
  if (outcome === 'SUCCESS') {
    await client.query(
      `UPDATE saccos_standing_orders
          SET total_runs = total_runs + 1, success_runs = success_runs + 1,
              fail_runs = 0, last_error = NULL, last_run_at = NOW(), next_run_at = $2
        WHERE id = $1`,
      [order.id, nextRunDate(order)]
    );
  } else {
    const failRuns = Number(order.fail_runs) + 1;
    const deactivate = failRuns >= 3;
    await client.query(
      `UPDATE saccos_standing_orders
          SET total_runs = total_runs + 1, fail_runs = $2, last_error = $3,
              last_run_at = NOW(), status = CASE WHEN $4 THEN 'DEACTIVATED' ELSE status END,
              deactivated_at = CASE WHEN $4 THEN NOW() ELSE deactivated_at END
        WHERE id = $1`,
      [order.id, failRuns, String(errorMessage).slice(0, 300), deactivate]
    );
  }
}

/** Run all due orders for one SACCOS. Returns executed/succeeded/failed counts. */
async function runDueForSaccos(saccosId) {
  const due = await pool.query(
    `SELECT * FROM saccos_standing_orders
      WHERE saccos_id = $1 AND status = 'ACTIVE'
        AND (next_run_at IS NULL OR next_run_at <= CURRENT_DATE)
      ORDER BY id`,
    [saccosId]
  );
  let executed = 0;
  let succeeded = 0;
  let failed = 0;
  for (const order of due.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await executeOrder(client, order);
      await recordRun(client, order, 'SUCCESS');
      await logAudit(order.member_id, 'SACCOS_STANDING_ORDER_RUN', {
        referenceId: saccosId,
        details: { orderId: order.id, reference: order.reference_id, targetType: order.target_type, amount: Number(order.amount), outcome: 'SUCCESS' },
      }).catch(() => {});
      await client.query('COMMIT');
      executed += 1;
      succeeded += 1;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      failed += 1;
      executed += 1;
      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        await recordRun(client2, order, 'FAILURE', e.message);
        await logAudit(order.member_id, 'SACCOS_STANDING_ORDER_RUN', {
          referenceId: saccosId,
          details: { orderId: order.id, reference: order.reference_id, targetType: order.target_type, outcome: 'FAILURE', error: String(e.message).slice(0, 300) },
        }).catch(() => {});
        await client2.query('COMMIT');
      } catch (e2) {
        await client2.query('ROLLBACK').catch(() => {});
      } finally {
        client2.release();
      }
    } finally {
      client.release();
    }
  }
  return { saccosId, due: due.rows.length, executed, succeeded, failed };
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