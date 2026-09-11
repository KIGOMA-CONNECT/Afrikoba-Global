/**
 * SACCOS Digital Core - Credit (increment 4).
 * Member loan life-cycle ledgered on the shared double-entry core
 * (financialEngine) so SACCOS credit is not off-ledger:
 *   disburse -> DR SACCOS<id>_LOANS_RECEIVABLE (ASSET) / CR CUSTOMER_WALLET
 *   repay    -> DR CUSTOMER_WALLET / CR SACCOS<id>_LOANS_RECEIVABLE (principal)
 *                             / CR SACCOS<id>_INTEREST_INCOME (REVENUE, interest)
 * Flat interest: total_repayable = principal * (1 + rate%/100 * termMonths/12).
 * Repayments split principal/interest proportionally to the loan mix
 * (deterministic, always balanced); the loan closes at zero outstanding.
 * Config (saccos.config.lending): {interestRate, minAmount, maxAmount,
 * maxTermMonths, maxActiveLoans, autoDisburse}. Isolation: per-SACCOS
 * ASSET/REVENUE codes; non-member reads 404.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

const DEFAULT_LENDING_CONFIG = {
  interestRate: 12,
  minAmount: 10000,
  maxAmount: null,
  maxTermMonths: 12,
  maxActiveLoans: 1,
  autoDisburse: true,
  graceDays: 0,
  lateFeePercent: 2,
};

function lendingConfig(saccos) {
  const c = (saccos.config && saccos.config.lending) || {};
  return { ...DEFAULT_LENDING_CONFIG, ...c };
}

function loansReceivableCode(saccosId) {
  return `SACCOS${saccosId}_LOANS_RECEIVABLE`;
}
function interestIncomeCode(saccosId) {
  return `SACCOS${saccosId}_INTEREST_INCOME`;
}
function lateFeeIncomeCode(saccosId) {
  return `SACCOS${saccosId}_LATE_FEE_INCOME`;
}

function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function fetchActiveOrg(actorId, saccosId) {
  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  if (org.rows[0].status !== 'ACTIVE') throw createAppError('SACCOS_SHARES_NOT_ACTIVE');
  return org.rows[0];
}

async function ensureCreditAccounts(client, saccosId) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type) VALUES ($1, $2, 'ASSET')
     ON CONFLICT (account_code) DO NOTHING`,
    [loansReceivableCode(saccosId), `SACCOS #${saccosId} Loans Receivable`]
  );
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type) VALUES ($1, $2, 'REVENUE')
     ON CONFLICT (account_code) DO NOTHING`,
    [interestIncomeCode(saccosId), `SACCOS #${saccosId} Interest Income`]
  );
}

/** Credit a member wallet from a SACCOS account: DR <fromAccount> / CR CUSTOMER_WALLET. */
async function creditFromSaccos({ client, userId, amount, reference, fromAccount, description, actor, txnType }) {
  const amountN = Number(amount);
  const op = await fin.claimOperation({ client, operationType: 'CREDIT', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };
  const before = Number((await client.query('SELECT wallet_balance FROM users WHERE id = $1', [userId])).rows[0].wallet_balance);
  await fin.postJournal({
    client,
    lines: [
      { accountCode: fromAccount, direction: 'DR', amount: amountN },
      { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });
  await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amountN, userId]);
  await client.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', $4, $5)`,
    [reference, userId, amountN, txnType, JSON.stringify({ description })]
  );
  return { success: true, reference, amount: amountN, balanceBefore: before, balanceAfter: before + amountN };
}

/** Debit a member wallet into a SACCOS account: DR CUSTOMER_WALLET / CR <toAccount> (multi-credit allowed). */
async function debitToSaccos({ client, userId, amount, reference, toAccounts, description, actor, txnType }) {
  const amountN = Number(amount);
  const op = await fin.claimOperation({ client, operationType: 'DEBIT', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };
  const before = Number((await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0].wallet_balance);
  if (before < amountN) throw createAppError('WALLET_INSUFFICIENT_FUNDS');
  await fin.postJournal({
    client,
    lines: [
      { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
      ...toAccounts.map((a) => ({ accountCode: a.code, direction: 'CR', amount: a.amount })),
    ],
    referenceId: reference, description, postedBy: actor,
  });
  await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amountN, userId]);
  await client.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', $4, $5)`,
    [reference, userId, amountN, txnType, JSON.stringify({ description })]
  );
  return { success: true, reference, amount: amountN, balanceBefore: before, balanceAfter: before - amountN };
}

