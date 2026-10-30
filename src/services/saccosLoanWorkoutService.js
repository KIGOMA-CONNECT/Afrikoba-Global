/**
 * SACCOS Digital Core - Loan Workout (increment 17).
 * Restructure/reschedule, write-off (into loan-loss reserves) and
 * guarantor-driven arrears recovery, layered over saccosCreditService
 * and saccosInstallmentService.
 *
 * RESTRUCTURE (OWNER/BOARD): an ACTIVE loan with outstanding balance is
 * capitalised at `newRatePercent` over `newTermMonths` (flat interest,
 * same formula as credit). The unpaid installments are replaced by a
 * fresh amortisation schedule anchored after the paid ones, `principal`
 * becomes the capitalised balance so the repayment split math stays
 * consistent, and `schedule_version` increments. RST-* reference.
 *
 * WRITE-OFF (OWNER/BOARD): an ACTIVE loan with outstanding balance is
 * extinguished against the utilised loan-loss provision first and the
 * loan-loss EXPENSE for the un-provisioned shortfall:
 *   DR SACCOS<id>_LOAN_LOSS_RESERVES (min(provisioned, outstanding))
 *   DR SACCOS<id>_LOAN_LOSS_EXPENSE (shortfall)
 *   CR SACCOS<id>_LOANS_RECEIVABLE (outstanding)
 * on a WO-* claim. The LLR row turns UTILIZED, the loan and application
 * go WRITTEN_OFF, remaining installments are CANCELLED and any ACTIVE
 * guarantees are released. Subsequent repay/installment ops reject the
 * loan (SACCOS_LOAN_WRITTEN_OFF).
 *
 * GUARANTOR ARREARS PAYMENT (OWNER/BOARD): when an ACTIVE guaranteed
 * loan has OVERDUE installments, the governing body can charge the
 * guarantor's wallet for them (ascending order, REPI-* refs). The
 * guarantee is marked PAID_OUT with the amount it covered.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');
const credit = require('./saccosCreditService');
const installments = require('./saccosInstallmentService');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function loanLossExpenseCode(saccosId) {
  return `SACCOS${saccosId}_LOAN_LOSS_EXPENSE`;
}
function loanLossReserveCode(saccosId) {
  return `SACCOS${saccosId}_LOAN_LOSS_RESERVES`;
}

async function fetchLoan(saccosId, loanId, db = pool) {
  const r = await db.query('SELECT * FROM saccos_loans WHERE id = $1 AND saccos_id = $2', [loanId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_NOT_FOUND');
  return r.rows[0];
}

async function assertActiveOrg(saccosId) {
  const r = await pool.query('SELECT config FROM saccos WHERE id = $1 AND status = $2', [saccosId, 'ACTIVE']);
  if (!r.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  return r.rows[0];
}

/* ============================================================
 * RESTRUCTURE / RESCHEDULE
 * ============================================================ */

