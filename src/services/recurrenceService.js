/**
 * Recurrence Automation Scheduler
 *
 * General-purpose recurring task scheduler for automated financial operations:
 *   - AUTO_SAVINGS          : sweep a configured amount into a savings pool each cycle
 *   - CONTRIBUTION_CYCLE    : auto-create the next VICOBA contribution cycle when due
 *   - PAYROLL_RUN           : generate a payroll run for an active schedule each cycle
 *   - STANDING_INSTRUCTION  : generic recurring instruction placeholder
 *
 * The executor is driven by an in-process interval; every due rule is dispatched
 * to the matching service and its completed execution is recorded for audit.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

// ===== Date helpers =====

function addFrequency(date, freq, step) {
  const d = new Date(date);
  switch (freq) {
    case 'DAILY': d.setUTCDate(d.getUTCDate() + step); break;
    case 'WEEKLY': d.setUTCDate(d.getUTCDate() + 7 * step); break;
    case 'BIWEEKLY': d.setUTCDate(d.getUTCDate() + 14 * step); break;
    case 'MONTHLY': d.setUTCMonth(d.getUTCMonth() + step); break;
    default: d.setUTCDate(d.getUTCDate() + step);
  }
  return d;
}

function computeNextRun(rule) {
  const next = addFrequency(rule.next_run_at || new Date(), rule.frequency, rule.interval_step);
  // Align monthly runs to configured day_of_month
  if (rule.frequency === 'MONTHLY' && rule.day_of_month) {
    next.setUTCDate(Math.min(rule.day_of_month, 28));
  }
  return next;
}

// ===== Task dispatchers =====

async function runAutoSavings(payload) {
  const fin = require('./financialEngine');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Transfer amount from user wallet to savings pool (CUSTOMER_WALLET -> SAVINGS_LEDGER)
    const userId = payload.userId, amount = Number(payload.amount);
    if (!userId || !(amount > 0)) throw new Error('Auto-savings requires userId and amount');
    const user = (await client.query('SELECT wallet_balance FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!user) throw new Error('User not found');
    if (Number(user.wallet_balance) < amount) throw new Error('Insufficient balance for auto-savings');
    const reference = `SAV-${Date.now()}`;
    const op = await fin.claimOperation ? fin.claimOperation({ client, operationType: 'DEBIT', reference, userId, amount })
      : { claimed: true };
    if (op.claimed === false) { await client.query('ROLLBACK').catch(() => {}); return { skipped: true, reason: 'dup' }; }
    await client.query(`UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id=$2`, [amount, userId]);
    await fin.postJournal ? fin.postJournal({ client, lines: [
      { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount },
      { accountCode: 'SAVINGS_LEDGER', direction: 'CR', amount },
    ], referenceId: reference, description: payload.description || 'Auto-savings', postedBy: 'recurrence:auto-savings' })
      : null;
    await client.query('COMMIT');
    return { saved: amount, reference };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function runContributionCycle(payload) {
  const vicoba = require('./vicobaService');
  const groupId = payload.groupId;
  // Query the latest cycle and schedule the next one
  const res = await pool.query(
    `SELECT COALESCE(MAX(cycle_number),0)::int AS last_cycle FROM vicoba_contribution_schedules WHERE group_id=$1`,
    [groupId]
  );
  const lastCycle = res.rows[0]?.last_cycle || 0;
  const nextCycle = lastCycle + 1;
  const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await vicoba.createContributionSchedule(groupId, nextCycle, dueDate);
  return { groupId, nextCycle, dueDate };
}

async function runPayroll(payload) {
  const payroll = require('./payrollService');
  const scheduleId = payload.scheduleId;
  const sched = (await pool.query('SELECT status FROM payroll_schedules WHERE id=$1', [scheduleId])).rows[0];
  if (!sched) throw new Error('Payroll schedule not found');
  if (sched.status !== 'ACTIVE') throw new Error('Payroll schedule not active');
  const end = new Date(); const start = new Date(end);
  if (payload.frequency === 'MONTHLY') start.setMonth(start.getMonth() - 1);
  else if (payload.frequency === 'WEEKLY' || payload.frequency === 'BIWEEKLY') start.setDate(start.getDate() - 7);
  else start.setDate(start.getDate() - 1);
  const periodEnd = end.toISOString().slice(0, 10);
  const periodStart = start.toISOString().slice(0, 10);
  const result = await payroll.runPayroll(scheduleId, { periodStart, periodEnd, approveImmediately: true });
  return { runId: result.run.id, payslips: result.payslips.length, total: result.run.total_amount };
}

// ===== Rule management =====

async function createRule(adminId, data) {
  const { name, taskType, frequency, intervalStep, dayOfMonth, payload } = data;
  if (!name || !taskType || !frequency) throw Object.assign(new Error('Name, task type and frequency are required.'), { statusCode: 400 });
  const nextRunAt = computeNextRun({ frequency, interval_step: intervalStep, day_of_month: dayOfMonth, next_run_at: new Date() });
  const res = await pool.query(
    `INSERT INTO recurrence_rules
       (name, task_type, frequency, interval_step, day_of_month, payload, next_run_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, taskType, frequency, intervalStep || 1, dayOfMonth || null, JSON.stringify(payload || {}), nextRunAt, adminId]
  );
  return res.rows[0];
}

async function listRules(includeDisabled = false) {
  const res = await pool.query(
    `SELECT * FROM recurrence_rules ${includeDisabled ? '' : 'WHERE enabled'} ORDER BY next_run_at`
  );
  return res.rows;
}

async function setRuleEnabled(ruleId, enabled) {
  const res = await pool.query(
    `UPDATE recurrence_rules SET enabled=$2 WHERE id=$1 RETURNING *`,
    [ruleId, enabled]
  );
  if (!res.rows[0]) throw Object.assign(new Error('Rule not found.'), { statusCode: 404 });
  return res.rows[0];
}

async function executions(ruleId, limit = 20) {
  const res = await pool.query(
    `SELECT * FROM recurrence_executions WHERE ($1::int IS NULL OR rule_id=$1) ORDER BY run_at DESC LIMIT $2`,
    [ruleId || null, limit]
  );
  return res.rows;
}

// ===== Executor =====

async function runDueTasks() {
  try {
    const due = (await pool.query(
      `SELECT * FROM recurrence_rules WHERE enabled AND next_run_at <= NOW() ORDER BY next_run_at LIMIT 50`
    )).rows;

    for (const rule of due) {
      let status = 'SUCCESS', detail = {};
      try {
        let result;
        switch (rule.task_type) {
          case 'AUTO_SAVINGS': result = await runAutoSavings(rule.payload); break;
          case 'CONTRIBUTION_CYCLE': result = await runContributionCycle(rule.payload); break;
          case 'PAYROLL_RUN': result = await runPayroll({ ...rule.payload, frequency: rule.frequency }); break;
          default: result = { note: `No dispatcher for ${rule.task_type}` };
        }
        detail = { result };
      } catch (err) {
        status = 'FAILED';
        detail = { error: err.message };
        logger.error('RECURRENCE', `Rule ${rule.id} (${rule.name}) failed: ${err.message}`);
      }
      await pool.query(`UPDATE recurrence_rules SET last_run_at=NOW(), run_count=run_count+1, next_run_at=$2 WHERE id=$1`, [rule.id, computeNextRun(rule)]);
      await pool.query(
        `INSERT INTO recurrence_executions (rule_id, status, detail) VALUES ($1,$2,$3)`,
        [rule.id, status, JSON.stringify(detail)]
      );
    }
    return { due: due.length };
  } catch (err) {
    logger.error('RECURRENCE', `Sweep error: ${err.message}`);
    return { error: err.message };
  }
}

function startRecurrenceScheduler(intervalMs = 60000) {
  runDueTasks(); // initial sweep
  const timer = setInterval(runDueTasks, intervalMs);
  timer.unref && timer.unref();
  logger.info('RECURRENCE', `Recurrence scheduler started (every ${intervalMs}ms)`);
  return timer;
}

module.exports = {
  createRule, listRules, setRuleEnabled, executions, runDueTasks, startRecurrenceScheduler, computeNextRun,
};
