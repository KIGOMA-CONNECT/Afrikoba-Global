/**
 * SACCOS Digital Core - Loan Installments & Interest Accrual (increment 12).
 * A per-loan amortisation schedule layered over the credit module.
 *
 * Schedule generation is deterministic and idempotent: for an ACTIVE
 * disbursed loan it writes term_months rows where the principal parts
 * sum exactly to the loan principal and the interest parts sum exactly
 * to total_repayable - principal (last instalment absorbs rounding).
 * The schedule is materialised lazily on first read (so already-
 * disbursed loans get it automatically) or on-demand by OWNER/BOARD via
 * POST :/loans/:loanId/installments/generate.
 *
 * Payment (member pays own loan; OWNER/BOARD may pay any member loan):
 *   claimOperation('DEBIT', REPI-*, ...) -> journal
 *     DR CUSTOMER_WALLET (total)
 *     CR SACCOS<id>_LOANS_RECEIVABLE (principal_part)
 *     CR SACCOS<id>_INTEREST_INCOME (interest_part)
 *   amount_outstanding -= total, loan CLOSED at zero (application REPAID).
 * Installments must be paid in order; a later one is rejected until all
 * earlier ones are PAID (SACCOS_LOAN_INSTALLMENT_ORDER).
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');
const credit = require('./saccosCreditService');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function lateFeeIncomeCode(saccosId) {
  return `SACCOS${saccosId}_LATE_FEE_INCOME`;
}

/** Shared per-installment late-fee REVENUE account (idempotent). */
async function ensureLateFeeAccount(client, saccosId) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type) VALUES ($1, $2, 'REVENUE')
     ON CONFLICT (account_code) DO NOTHING`,
    [lateFeeIncomeCode(saccosId), `SACCOS #${saccosId} Late Fee Income`]
  );
}

/** Resolve saccos.config.lending (graceDays/lateFeePercent defaults from credit). */
async function arrearsConfig(client, saccosId) {
  const r = await client.query('SELECT config FROM saccos WHERE id = $1', [saccosId]);
  return credit.lendingConfig({ config: (r.rows[0] || {}).config });
}

/**
 * Flip PENDING installments whose due date has passed the grace window
 * to OVERDUE, accruing days_late + late_fee. Deterministic per day;
 * re-running refreshes the same values (fee grows only as days pass).
 */
