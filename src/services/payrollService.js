/**
 * Automated Payroll Engine Service
 *
 * Recurring member/staff compensation.  Supports two funding sources:
 *  - TREASURY: legacy multi-sig treasury wallet  (no tax)
 *  - MERCHANT: merchant connected-account balance (progressive PAYE by default)
 */

const pool = require('../config/db');
const fin = require('./financialEngine');
const { generateReference } = require('../utils/helpers');
const { logAudit } = require('./auditService');

function badge(msg, statusCode) {
  return Object.assign(new Error(msg), { statusCode });
}

// ── TZS PAYE brackets (2024-2025) ───────────────────────────────────────────
const DEFAULT_PAYE = [
  { min: 0,      max: 270000, rate: 8 },
  { min: 270000, max: 520000, rate: 20 },
  { min: 520000, max: 760000, rate: 25 },
  { min: 760000, max: null,    rate: 30 },
];

function computeProgressiveTax(gross, brackets = []) {
  if (!brackets || !brackets.length) return 0;
  let tax = 0;
  for (const b of brackets) {
    const lo = Number(b.min) || 0;
    const hi = b.max == null ? gross : Math.min(gross, Number(b.max));
    if (hi <= lo) continue;
    const band = hi - lo;
    tax += band * (Number(b.rate) / 100);
  }
  return Math.round(tax * 100) / 100;
}

function deduceAdjustments(adjustments) {
  const list = Array.isArray(adjustments) ? adjustments : [];
  let bonus = 0;
  let deductions = 0;
  for (const a of list) {
    const amt = Number(a.amount) || 0;
    if (amt >= 0) bonus += amt;
    else deductions += Math.abs(amt);
  }
  return { bonus, deductions };
}