/** Flat-interest math: principal, rate %, termMonths -> {interest, total}. */
function repaymentMath(principal, rate, termMonths, amount) {
  const interest = round2((Number(principal) * Number(rate) / 100) * Number(termMonths) / 12);
  const total = round2(Number(principal) + interest);
  const pay = Math.min(Number(amount), total);
  const principalPart = round2(pay * (total > 0 ? Number(principal) / total : 0));
  const interestPart = round2(pay - principalPart);
  return { interest, total, pay, principalPart, interestPart };
}

async function fetchApplication(saccosId, applicationId) {
  const r = await pool.query(
    'SELECT * FROM saccos_loan_applications WHERE id = $1 AND saccos_id = $2',
    [applicationId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_APPLICATION_NOT_FOUND');
  return r.rows[0];
}

async function fetchLoan(saccosId, loanId) {
  const r = await pool.query('SELECT * FROM saccos_loans WHERE id = $1 AND saccos_id = $2', [loanId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_NOT_FOUND');
  return r.rows[0];
}

async function countActiveLoans(saccosId, memberId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM saccos_loans WHERE saccos_id = $1 AND member_id = $2 AND status = 'ACTIVE'`,
    [saccosId, memberId]
  );
  return r.rows[0].c;
}

async function applyLoan(actorId, saccosId, { amount, termMonths, purpose }) {
  const value = Number(amount);
  const term = Number(termMonths);
  if (!Number.isFinite(value) || value <= 0) throw createAppError('SACCOS_LOAN_AMOUNT_INVALID');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const membership = await requireActiveMember(actorId, saccosId);
  const cfg = lendingConfig(saccos);
  if (value < cfg.minAmount) throw createAppError('SACCOS_LOAN_BELOW_MIN');
  if (cfg.maxAmount !== null && value > cfg.maxAmount) throw createAppError('SACCOS_LOAN_ABOVE_MAX');
  if (!Number.isInteger(term) || term < 1 || term > cfg.maxTermMonths) throw createAppError('SACCOS_LOAN_TERM_TOO_LONG');
  if (await countActiveLoans(saccosId, membership.id) >= cfg.maxActiveLoans) throw createAppError('SACCOS_LOANS_AT_LIMIT');

  const ref = newRef('SCL');
  const app = await pool.query(
    `INSERT INTO saccos_loan_applications (saccos_id, member_id, reference_id, requested_amount, purpose, term_months, status, requires_approval)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', TRUE) RETURNING *`,
    [saccosId, membership.id, ref, value, purpose || null, term]
  );
  await logAudit(actorId, 'SACCOS_LOAN_APPLICATION', { referenceId: saccosId, details: { applicationId: app.rows[0].id, amount: value } }).catch(() => {});
  return app.rows[0];
}

async function disburseInClient({ client, saccos, loan, actorId }) {
  const cfg = lendingConfig(saccos);
  const ref = loan.reference_id;
  const member = await client.query('SELECT user_id FROM saccos_members WHERE id = $1', [loan.member_id]);
  if (!member.rows.length) throw createAppError('SACCOS_MEMBER_NOT_FOUND');
  const userId = member.rows[0].user_id;
  await ensureCreditAccounts(client, saccos.id);
  await creditFromSaccos({
    client, userId, amount: Number(loan.principal), reference: ref,
    fromAccount: loansReceivableCode(saccos.id),
    description: `Mkopo SACCOS #${saccos.id}`, actor: 'saccos:credit:disburse',
    txnType: 'SACCOS_LOAN_DISBURSEMENT',
  });
  await client.query(
    `UPDATE saccos_loans SET status = 'ACTIVE', disbursed_at = NOW() WHERE id = $1`,
    [loan.id]
  );
  await client.query(
    `UPDATE saccos_loan_applications SET status = 'DISBURSED', disbursed_at = NOW() WHERE id = $1`,
    [loan.application_id]
  );
  return { userId, cfg };
}

async function decideApplication(actorId, saccosId, applicationId, decision) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const app = await fetchApplication(saccosId, applicationId);
  if (app.status !== 'PENDING') throw createAppError('SACCOS_LOAN_APPLICATION_DECIDED');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = lendingConfig(saccos);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (decision === 'REJECT') {
      await client.query(
        `UPDATE saccos_loan_applications SET status = 'REJECTED', decided_by = $1, decision_at = NOW() WHERE id = $2`,
        [actorId, applicationId]
      );
    } else {
      const { interest, total } = repaymentMath(app.requested_amount, cfg.interestRate, app.term_months, app.requested_amount);
      const loan = await client.query(
        `INSERT INTO saccos_loans
           (saccos_id, member_id, application_id, reference_id, principal, interest_rate, total_repayable, amount_outstanding, term_months, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')
         RETURNING *`,
        [saccosId, app.member_id, app.id, newRef('LNS'), app.requested_amount, cfg.interestRate, total, total, app.term_months]
      );
      await client.query(
        `UPDATE saccos_loan_applications SET status = 'APPROVED', decided_by = $1, decision_at = NOW(), loan_id = $2 WHERE id = $3`,
        [actorId, loan.rows[0].id, applicationId]
      );
      if (cfg.autoDisburse) {
        await disburseInClient({ client, saccos, loan: loan.rows[0], actorId });
      }
    }
    await client.query('COMMIT');
    await logAudit(actorId, decision === 'APPROVE' ? 'SACCOS_LOAN_APPROVED' : 'SACCOS_LOAN_REJECTED', { referenceId: saccosId, details: { applicationId } }).catch(() => {});
    return { success: true, applicationId, decision, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function disburseLoan(actorId, saccosId, loanId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const loan = await fetchLoan(saccosId, loanId);
  if (loan.status !== 'PENDING') throw createAppError('SACCOS_LOAN_NOT_DISBURSABLE');
  const saccos = await fetchActiveOrg(actorId, saccosId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await disburseInClient({ client, saccos, loan, actorId });
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LOAN_DISBURSED', { referenceId: saccosId, details: { loanId } }).catch(() => {});
    return { success: true, loanId, status: 'ACTIVE' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function repayLoan(actorId, saccosId, loanId, { amount }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw createAppError('SACCOS_LOAN_AMOUNT_INVALID');
  const membership = await requireActiveMember(actorId, saccosId);
  const loan = await fetchLoan(saccosId, loanId);
  if (loan.status === 'CLOSED') throw createAppError('SACCOS_LOAN_ALREADY_CLOSED');
  if (loan.member_id !== membership.id) throw createAppError('SACCOS_RBAC');
  if (Number(loan.amount_outstanding) <= 0) throw createAppError('SACCOS_LOAN_ALREADY_CLOSED');

  const { pay, principalPart, interestPart } = repaymentMath(
    loan.principal, loan.interest_rate, loan.term_months, value
  );
  if (value > Number(loan.amount_outstanding)) throw createAppError('SACCOS_LOAN_REPAY_EXCEEDS');

  const ref = newRef('REP');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureCreditAccounts(client, saccosId);
    await debitToSaccos({
      client, userId: actorId, amount: pay, reference: ref,
      toAccounts: [
        { code: loansReceivableCode(saccosId), amount: principalPart },
        { code: interestIncomeCode(saccosId), amount: interestPart },
      ],
      description: `Rejesho la mkopo SACCOS #${saccosId}`, actor: 'saccos:credit:repay',
      txnType: 'SACCOS_LOAN_REPAYMENT',
    });
    const outstanding = round2(Number(loan.amount_outstanding) - pay);
    await client.query(
      `UPDATE saccos_loans SET amount_outstanding = $1, status = CASE WHEN $2 <= 0 THEN 'CLOSED' ELSE status END, repaid_at = CASE WHEN $2 <= 0 THEN NOW() ELSE repaid_at END WHERE id = $3`,
      [outstanding, outstanding, loanId]
    );
    await client.query(
      `INSERT INTO saccos_loan_repayments (saccos_id, loan_id, member_id, reference_id, amount, principal_part, interest_part, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED')`,
      [saccosId, loanId, membership.id, ref, pay, principalPart, interestPart]
    );
    if (outstanding <= 0) {
      await client.query(`UPDATE saccos_loan_applications SET status = 'REPAID', repaid_at = NOW() WHERE id = $1`, [loan.application_id]);
    }
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LOAN_REPAYMENT', { referenceId: saccosId, details: { loanId, amount: pay } }).catch(() => {});
    return {
      reference: ref, amount: pay, principalPart, interestPart,
      outstanding, closed: outstanding <= 0,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listMyLoans(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const app = await pool.query(
    `SELECT id, reference_id, requested_amount, purpose, term_months, status, created_at
     FROM saccos_loan_applications WHERE saccos_id = $1 AND member_id = $2 ORDER BY created_at DESC`,
    [saccosId, membership.id]
  );
  const loans = await pool.query(
    `SELECT id, reference_id, principal, interest_rate, total_repayable, amount_outstanding, term_months, status, disbursed_at
     FROM saccos_loans WHERE saccos_id = $1 AND member_id = $2 ORDER BY created_at DESC`,
    [saccosId, membership.id]
  );
  return { applications: app.rows, loans: loans.rows };
}

async function listApplications(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query(
    `SELECT a.id, a.reference_id, a.requested_amount, a.purpose, a.term_months, a.status, a.requires_approval, a.decided_by, a.decision_at, a.disbursed_at, a.repaid_at, a.created_at,
            m.member_number, u.full_name, u.phone_number
     FROM saccos_loan_applications a
     JOIN saccos_members m ON m.id = a.member_id
     JOIN users u ON u.id = m.user_id
     WHERE a.saccos_id = $1
     ORDER BY a.created_at DESC`,
    [saccosId]
  );
  return r.rows;
}

async function listLoanRepayments(actorId, saccosId, loanId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const loan = await fetchLoan(saccosId, loanId);
  const r = await pool.query(
    `SELECT id, reference_id, amount, principal_part, interest_part, status, created_at
     FROM saccos_loan_repayments WHERE loan_id = $1 ORDER BY created_at DESC`,
    [loan.id]
  );
  return r.rows.map((row) => ({ ...row, amount: Number(row.amount), principal_part: Number(row.principal_part), interest_part: Number(row.interest_part) }));
}

async function creditSummary(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const org = await pool.query('SELECT config FROM saccos WHERE id = $1', [saccosId]);
  const cfg = lendingConfig(org.rows[0] || { config: {} });
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_loans,
            COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN amount_outstanding ELSE 0 END), 0) AS outstanding,
            COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN principal ELSE 0 END), 0) AS principal_outstanding
     FROM saccos_loans WHERE saccos_id = $1`,
    [saccosId]
  );
  const repaid = await pool.query(
    `SELECT COALESCE(SUM(principal_part), 0) AS principal_repaid, COALESCE(SUM(interest_part), 0) AS interest_earned
     FROM saccos_loan_repayments WHERE saccos_id = $1`,
    [saccosId]
  );
  const out = { ...r.rows[0], ...repaid.rows[0] };
  return {
    active_loans: Number(out.active_loans),
    outstanding: Number(out.outstanding),
    principal_outstanding: Number(out.principal_outstanding),
    principal_repaid: Number(out.principal_repaid),
    interest_earned: Number(out.interest_earned),
    interestRate: cfg.interestRate,
    currency: 'TZS',
  };
}

module.exports = {
  applyLoan,
  decideApplication,
  disburseLoan,
  repayLoan,
  listMyLoans,
  listApplications,
  listLoanRepayments,
  creditSummary,
  loansReceivableCode,
  interestIncomeCode,
  lateFeeIncomeCode,
  lendingConfig,
  repaymentMath,
  ensureCreditAccounts,
};