async function markOverdue(client, saccosId, loan, cfg) {
  const r = await client.query(
    `UPDATE saccos_loan_installments
        SET status = 'OVERDUE',
            days_late = (CURRENT_DATE - due_date)::int,
            late_fee = ROUND(total * ($1::numeric / 100.0) * CEIL((CURRENT_DATE - due_date)::numeric / 30.0), 2)
      WHERE saccos_id = $2 AND loan_id = $3 AND status = 'PENDING'
        AND due_date < (CURRENT_DATE - $4::int)
      RETURNING id, installment_no, total, days_late, late_fee`,
    [Number(cfg.lateFeePercent) || 2, saccosId, loan.id, Number(cfg.graceDays) || 0]
  );
  return r.rows;
}

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function fetchLoan(saccosId, loanId) {
  const r = await pool.query('SELECT * FROM saccos_loans WHERE id = $1 AND saccos_id = $2', [loanId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_NOT_FOUND');
  return r.rows[0];
}

/** Resolve the loan's owner as { memberId (saccos_members.id), userId (users.id) }. */
async function loanOwner(client, saccosId, loanMemberId) {
  const r = await client.query(
    'SELECT id AS member_id, user_id FROM saccos_members WHERE id = $1 AND saccos_id = $2',
    [loanMemberId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  return r.rows[0];
}

/**
 * Split principal/interest evenly across term_months, last row absorbs
 * rounding so parts sum exactly to principal and total interest.
 */
function buildScheduleParts(principal, totalRepayable, term) {
  const principalN = round2(principal);
  const totalN = round2(totalRepayable);
  const interestTotal = round2(totalN - principalN);
  const terms = Math.max(1, Math.floor(Number(term)));
  const basePr = Math.floor((principalN / terms) * 100) / 100;
  const baseInt = Math.floor((interestTotal / terms) * 100) / 100;
  const parts = [];
  let prSum = 0;
  let intSum = 0;
  for (let i = 0; i < terms; i += 1) {
    const isLast = i === terms - 1;
    const pr = isLast ? round2(principalN - prSum) : basePr;
    const int = isLast ? round2(interestTotal - intSum) : baseInt;
    parts.push({ principalPart: pr, interestPart: round2(int), total: round2(pr + int) });
    prSum = round2(prSum + pr);
    intSum = round2(intSum + int);
  }
  return parts;
}

/** Materialise the schedule for a loan if not already present. Returns rows. */
async function ensureSchedule(client, saccosId, loan) {
  const existing = await client.query(
    'SELECT 1 FROM saccos_loan_installments WHERE loan_id = $1 LIMIT 1',
    [loan.id]
  );
  if (existing.rows.length) {
    return client.query(
      'SELECT * FROM saccos_loan_installments WHERE loan_id = $1 ORDER BY installment_no',
      [loan.id]
    ).then((r) => r.rows);
  }
  const parts = buildScheduleParts(loan.principal, loan.total_repayable, loan.term_months);
  const disbursed = loan.disbursed_at ? new Date(loan.disbursed_at) : new Date();
  const rows = [];
  for (let i = 0; i < parts.length; i += 1) {
    const due = new Date(disbursed);
    due.setMonth(due.getMonth() + i + 1);
    due.setDate(1);
    const p = parts[i];
    const inserted = await client.query(
      `INSERT INTO saccos_loan_installments
         (saccos_id, loan_id, member_id, installment_no, due_date,
          principal_part, interest_part, total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')
       RETURNING *`,
      [saccosId, loan.id, loan.member_id, i + 1, due, p.principalPart, p.interestPart, p.total]
    );
    rows.push(inserted.rows[0]);
  }
  return rows;
}

async function fetchInstallment(q, saccosId, loanId, installmentId) {
  const r = await q.query(
    'SELECT * FROM saccos_loan_installments WHERE id = $1 AND saccos_id = $2 AND loan_id = $3',
    [installmentId, saccosId, loanId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_INSTALLMENT_NOT_FOUND');
  return r.rows[0];
}

/** Explicitly materialise (regenerate) a loan's schedule. OWNER/BOARD only. */
async function generateInstallments(actorId, saccosId, loanId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loan = await fetchLoan(saccosId, loanId);
    const existing = await client.query(
      'SELECT COUNT(*)::int AS c FROM saccos_loan_installments WHERE loan_id = $1',
      [loan.id]
    );
    if (existing.rows[0].c > 0) throw createAppError('SACCOS_LOAN_INSTALLMENTS_EXIST');
    const rows = await ensureSchedule(client, saccosId, loan);
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LOAN_INSTALLMENTS_GENERATE', {
      referenceId: saccosId,
      details: { loanId, count: rows.length },
    }).catch(() => {});
    return { loanId, count: rows.length, installments: rows };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** List a loan's installments (member reads own loan; OWNER/BOARD any). */
async function listInstallments(actorId, saccosId, loanId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const loan = await fetchLoan(saccosId, loanId);
  const governing = ['OWNER', 'BOARD'].includes(membership.role);
  if (loan.member_id !== membership.id && !governing) throw createAppError('SACCOS_RBAC');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfg = await arrearsConfig(client, saccosId);
    const rows = await ensureSchedule(client, saccosId, loan);
    await markOverdue(client, saccosId, loan, cfg);
    const fresh = await client.query(
      'SELECT * FROM saccos_loan_installments WHERE loan_id = $1 ORDER BY installment_no',
      [loan.id]
    );
    const live = fresh.rows;
    await client.query('COMMIT');
    const paid = live.filter((r) => r.status === 'PAID').reduce((a, r) => a + Number(r.total), 0);
    const due = live.filter((r) => r.status === 'PENDING').reduce((a, r) => a + Number(r.total), 0);
    return {
      loanId,
      memberId: loan.member_id,
      outstanding: Number(loan.amount_outstanding),
      total: Number(loan.total_repayable),
      installments: live,
      summary: {
        total: live.length,
        paid: paid,
        paidCount: live.filter((r) => r.status === 'PAID').length,
        due,
        overdue: live.filter((r) => r.status === 'OVERDUE').length,
        lateFees: round2(live.filter((r) => r.status === 'OVERDUE').reduce((a, r) => a + Number(r.late_fee), 0)),
      },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Pay one installment: idempotent REPI-* claim, ordered guard, ledgered.
 *  An OVERDUE installment also charges its accrued late_fee (one extra
 *  CR to SACCOS<id>_LATE_FEE_INCOME); the fee is income - it never
 *  reduces amount_outstanding. */
async function payInstallment(actorId, saccosId, loanId, installmentId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const governing = ['OWNER', 'BOARD'].includes(membership.role);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await credit.ensureCreditAccounts(client, saccosId);
    await ensureLateFeeAccount(client, saccosId);
const loan = await fetchLoan(saccosId, loanId);
    if (loan.status === 'CLOSED') throw createAppError('SACCOS_LOAN_ALREADY_CLOSED');
    if (loan.member_id !== membership.id && !governing) throw createAppError('SACCOS_RBAC');
    const cfg = await arrearsConfig(client, saccosId);
    await markOverdue(client, saccosId, loan, cfg);
    const inst = await fetchInstallment(client, saccosId, loanId, installmentId);
    if (inst.status === 'PAID') throw createAppError('SACCOS_LOAN_INSTALLMENT_ALREADY_PAID');
    const earlier = await client.query(
      'SELECT id FROM saccos_loan_installments WHERE loan_id = $1 AND installment_no < $2 AND status != \'PAID\' LIMIT 1',
      [loan.id, inst.installment_no]
    );
    if (earlier.rows.length) throw createAppError('SACCOS_LOAN_INSTALLMENT_ORDER');
    if (Number(loan.amount_outstanding) <= 0) throw createAppError('SACCOS_LOAN_ALREADY_CLOSED');

    const lateFee = inst.status === 'OVERDUE' ? round2(Number(inst.late_fee)) : 0;
    const amountN = round2(Number(inst.total) + lateFee);
    const owner = await loanOwner(client, saccosId, loan.member_id);
    const payerUserId = owner.user_id;
    const repaymentMemberId = owner.member_id;
    const ref = 'REPI-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const op = await fin.claimOperation({
      client, operationType: 'DEBIT', reference: ref, userId: payerUserId, amount: amountN,
    });
    if (!op.claimed) throw createAppError('SACCOS_LOAN_INSTALLMENT_ALREADY_PAID');

    const before = Number((await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [payerUserId])).rows[0].wallet_balance);
    if (before < amountN) throw createAppError('WALLET_INSUFFICIENT_FUNDS');
    const lines = [
      { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
      { accountCode: credit.loansReceivableCode(saccosId), direction: 'CR', amount: round2(inst.principal_part) },
      { accountCode: credit.interestIncomeCode(saccosId), direction: 'CR', amount: round2(inst.interest_part) },
    ];
    if (lateFee > 0) lines.push({ accountCode: lateFeeIncomeCode(saccosId), direction: 'CR', amount: lateFee });
    await fin.postJournal({
      client,
      lines,
      referenceId: ref, description: `Awamu ya mkopo SACCOS #${saccosId}`, postedBy: 'saccos:credit:installment:pay',
    });
    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amountN, payerUserId]);
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_LOAN_INSTALLMENT_PAYMENT', $4)`,
      [ref, payerUserId, amountN, JSON.stringify({ saccosId, loanId, installmentId, lateFee })]
    );
    await client.query(
      `INSERT INTO saccos_loan_repayments (saccos_id, loan_id, member_id, reference_id, amount, principal_part, interest_part, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED')`,
      [saccosId, loan.id, repaymentMemberId, ref, amountN, round2(inst.principal_part), round2(inst.interest_part)]
    );
    await client.query(
      `UPDATE saccos_loan_installments SET status = 'PAID', paid_at = NOW(), reference_id = $1 WHERE id = $2`,
      [ref, inst.id]
    );
    const outstanding = round2(Number(loan.amount_outstanding) - Number(inst.total));
    await client.query(
      `UPDATE saccos_loans SET amount_outstanding = $1, status = CASE WHEN $2 <= 0 THEN 'CLOSED' ELSE status END, repaid_at = CASE WHEN $2 <= 0 THEN NOW() ELSE repaid_at END WHERE id = $3`,
      [outstanding, outstanding, loan.id]
    );
    if (outstanding <= 0 && loan.application_id) {
      await client.query(`UPDATE saccos_loan_applications SET status = 'REPAID', repaid_at = NOW() WHERE id = $1`, [loan.application_id]);
    }
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LOAN_INSTALLMENT_PAYMENT', {
      referenceId: saccosId,
      details: { loanId, installmentId, amount: amountN, lateFee, reference: ref },
    }).catch(() => {});
    return {
      reference: ref, installmentId: inst.id, installmentNo: inst.installment_no,
      amount: amountN, lateFee, principalPart: round2(inst.principal_part), interestPart: round2(inst.interest_part),
      outstanding, closed: outstanding <= 0,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Accrue arrears across all ACTIVE loans. OWNER/BOARD only. */
async function recomputeArrears(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfg = await arrearsConfig(client, saccosId);
    const loans = await client.query(
      `SELECT id FROM saccos_loans WHERE saccos_id = $1 AND status = 'ACTIVE'`,
      [saccosId]
    );
    let changed = 0;
    for (const loan of loans.rows) {
      changed += (await markOverdue(client, saccosId, loan, cfg)).length;
    }
    const agg = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'OVERDUE')::int AS overdue,
              COALESCE(SUM(total) FILTER (WHERE status = 'OVERDUE'), 0) AS arrears_total,
              COALESCE(SUM(late_fee) FILTER (WHERE status = 'OVERDUE'), 0) AS late_fees_total
       FROM saccos_loan_installments WHERE saccos_id = $1`,
      [saccosId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_ARREARS_RECOMPUTE', {
      referenceId: saccosId,
      details: { loans: loans.rows.length, changed, overdue: Number(agg.rows[0].overdue) },
    }).catch(() => {});
    return {
      loans: loans.rows.length,
      changed,
      overdue: Number(agg.rows[0].overdue),
      arrears_total: Number(agg.rows[0].arrears_total),
      late_fees_total: Number(agg.rows[0].late_fees_total),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Entity-wide arrears snapshot (fresh mark-overdue on read). OWNER/BOARD only. */
async function arrearsSummary(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfg = await arrearsConfig(client, saccosId);
    const loans = await client.query(
      `SELECT id FROM saccos_loans WHERE saccos_id = $1 AND status = 'ACTIVE'`,
      [saccosId]
    );
    for (const loan of loans.rows) {
      await markOverdue(client, saccosId, loan, cfg);
    }
    const agg = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'OVERDUE')::int AS overdue,
              COUNT(*)::int AS total_installments,
              COALESCE(SUM(total) FILTER (WHERE status = 'OVERDUE'), 0) AS arrears_total,
              COALESCE(SUM(late_fee) FILTER (WHERE status = 'OVERDUE'), 0) AS late_fees_total
       FROM saccos_loan_installments WHERE saccos_id = $1`,
      [saccosId]
    );
    await client.query('COMMIT');
    return {
      overdue: Number(agg.rows[0].overdue),
      total_installments: Number(agg.rows[0].total_installments),
      arrears_total: Number(agg.rows[0].arrears_total),
      late_fees_total: Number(agg.rows[0].late_fees_total),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Loan-installment health per SACCOS. OWNER/BOARD only. */
async function installmentSummary(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const r = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid,
       COALESCE(SUM(total) FILTER (WHERE status = 'PENDING'), 0) AS due_total,
       COALESCE(SUM(total) FILTER (WHERE status = 'PAID'), 0) AS paid_total
     FROM saccos_loan_installments WHERE saccos_id = $1`,
    [saccosId]
  );
  return r.rows[0];
}

module.exports = {
  generateInstallments,
  listInstallments,
  payInstallment,
  installmentSummary,
  recomputeArrears,
  arrearsSummary,
  buildScheduleParts,
  ensureSchedule,
  fetchInstallment,
  markOverdue,
};