async function merchantForUser(userId) {
  const r = await pool.query('SELECT * FROM merchants WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]);
  if (!r.rows[0]) throw badge('Huna biashara iliyosajiliwa.', 404);
  return r.rows[0];
}

async function assertMerchantAccount(merchantId) {
  const r = await pool.query('SELECT * FROM connected_merchant_accounts WHERE merchant_id = $1', [merchantId]);
  if (!r.rows[0]) throw badge('Akaunti ya biashara haijaungana.', 404);
  return r.rows[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// Schedules
// ═════════════════════════════════════════════════════════════════════════════

async function createSchedule(userId, { name, treasuryWalletId, merchantId, currency, taxBrackets, frequency = 'MONTHLY', dayOfCycle = 1, entries = [] }) {
  if (!name) throw badge('Jina la ratiba linahitajika.', 400);
  if (!['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'].includes(frequency)) throw badge('Frequency si sahihi.', 400);

  const fundingSource = merchantId ? 'MERCHANT' : 'TREASURY';
  const effectiveTaxBrackets = taxBrackets != null ? taxBrackets : (merchantId ? DEFAULT_PAYE : null);

  let treasuryId = null;
  let merchantRow = null;

  if (merchantId) {
    merchantRow = await merchantForUser(userId);
    if (Number(merchantId) !== merchantRow.id) throw badge('Biashara hailekewi.', 403);
    await assertMerchantAccount(merchantRow.id);
  } else if (treasuryWalletId) {
    const wallet = (await pool.query('SELECT id FROM treasury_wallets WHERE id=$1', [treasuryWalletId])).rows[0];
    if (!wallet) throw badge('Mkoba wa hazina haupatikani.', 404);
    treasuryId = treasuryWalletId;
  } else {
    throw badge('Chagua mkoba wa hazina au akaunti ya biashara.', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sched = (await client.query(
      `INSERT INTO payroll_schedules (name, treasury_wallet_id, merchant_id, currency, tax_brackets, frequency, day_of_cycle, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, treasuryId, merchantRow ? merchantRow.id : null, currency || 'TZS',
       effectiveTaxBrackets ? JSON.stringify(effectiveTaxBrackets) : null,
       frequency, dayOfCycle, userId]
    )).rows[0];

    for (const e of Array.isArray(entries) ? entries : []) {
      await client.query(
        `INSERT INTO payroll_schedule_entries (schedule_id, user_id, base_amount, role, adjustments, taxable)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sched.id, e.userId, e.baseAmount, e.role || null, JSON.stringify(e.adjustments || []),
         e.taxable !== false]
      );
    }

    await client.query('COMMIT');
    return { success: true, schedule: sched };
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
}

async function listSchedules({ merchantId } = {}) {
  const res = await pool.query(
    `SELECT s.*, w.name AS wallet_name, m.name AS merchant_name,
            (SELECT COALESCE(SUM(e.base_amount),0) FROM payroll_schedule_entries e WHERE e.schedule_id = s.id AND e.active) AS base_total,
            (SELECT COUNT(*)::int FROM payroll_schedule_entries e WHERE e.schedule_id = s.id AND e.active) AS headcount
     FROM payroll_schedules s
     LEFT JOIN treasury_wallets w ON s.treasury_wallet_id = w.id
     LEFT JOIN merchants m ON s.merchant_id = m.id
     WHERE ($1::int IS NULL OR s.merchant_id = $1)
     ORDER BY s.created_at DESC`,
    [merchantId || null]
  );
  return res.rows;
}

async function addScheduleEntry(scheduleId, { userId, baseAmount, role, adjustments = [], taxable = true }) {
  const sched = (await pool.query('SELECT id FROM payroll_schedules WHERE id=$1', [scheduleId])).rows[0];
  if (!sched) throw badge('Ratiba haipatikani.', 404);
  const res = await pool.query(
    `INSERT INTO payroll_schedule_entries (schedule_id, user_id, base_amount, role, adjustments, taxable)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [scheduleId, userId, baseAmount, role || null, JSON.stringify(adjustments), taxable]
  );
  return res.rows[0];
}

async function pauseSchedule(scheduleId, active) {
  const res = await pool.query(
    `UPDATE payroll_schedules SET status=$2 WHERE id=$1 RETURNING *`,
    [scheduleId, active ? 'ACTIVE' : 'PAUSED']
  );
  if (!res.rows[0]) throw badge('Ratiba haipatikani.', 404);
  return res.rows[0];
}

async function assertScheduleOwnership(scheduleId, userId) {
  const sched = (await pool.query(
    'SELECT * FROM payroll_schedules WHERE id=$1', [scheduleId]
  )).rows[0];
  if (!sched) throw badge('Ratiba haipatikani.', 404);
  if (sched.merchant_id) {
    const merchant = await merchantForUser(userId);
    if (Number(sched.merchant_id) !== merchant.id) throw badge('Ratiba hailekewi.', 403);
  }
  return sched;
}

// ═════════════════════════════════════════════════════════════════════════════
// Runs
// ═════════════════════════════════════════════════════════════════════════════

async function runPayroll(scheduleId, { periodStart, periodEnd, approveImmediately = false }) {
  const sched = (await pool.query('SELECT * FROM payroll_schedules WHERE id=$1', [scheduleId])).rows[0];
  if (!sched) throw badge('Ratiba haipatikani.', 404);
  if (sched.status !== 'ACTIVE') throw badge('Ratiba imesitishwa.', 400);

  const entries = (await pool.query(
    `SELECT e.*, u.phone_number, u.full_name
     FROM payroll_schedule_entries e JOIN users u ON e.user_id = u.id
     WHERE e.schedule_id=$1 AND e.active ORDER BY e.id`,
    [scheduleId]
  )).rows;
  if (!entries.length) throw badge('Hakuna walengwa kwenye ratiba.', 400);

  const brackets = sched.tax_brackets || (sched.merchant_id ? DEFAULT_PAYE : []);

  const computed = entries.map((e) => {
    const { bonus, deductions } = deduceAdjustments(e.adjustments);
    const gross = Number(e.base_amount) + bonus;
    const tax = e.taxable ? computeProgressiveTax(gross, brackets) : 0;
    const net = Math.round((gross - tax - deductions) * 100) / 100;
    return { ...e, gross, bonus, deductions, tax, net,
             employeeName: e.full_name || null, employeePhone: e.phone_number || null };
  });

  const netTotal  = computed.reduce((s, c) => s + c.net, 0);
  const taxTotal  = computed.reduce((s, c) => s + c.tax, 0);
  const grossTotal = computed.reduce((s, c) => s + c.gross, 0);

  if (!sched.merchant_id) {
    const wallet = (await pool.query('SELECT balance FROM treasury_wallets WHERE id=$1 FOR UPDATE', [sched.treasury_wallet_id])).rows[0];
    if (!wallet || Number(wallet.balance) < netTotal)
      throw badge('Salio la mkoba wa hazina halitoshi kwa malipo.', 400);
  } else {
    const acct = await pool.query('SELECT id, balance FROM connected_merchant_accounts WHERE merchant_id=$1 FOR UPDATE', [sched.merchant_id]);
    if (!acct.rows[0] || Number(acct.rows[0].balance) < netTotal)
      throw badge('Salio la biashara halitoshi kwa malipo.', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = (await client.query(
      `INSERT INTO payroll_runs (schedule_id, treasury_wallet_id, merchant_id, funding_source,
                                 period_start, period_end, status, total_amount, net_total, tax_total, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [scheduleId, sched.treasury_wallet_id || null, sched.merchant_id || null,
       sched.merchant_id ? 'MERCHANT' : 'TREASURY',
       periodStart, endOfDay(periodEnd).split('T')[0],
       approveImmediately ? 'APPROVED' : 'PENDING_APPROVAL',
       grossTotal, netTotal, taxTotal, null]
    )).rows[0];

    for (const c of computed) {
      await client.query(
        `INSERT INTO payroll_payslips (run_id, user_id, base_amount, adjustments_total,
                                       gross_amount, tax_amount, deductions_total, net_amount,
                                       employee_name, employee_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [run.id, c.user_id, c.base_amount, Number(c.bonus) - Number(c.deductions),
         c.gross, c.tax, c.deductions, c.net, c.employeeName, c.employeePhone]
      );
    }

    await client.query('COMMIT');
    return { success: true, run,
             payslips: computed.map(c => ({ user_id: c.user_id, net: c.net, tax: c.tax })) };
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
}

function endOfDay(dateStr) {
  return dateStr ? `${dateStr}T23:59:59` : new Date().toISOString().slice(0, 10) + 'T23:59:59';
}

async function approveAndPayRun(runId, approverId) {
  const run = (await pool.query('SELECT * FROM payroll_runs WHERE id=$1', [runId])).rows[0];
  if (!run) throw badge('Run haipatikani.', 404);
  if (run.status !== 'PENDING_APPROVAL') throw badge('Run hii haiko kwenye hali ya kuidhinishwa.', 400);

  const payslips = (await pool.query('SELECT * FROM payroll_payslips WHERE run_id=$1 ORDER BY id', [runId])).rows;
  if (!payslips.length) throw badge('Hakuna payslip kwenye run hii.', 400);

  if (run.funding_source === 'MERCHANT') {
    const acct = (await pool.query(
      'SELECT * FROM connected_merchant_accounts WHERE merchant_id=$1 FOR UPDATE', [run.merchant_id]
    )).rows[0];
    if (!acct || Number(acct.balance) < Number(run.net_total)) throw badge('Salio la biashara halitoshi.', 400);
  } else {
    const wallet = (await pool.query(
      'SELECT balance FROM treasury_wallets WHERE id=$1 FOR UPDATE', [run.treasury_wallet_id]
    )).rows[0];
    if (!wallet || Number(wallet.balance) < Number(run.net_total)) throw badge('Salio la hazina halitoshi.', 400);
  }

  const results = [];
  let failuresOnly = true;

  for (const ps of payslips) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ref = generateReference('PAY');

      if (run.funding_source === 'MERCHANT') {
        await client.query(
          `UPDATE connected_merchant_accounts
           SET balance = balance - $1, updated_at = NOW()
           WHERE id = (SELECT id FROM connected_merchant_accounts WHERE merchant_id=$2 FOR UPDATE) AND balance >= $1`,
          [ps.net_amount, run.merchant_id]
        );
        await fin.creditWallet({ client, userId: ps.user_id, amount: ps.net_amount, reference: ref,
                                 fromAccount: 'MERCHANT_BALANCE',
                                 description: `Merchant payroll ${run.id}`, actor: `payroll:run-${runId}` });
      } else {
        await client.query('UPDATE treasury_wallets SET balance = balance - $1 WHERE id = $2',
                           [ps.net_amount, run.treasury_wallet_id]);
        await fin.creditWallet({ client, userId: ps.user_id, amount: ps.net_amount, reference: ref,
                                 fromAccount: 'SUSPENSE',
                                 description: `Payroll ${run.id}`, actor: `payroll:run-${runId}` });
      }

      await client.query(
        `UPDATE payroll_payslips
         SET status='PAID', ledger_ref=$1, paid_at=NOW(), employee_name=COALESCE(employee_name,$2), employee_phone=COALESCE(employee_phone,$3)
         WHERE id=$4`,
        [ref, ps.employee_name || null, ps.employee_phone || null, ps.id]
      );

      await client.query('COMMIT');
      failuresOnly = false;
      results.push({ user_id: ps.user_id, net: ps.net_amount, ledger_ref: ref, paid: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      results.push({ user_id: ps.user_id, net: ps.net_amount, paid: false, error: err.message });
    } finally { client.release(); }
  }

  const paidCount = results.filter(r => r.paid).length;
  const status = paidCount === payslips.length ? 'PAID' : paidCount > 0 ? 'PARTIAL' : 'FAILED';

  await pool.query('UPDATE payroll_runs SET status=$1, approved_by=$2 WHERE id=$3',
                   [status, approverId, runId]);

  await logAudit({
    eventType: 'PAYROLL_RUN', action: 'PAY', entityType: 'PAYROLL_RUN',
    userId: approverId, referenceId: `PAYROLL-${runId}`,
    amount: Number(run.net_total),
    afterData: { run_id: runId, paid: paidCount, total: payslips.length, status, funding: run.funding_source }
  }).catch(() => {});

  return { success: true, status, results };
}

async function listRuns(scheduleId, { merchantId } = {}) {
  const res = await pool.query(
    `SELECT r.*, s.name AS schedule_name,
            (SELECT COUNT(*)::int FROM payroll_payslips p WHERE p.run_id = r.id) AS recipients
     FROM payroll_runs r JOIN payroll_schedules s ON r.schedule_id = s.id
     WHERE ($1::int IS NULL OR r.schedule_id = $1)
       AND ($2::int IS NULL OR r.merchant_id = $2)
     ORDER BY r.created_at DESC`,
    [scheduleId || null, merchantId || null]
  );
  return res.rows;
}

async function listPayslipsForUser(userId) {
  const res = await pool.query(
    `SELECT p.*, r.period_start, r.period_end, s.name AS schedule_name, s.merchant_id, m.name AS merchant_name
     FROM payroll_payslips p
     JOIN payroll_runs r ON p.run_id = r.id
     JOIN payroll_schedules s ON r.schedule_id = s.id
     LEFT JOIN merchants m ON s.merchant_id = m.id
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
  createSchedule, listSchedules, addScheduleEntry, pauseSchedule, assertScheduleOwnership,
  runPayroll, approveAndPayRun, listRuns, listPayslipsForUser, listRunPayslips,
  DEFAULT_PAYE, merchantForUser,
};
