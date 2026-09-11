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

async function fetchInstallment(saccosId, loanId, installmentId) {
  const r = await pool.query(
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
    const rows = await ensureSchedule(client, saccosId, loan);
    await client.query('COMMIT');
    const paid = rows.filter((r) => r.status === 'PAID').reduce((a, r) => a + Number(r.total), 0);
    const due = rows.filter((r) => r.status === 'PENDING').reduce((a, r) => a + Number(r.total), 0);
    return {
      loanId,
      memberId: loan.member_id,
      outstanding: Number(loan.amount_outstanding),
      total: Number(loan.total_repayable),
      installments: rows,
      summary: { total: rows.length, paid: paid, paidCount: rows.filter((r) => r.status === 'PAID').length, due },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Pay one installment: idempotent REPI-* claim, ordered guard, ledgered. */
async function payInstallment(actorId, saccosId, loanId, installmentId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const governing = ['OWNER', 'BOARD'].includes(membership.role);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await credit.ensureCreditAccounts(client, saccosId);
const loan = await fetchLoan(saccosId, loanId);
    if (loan.status === 'CLOSED') throw createAppError('SACCOS_LOAN_ALREADY_CLOSED');
    if (loan.member_id !== membership.id && !governing) throw createAppError('SACCOS_RBAC');
    const inst = await fetchInstallment(saccosId, loanId, installmentId);
    if (inst.status === 'PAID') throw createAppError('SACCOS_LOAN_INSTALLMENT_ALREADY_PAID');
    const earlier = await client.query(
      'SELECT id FROM saccos_loan_installments WHERE loan_id = $1 AND installment_no < $2 AND status != \'PAID\' LIMIT 1',
      [loan.id, inst.installment_no]
    );
    if (earlier.rows.length) throw createAppError('SACCOS_LOAN_INSTALLMENT_ORDER');
    if (Number(loan.amount_outstanding) <= 0) throw createAppError('SACCOS_LOAN_ALREADY_CLOSED');

    const owner = await loanOwner(client, saccosId, loan.member_id);
    const payerUserId = owner.user_id;
    const repaymentMemberId = owner.member_id;
    const amountN = round2(inst.total);
    const ref = 'REPI-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const op = await fin.claimOperation({
      client, operationType: 'DEBIT', reference: ref, userId: payerUserId, amount: amountN,
    });
    if (!op.claimed) throw createAppError('SACCOS_LOAN_INSTALLMENT_ALREADY_PAID');

    const before = Number((await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [payerUserId])).rows[0].wallet_balance);
    if (before < amountN) throw createAppError('WALLET_INSUFFICIENT_FUNDS');
    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
        { accountCode: credit.loansReceivableCode(saccosId), direction: 'CR', amount: round2(inst.principal_part) },
        { accountCode: credit.interestIncomeCode(saccosId), direction: 'CR', amount: round2(inst.interest_part) },
      ],
      referenceId: ref, description: `Awamu ya mkopo SACCOS #${saccosId}`, postedBy: 'saccos:credit:installment:pay',
    });
    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amountN, payerUserId]);
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_LOAN_INSTALLMENT_PAYMENT', $4)`,
      [ref, payerUserId, amountN, JSON.stringify({ saccosId, loanId, installmentId })]
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
    const outstanding = round2(Number(loan.amount_outstanding) - amountN);
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
      details: { loanId, installmentId, amount: amountN, reference: ref },
    }).catch(() => {});
    return {
      reference: ref, installmentId: inst.id, installmentNo: inst.installment_no,
      amount: amountN, principalPart: round2(inst.principal_part), interestPart: round2(inst.interest_part),
      outstanding, closed: outstanding <= 0,
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
  buildScheduleParts,
  ensureSchedule,
  fetchInstallment,
};