async function restructureLoan(actorId, saccosId, loanId, { newTermMonths, newRatePercent, reason }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const term = Math.floor(Number(newTermMonths));
  if (!Number.isInteger(term) || term < 1 || term > 120) throw createAppError('SACCOS_LOAN_RESTRUCTURE_TERM');
  const rate = Number(newRatePercent);
  if (!Number.isFinite(rate) || rate < 0) throw createAppError('SACCOS_LOAN_RESTRUCTURE_RATE');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loan = await fetchLoan(saccosId, loanId, client);
    if (loan.status !== 'ACTIVE') throw createAppError('SACCOS_LOAN_RESTRUCTURE_STATE');
    const outstanding = round2(Number(loan.amount_outstanding));
    if (outstanding <= 0) throw createAppError('SACCOS_LOAN_RESTRUCTURE_STATE');

    const paidCount = Number((await client.query(
      `SELECT COUNT(*)::int AS c FROM saccos_loan_installments WHERE loan_id = $1 AND status = 'PAID'`, [loanId]
    )).rows[0].c);

    await client.query(
      `DELETE FROM saccos_loan_installments WHERE loan_id = $1 AND status != 'PAID'`, [loanId]
    );

    const newTotal = round2(outstanding * (1 + (rate / 100) * (term / 12)));
    await client.query(
      `UPDATE saccos_loans
          SET principal = $1, interest_rate = $2, term_months = $3,
              total_repayable = $4, amount_outstanding = $4,
              schedule_version = schedule_version + 1
        WHERE id = $5`,
      [outstanding, rate, term, newTotal, loanId]
    );

    const parts = installments.buildScheduleParts(outstanding, newTotal, term);
    const base = new Date();
    for (let i = 0; i < parts.length; i += 1) {
      const due = new Date(base.getFullYear(), base.getMonth() + i + 1, 1);
      await client.query(
        `INSERT INTO saccos_loan_installments
           (saccos_id, loan_id, member_id, installment_no, due_date, principal_part, interest_part, total, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')`,
        [saccosId, loanId, loan.member_id, paidCount + i + 1, due, parts[i].principalPart, parts[i].interestPart, parts[i].total]
      );
    }

    const newVersion = Number(loan.schedule_version || 1) + 1;
    const ref = newRef('RST');
    const row = await client.query(
      `INSERT INTO saccos_loan_restructures
         (saccos_id, loan_id, reference_id, previous_principal, previous_rate, previous_term_months,
          previous_outstanding, new_principal, new_rate, new_term_months, new_total, reason, authorized_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [saccosId, loanId, ref,
       round2(Number(loan.principal)), round2(Number(loan.interest_rate)), Number(loan.term_months),
       outstanding, outstanding, rate, term, newTotal, reason || null, actorId]
    );
    const principalDelta = round2(outstanding - Number(loan.principal));
    if (principalDelta !== 0) {
      await credit.ensureCreditAccounts(client, saccosId);
      await client.query(
        `INSERT INTO ledger_accounts (account_code, name, account_type) VALUES ($1, $2, 'EXPENSE')
         ON CONFLICT (account_code) DO NOTHING`,
        [loanLossExpenseCode(saccosId), `SACCOS #${saccosId} Loan-Loss Expense`]
      );
      const principalDelta1 = Math.abs(principalDelta);
      await fin.postJournal({
        client,
        lines: principalDelta < 0
          ? [
              { accountCode: credit.loansReceivableCode(saccosId), direction: 'CR', amount: principalDelta1 },
              { accountCode: loanLossExpenseCode(saccosId), direction: 'DR', amount: principalDelta1 },
            ]
          : [
              { accountCode: credit.loansReceivableCode(saccosId), direction: 'DR', amount: principalDelta1 },
              { accountCode: loanLossExpenseCode(saccosId), direction: 'CR', amount: principalDelta1 },
            ],
        referenceId: ref,
        description: `Kubadilisha mkopo SACCOS #${saccosId} (principal adjustment)`,
        postedBy: 'saccos:loan:restructure',
      });
    }
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LOAN_RESTRUCTURED', {
      referenceId: saccosId,
      details: { reference: ref, loanId, previousOutstanding: outstanding, newTotal, newTermMonths: term, newRatePercent: rate },
    }).catch(() => {});
    return {
      reference: ref,
      previous_outstanding: outstanding,
      new_principal: outstanding,
      new_total: newTotal,
      new_rate: rate,
      new_term_months: term,
      schedule_version: newVersion,
      installments_rebuilt: parts.length,
      restructure: row.rows[0],
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listRestructures(actorId, saccosId, loanId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  await fetchLoan(saccosId, loanId);
  const r = await pool.query(
    `SELECT * FROM saccos_loan_restructures WHERE saccos_id = $1 AND loan_id = $2 ORDER BY created_at DESC`,
    [saccosId, loanId]
  );
  return r.rows.map((x) => ({
    ...x,
    previous_principal: Number(x.previous_principal), previous_rate: Number(x.previous_rate),
    previous_outstanding: Number(x.previous_outstanding), new_principal: Number(x.new_principal),
    new_rate: Number(x.new_rate), new_total: Number(x.new_total),
  }));
}

/* ============================================================
 * WRITE-OFF
 * ============================================================ */

async function writeOffLoan(actorId, saccosId, loanId, { reason }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  if (!reason || !String(reason).trim()) throw createAppError('SACCOS_LOAN_WRITE_OFF_REASON');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loan = await fetchLoan(saccosId, loanId, client);
    if (loan.status !== 'ACTIVE') throw createAppError('SACCOS_LOAN_WRITE_OFF_STATE');
    const outstanding = round2(Number(loan.amount_outstanding));
    if (outstanding <= 0) throw createAppError('SACCOS_LOAN_WRITE_OFF_STATE');

    await credit.ensureCreditAccounts(client, saccosId);
    await client.query(
      `INSERT INTO ledger_accounts (account_code, name, account_type)
       VALUES ($1, $2, 'EXPENSE'), ($3, $4, 'LIABILITY')
       ON CONFLICT (account_code) DO NOTHING`,
      [loanLossExpenseCode(saccosId), `SACCOS #${saccosId} Loan-Loss Expense`,
       loanLossReserveCode(saccosId), `SACCOS #${saccosId} Loan-Loss Reserves`]
    );

    const llr = await client.query(
      `SELECT * FROM saccos_loan_loss_reserves WHERE saccos_id = $1 AND loan_id = $2 AND status = 'PROVISIONED'`,
      [saccosId, loanId]
    );
    const provisioned = llr.rows.length ? round2(Number(llr.rows[0].provision_amount)) : 0;
    const paidPrincipal = round2(Number((await client.query(
      `SELECT COALESCE(SUM(principal_part), 0)::numeric AS p FROM saccos_loan_repayments WHERE loan_id = $1`, [loanId]
    )).rows[0].p));
    const principalOutstanding = round2(Math.max(0, Number(loan.principal) - paidPrincipal));
    const interestUnpaid = round2(Math.max(0, outstanding - principalOutstanding));
    const reservesUsed = Math.min(provisioned, principalOutstanding);
    const expenseUsed = round2(principalOutstanding - reservesUsed);
    const writtenPrincipal = round2(reservesUsed + expenseUsed);

    const ref = newRef('WO');
    const op = await fin.claimOperation({ client, operationType: 'SACCOS_LOAN_WRITE_OFF', reference: ref, userId: actorId, amount: outstanding });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference: ref };
    }

    const lines = [{ accountCode: credit.loansReceivableCode(saccosId), direction: 'CR', amount: writtenPrincipal }];
    if (reservesUsed > 0) lines.unshift({ accountCode: loanLossReserveCode(saccosId), direction: 'DR', amount: reservesUsed });
    if (expenseUsed > 0) lines.unshift({ accountCode: loanLossExpenseCode(saccosId), direction: 'DR', amount: expenseUsed });
    await fin.postJournal({
      client,
      lines,
      referenceId: ref, description: `SACCOS #${saccosId} loan write-off ${loan.reference_id}: ${String(reason).trim()}`, postedBy: 'saccos:workout:writeoff',
    });

    await client.query(
      `INSERT INTO saccos_loan_write_offs
         (saccos_id, loan_id, reference_id, previous_outstanding, reserves_used, expense_used, reason, authorized_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [saccosId, loanId, ref, outstanding, reservesUsed, expenseUsed, String(reason).trim(), actorId]
    );
    if (llr.rows.length) {
      await client.query(
        `UPDATE saccos_loan_loss_reserves SET status = 'UTILIZED', utilized_at = NOW() WHERE id = $1`,
        [llr.rows[0].id]
      );
    }
    await client.query(
      `UPDATE saccos_loans SET status = 'WRITTEN_OFF', amount_outstanding = 0 WHERE id = $1`, [loanId]
    );
    await client.query(
      `UPDATE saccos_loan_applications SET status = 'WRITTEN_OFF' WHERE id = $1`, [loan.application_id]
    );
    await client.query(
      `UPDATE saccos_loan_installments SET status = 'CANCELLED' WHERE loan_id = $1 AND status NOT IN ('PAID', 'CANCELLED')`, [loanId]
    );
    await credit.releaseGuaranteesForLoan(client, saccosId, loanId);

    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LOAN_WRITTEN_OFF', {
      referenceId: saccosId,
      details: { reference: ref, loanId, previousOutstanding: outstanding, reservesUsed, expenseUsed, reason: String(reason).trim() },
    }).catch(() => {});
    return {
      reference: ref,
      loanId,
      previous_outstanding: outstanding,
      principal_written_off: writtenPrincipal,
      interest_forgiven: interestUnpaid,
      reserves_used: reservesUsed,
      expense_used: expenseUsed,
      provisioned,
      status: 'WRITTEN_OFF',
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listWriteOffs(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const r = await pool.query(
    `SELECT w.*, sl.reference_id AS loan_reference
       FROM saccos_loan_write_offs w
       JOIN saccos_loans sl ON sl.id = w.loan_id
      WHERE w.saccos_id = $1 ORDER BY w.created_at DESC`,
    [saccosId]
  );
  return r.rows.map((x) => ({
    ...x,
    previous_outstanding: Number(x.previous_outstanding),
    reserves_used: Number(x.reserves_used),
    expense_used: Number(x.expense_used),
  }));
}

/* ============================================================
 * GUARANTOR ARREARS PAYMENT
 * ============================================================ */

async function payGuarantorArrears(actorId, saccosId, loanId, guaranteeId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loan = await fetchLoan(saccosId, loanId, client);
    if (loan.status !== 'ACTIVE') throw createAppError('SACCOS_LOAN_GUARANTOR_STATE');
    const gu = await client.query(
      `SELECT g.*, m.user_id AS guarantor_user_id
         FROM saccos_loan_guarantees g
         JOIN saccos_members m ON m.id = g.guarantor_member_id
        WHERE g.id = $1 AND g.saccos_id = $2 AND g.loan_id = $3`,
      [guaranteeId, saccosId, loanId]
    );
    if (!gu.rows.length) throw createAppError('SACCOS_LOAN_GUARANTOR_NOT_FOUND');
    const guarantee = gu.rows[0];
    if (guarantee.status !== 'ACTIVE') throw createAppError('SACCOS_LOAN_GUARANTOR_STATE');

    await credit.ensureCreditAccounts(client, saccosId);
    await installments.ensureLateFeeAccount(client, saccosId);
    const cfg = await installments.arrearsConfig(client, saccosId);
    await installments.markOverdue(client, saccosId, loan, cfg);

    const overdue = await client.query(
      `SELECT id FROM saccos_loan_installments
        WHERE saccos_id = $1 AND loan_id = $2 AND status = 'OVERDUE'
        ORDER BY installment_no ASC`,
      [saccosId, loanId]
    );
    if (!overdue.rows.length) throw createAppError('SACCOS_LOAN_GUARANTOR_NO_ARREARS');

    let totalPaid = 0;
    let totalLateFees = 0;
    const paid = [];
    for (const inst of overdue.rows) {
      const res = await installments.payInstallmentCore({
        client,
        saccosId,
        loan,
        installmentId: inst.id,
        cfg,
        payerUserId: guarantee.guarantor_user_id,
        repaymentMemberId: loan.member_id,
      });
      totalPaid = round2(totalPaid + res.amount);
      totalLateFees = round2(totalLateFees + (res.lateFee || 0));
      paid.push(res);
    }
    await client.query(
      `UPDATE saccos_loan_guarantees
          SET status = 'PAID_OUT', paid_amount = paid_amount + $1
        WHERE id = $2`,
      [totalPaid, guaranteeId]
    );
    const remaining = Number((await client.query(
      `SELECT COUNT(*)::int AS c FROM saccos_loan_installments
        WHERE saccos_id = $1 AND loan_id = $2 AND status NOT IN ('PAID', 'CANCELLED')`, [saccosId, loanId]
    )).rows[0].c);

    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_GUARANTOR_PAYMENT', {
      referenceId: saccosId,
      details: { loanId, guaranteeId, totalPaid, installmentsPaid: paid.length },
    }).catch(() => {});
    return {
      guaranteeId,
      loanId,
      installments_paid: paid.length,
      total_paid: totalPaid,
      late_fees: totalLateFees,
      references: paid.map((p) => p.reference),
      remaining_unpaid: remaining,
      guarantee_status: 'PAID_OUT',
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  restructureLoan,
  listRestructures,
  writeOffLoan,
  listWriteOffs,
  payGuarantorArrears,
  loanLossExpenseCode,
  loanLossReserveCode,
};