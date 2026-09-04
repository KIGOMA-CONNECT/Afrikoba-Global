/**
 * Automated Payroll Engine Service
 *
 * Manages recurring member/staff compensation: pay schedules, payroll runs, and
 * payslips. Each run debits the treasury wallet and credits each recipient's
 * customer wallet through the financial engine, producing per-payslip ledger refs.
 */

const pool = require('../config/db');
const fin = require('./financialEngine');
const { generateReference } = require('../utils/helpers');
const { logAudit } = require('./auditService');

// ===== Schedules =====

async function createSchedule(userId, { name, treasuryWalletId, frequency = 'MONTHLY', dayOfCycle = 1, entries = [] }) {
  if (!name || !treasuryWalletId) throw Object.assign(new Error('Jina na mkoba wa hazina vinahitajika.'), { statusCode: 400 });
  if (!['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'].includes(frequency)) throw Object.assign(new Error('Frequency si sahihi.'), { statusCode: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wallet = (await client.query('SELECT id FROM treasury_wallets WHERE id=$1', [treasuryWalletId])).rows[0];
    if (!wallet) throw Object.assign(new Error('Mkoba wa hazina haupatikani.'), { statusCode: 404 });

    const sched = (await client.query(
      `INSERT INTO payroll_schedules (name, treasury_wallet_id, frequency, day_of_cycle, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, treasuryWalletId, frequency, dayOfCycle, userId]
    )).rows[0];

    for (const e of Array.isArray(entries) ? entries : []) {
      await client.query(
        `INSERT INTO payroll_schedule_entries (schedule_id, user_id, base_amount, role, adjustments)
         VALUES ($1,$2,$3,$4,$5)`,
        [sched.id, e.userId, e.baseAmount, e.role || null, JSON.stringify(e.adjustments || [])]
      );
    }

    await client.query('COMMIT');
    return { success: true, schedule: sched };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function listSchedules() {
  const res = await pool.query(
    `SELECT s.*, w.name AS wallet_name,
            (SELECT COALESCE(SUM(e.base_amount),0) FROM payroll_schedule_entries e WHERE e.schedule_id = s.id AND e.active) AS monthly_cost,
            (SELECT COUNT(*)::int FROM payroll_schedule_entries e WHERE e.schedule_id = s.id AND e.active) AS headcount
     FROM payroll_schedules s JOIN treasury_wallets w ON s.treasury_wallet_id = w.id
     ORDER BY s.created_at DESC`
  );
  return res.rows;
}

async function addScheduleEntry(scheduleId, { userId, baseAmount, role, adjustments = [] }) {
  const sched = (await pool.query('SELECT id FROM payroll_schedules WHERE id=$1', [scheduleId])).rows[0];
  if (!sched) throw Object.assign(new Error('Ratiba haipatikani.'), { statusCode: 404 });
  const res = await pool.query(
    `INSERT INTO payroll_schedule_entries (schedule_id, user_id, base_amount, role, adjustments)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [scheduleId, userId, baseAmount, role || null, JSON.stringify(adjustments)]
  );
  return res.rows[0];
}

async function pauseSchedule(scheduleId, active) {
  const res = await pool.query(
    `UPDATE payroll_schedules SET status=$2 WHERE id=$1 RETURNING *`,
    [scheduleId, active ? 'ACTIVE' : 'PAUSED']
  );
  if (!res.rows[0]) throw Object.assign(new Error('Ratiba haipatikani.'), { statusCode: 404 });
  return res.rows[0];
}

// ===== Runs =====

async function runPayroll(scheduleId, { periodStart, periodEnd, approveImmediately = false }) {
  const sched = (await pool.query('SELECT * FROM payroll_schedules WHERE id=$1', [scheduleId])).rows[0];
  if (!sched) throw Object.assign(new Error('Ratiba haipatikani.'), { statusCode: 404 });
  if (sched.status !== 'ACTIVE') throw Object.assign(new Error('Ratiba imesitishwa.'), { statusCode: 400 });

  const entries = (await pool.query(
    `SELECT e.*, u.phone_number FROM payroll_schedule_entries e JOIN users u ON e.user_id = u.id
     WHERE e.schedule_id=$1 AND e.active ORDER BY e.id`,
    [scheduleId]
  )).rows;

  if (entries.length === 0) throw Object.assign(new Error('Hakuna walengwa kwenye ratiba.'), { statusCode: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const wallet = (await client.query('SELECT balance FROM treasury_wallets WHERE id=$1 FOR UPDATE', [sched.treasury_wallet_id])).rows[0];
    if (!wallet) throw Object.assign(new Error('Mkoba wa hazina haupatikani.'), { statusCode: 404 });

    const computed = entries.map((e) => {
      const adjTotal = (Array.isArray(e.adjustments) ? e.adjustments : []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
      return { ...e, adjustmentsTotal: adjTotal, net: Number(e.base_amount) + adjTotal };
    });

    const total = computed.reduce((s, c) => s + c.net, 0);
    if (Number(wallet.balance) < total) {
      throw Object.assign(new Error('Salio la mkoba wa hazina halitoshi kwa malipo.'), { statusCode: 400 });
    }

    const run = (await client.query(
      `INSERT INTO payroll_runs (schedule_id, treasury_wallet_id, period_start, period_end, status, total_amount)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [scheduleId, sched.treasury_wallet_id, periodStart, endOfDay(periodEnd).split('T')[0], approveImmediately ? 'APPROVED' : 'PENDING_APPROVAL', total]
    )).rows[0];

    for (const c of computed) {
      await client.query(
        `INSERT INTO payroll_payslips (run_id, user_id, base_amount, adjustments_total, net_amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [run.id, c.user_id, c.base_amount, c.adjustmentsTotal, c.net]
      );
    }

    await client.query('COMMIT');
    return { success: true, run, payslips: computed.map((c) => ({ user_id: c.user_id, net: c.net })) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

function endOfDay(dateStr) {
  return dateStr ? `${dateStr}T23:59:59` : new Date().toISOString().slice(0, 10) + 'T23:59:59';
}

async function approveAndPayRun(runId, approverId) {
  const run = (await pool.query(
    'SELECT * FROM payroll_runs WHERE id=$1', [runId]
  )).rows[0];
  if (!run) throw Object.assign(new Error('Run haipatikani.'), { statusCode: 404 });
  if (run.status !== 'PENDING_APPROVAL') throw Object.assign(new Error('Run hii haiko kwenye hali ya kuidhinishwa.'), { statusCode: 400 });

  const wallet = (await pool.query(
    'SELECT balance FROM treasury_wallets WHERE id=$1', [run.treasury_wallet_id]
  )).rows[0];
  if (Number(wallet.balance) < Number(run.total_amount)) {
    throw Object.assign(new Error('Salio la hazina halitoshi.'), { statusCode: 400 });
  }

  const payslips = (await pool.query('SELECT * FROM payroll_payslips WHERE run_id=$1 ORDER BY id', [runId])).rows;
  const results = [];
  let failuresOnly = true;

  for (const ps of payslips) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ref = generateReference('PAY');
      await client.query('UPDATE treasury_wallets SET balance = balance - $1 WHERE id = $2', [ps.net_amount, run.treasury_wallet_id]);
      await fin.creditWallet({ client, userId: ps.user_id, amount: ps.net_amount, reference: ref, fromAccount: 'SUSPENSE', description: `Payroll ${run.id}`, actor: `payroll:run-${runId}` });
      await client.query(`UPDATE payroll_payslips SET status='PAID', ledger_ref=$1, paid_at=NOW() WHERE id=$2`, [ref, ps.id]);
      await client.query('COMMIT');
      failuresOnly = false;
      results.push({ user_id: ps.user_id, net: ps.net_amount, ledger_ref: ref, paid: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      results.push({ user_id: ps.user_id, net: ps.net_amount, paid: false, error: err.message });
    } finally { client.release(); }
  }

  const paidCount = results.filter((r) => r.paid).length;
  const status = paidCount === payslips.length ? 'PAID' : paidCount > 0 ? 'PARTIAL' : 'FAILED';

  await pool.query(
    `UPDATE payroll_runs SET status=$1, approved_by=$2 WHERE id=$3`,
    [status, approverId, runId]
  );

  await logAudit({
    eventType: 'PAYROLL_RUN',
    action: 'PAY',
    entityType: 'PAYROLL_RUN',
    userId: approverId,
    referenceId: `PAYROLL-${runId}`,
    amount: Number(run.total_amount),
    afterData: { run_id: runId, paid: paidCount, total: payslips.length, status }
  }).catch(() => {});

  return { success: true, status, results };
}

async function listRuns(scheduleId) {
  const res = await pool.query(
    `SELECT r.*, s.name AS schedule_name,
            (SELECT COUNT(*)::int FROM payroll_payslips p WHERE p.run_id = r.id) AS recipients
     FROM payroll_runs r JOIN payroll_schedules s ON r.schedule_id = s.id
     WHERE ($1::int IS NULL OR r.schedule_id = $1)
     ORDER BY r.created_at DESC`,
    [scheduleId || null]
  );
  return res.rows;
}

async function listPayslipsForUser(userId) {
  const res = await pool.query(
    `SELECT p.*, r.period_start, r.period_end, s.name AS schedule_name
     FROM payroll_payslips p
     JOIN payroll_runs r ON p.run_id = r.id
     JOIN payroll_schedules s ON r.schedule_id = s.id
     WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
    [userId]
  );
  return res.rows;
}

async function listRunPayslips(runId) {
  const res = await pool.query(
    `SELECT p.*, u.full_name, u.phone_number
     FROM payroll_payslips p JOIN users u ON p.user_id = u.id
     WHERE p.run_id = $1 ORDER BY p.id`,
    [runId]
  );
  return res.rows;
}

module.exports = {
  createSchedule, listSchedules, addScheduleEntry, pauseSchedule,
  runPayroll, approveAndPayRun, listRuns, listPayslipsForUser, listRunPayslips,
};
