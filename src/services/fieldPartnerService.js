/**
 * FIELD PARTNER SERVICE (Kiva-style)
 * Field partners are local organizations that onboard borrowers, lend
 * from their PARTNER_BALANCE-backed pool, and record repayments.
 *
 * Money movement mirrors the rest of the platform:
 *   fund      : DR SUSPENSE        CR PARTNER_BALANCE   (+ pool projection)
 *   disburse  : DR PARTNER_BALANCE CR CUSTOMER_WALLET   (- pool, + borrower wallet)
 *   repay     : DR CUSTOMER_WALLET CR PARTNER_BALANCE   (+ pool, - borrower wallet)
 * All three are idempotent via financial_operations references and post
 * balanced journal groups through the financial engine primitives.
 */

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
const { createAppError } = require('../utils/errorCodes');
const fin = require('./financialEngine');
const logger = require('../utils/logger');

async function listPartners(activeOnly = true) {
  const rows = await pool.query(
    `SELECT id, name, country_code, region, risk_rating, trust_score,
            operator_name, phone_number, available_balance, total_loans_facilitated,
            active, user_id, created_at
     FROM field_partners
     ${activeOnly ? 'WHERE active = TRUE' : ''}
     ORDER BY name`
  );
  return rows.rows;
}

async function getPartner(id) {
  const r = await pool.query(`SELECT * FROM field_partners WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function getPartnerForUser(userId) {
  const r = await pool.query(
    `SELECT * FROM field_partners WHERE user_id = $1 AND active = TRUE`,
    [userId]
  );
  return r.rows[0] || null;
}

async function createPartner({ name, countryCode = 'TZ', region = null, riskRating = 'LOW', phoneNumber = null, operatorName = null }) {
  if (!name) throw createAppError('VALIDATION_ERROR', { field: 'name' });
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(riskRating)) throw createAppError('VALIDATION_ERROR', { field: 'riskRating' });
  const r = await pool.query(
    `INSERT INTO field_partners (name, country_code, region, risk_rating, phone_number, operator_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [name, countryCode, region, riskRating, phoneNumber, operatorName]
  );
  return r.rows[0];
}

async function updatePartner(partnerId, fields) {
  const allowed = ['name', 'country_code', 'region', 'risk_rating', 'phone_number', 'operator_name', 'active'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    return getPartner(partnerId);
  }
  params.push(partnerId);
  sets.push('updated_at = NOW()');
  const r = await pool.query(
    `UPDATE field_partners SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (r.rows.length === 0) throw createAppError('FIELD_PARTNER_NOT_FOUND');
  return r.rows[0];
}

/**
 * Bind a platform user as the partner's staff operator (role FIELD_PARTNER).
 * Only an individual account that is still a plain member is promoted.
 */
async function bindUser({ partnerId, userId }) {
  const partner = await getPartner(partnerId);
  if (!partner) throw createAppError('FIELD_PARTNER_NOT_FOUND');

  const user = await pool.query('SELECT id, role, is_active FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) throw createAppError('FP_BORROWER_NOT_FOUND');
  if (!user.rows[0].is_active) throw createAppError('AUTH_ACCOUNT_NOT_FOUND');

  const bind = await pool.query(
    `UPDATE field_partners SET user_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [userId, partnerId]
  );
  if (bind.rows.length === 0) throw createAppError('FIELD_PARTNER_NOT_FOUND');

  await pool.query(
    `UPDATE users SET role = 'FIELD_PARTNER', updated_at = NOW() WHERE id = $1 AND role = 'MJUMBE'`,
    [userId]
  );
  return bind.rows[0];
}

/**
 * Admin supplies the partner's lendable pool from SUSPENSE.
 * Idempotent on the supplied reference.
 */
async function fundPartner({ partnerId, amount, reference }) {
  const amountN = Number(amount);
  if (!(amountN > 0)) throw createAppError('VALIDATION_ERROR', { field: 'amount' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const partner = await getPartner(partnerId);
    if (!partner) throw createAppError('FIELD_PARTNER_NOT_FOUND');
    if (!partner.active) throw createAppError('FIELD_PARTNER_INACTIVE');

    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'SUSPENSE', direction: 'DR', amount: amountN },
        { accountCode: 'PARTNER_BALANCE', direction: 'CR', amount: amountN },
      ],
      referenceId: reference,
      description: `Field partner funding: ${partner.name}`,
      postedBy: 'engine:field_partner_fund',
    });

    await client.query(
      `UPDATE field_partners SET available_balance = available_balance + $1, updated_at = NOW() WHERE id = $2`,
      [amountN, partnerId]
    );
    await client.query('COMMIT');
    return { success: true, reference, funded: amountN, partnerId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FP_FUND', error.message, { partnerId });
    throw error;
  } finally {
    client.release();
  }
}

async function createLoan({ partnerId, borrowerUserId, amount, interestRate = 0, termMonths = 12, purpose = 'GENERAL' }) {
  const amountN = Number(amount);
  const rateN = Number(interestRate || 0);
  const termN = Number(termMonths || 12);
  if (!(amountN > 0)) throw createAppError('VALIDATION_ERROR', { field: 'amount' });
  if (rateN < 0) throw createAppError('VALIDATION_ERROR', { field: 'interestRate' });
  if (!(termN > 0)) throw createAppError('VALIDATION_ERROR', { field: 'termMonths' });

  const partner = await getPartner(partnerId);
  if (!partner) throw createAppError('FIELD_PARTNER_NOT_FOUND');
  if (!partner.active) throw createAppError('FIELD_PARTNER_INACTIVE');

  const borrower = await pool.query('SELECT id, is_active FROM users WHERE id = $1', [borrowerUserId]);
  if (borrower.rows.length === 0 || !borrower.rows[0].is_active) throw createAppError('FP_BORROWER_NOT_FOUND');

  const totalDue = Math.round(amountN * (1 + rateN / 100) * 100) / 100;
  const reference = generateReference('FPL');
  const r = await pool.query(
    `INSERT INTO field_partner_loans (field_partner_id, borrower_user_id, loan_reference, purpose, amount, interest_rate, term_months, total_due)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [partnerId, borrowerUserId, reference, purpose, amountN, rateN, termN, totalDue]
  );
  return r.rows[0];
}

async function disburseLoan({ loanId, partnerId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loan = await loanInTx(client, loanId);
    if (!loan) throw createAppError('FP_LOAN_NOT_FOUND');
    if (loan.field_partner_id !== partnerId) throw createAppError('FIELD_PARTNER_UNAUTHORIZED');
    if (loan.status !== 'PENDING') throw createAppError('FP_LOAN_STATUS_INVALID');

    const partner = await pool.query('SELECT * FROM field_partners WHERE id = $1 FOR UPDATE', [partnerId]);
    if (partner.rows.length === 0) throw createAppError('FIELD_PARTNER_NOT_FOUND');
    const p = partner.rows[0];
    if (!p.active) throw createAppError('FIELD_PARTNER_INACTIVE');

    const amountN = Number(loan.amount);
    const avail = Number(p.available_balance);
    if (avail < amountN) throw createAppError('FIELD_PARTNER_POOL_INSUFFICIENT');

    await fin.creditWallet({
      client,
      userId: loan.borrower_user_id,
      amount: amountN,
      reference: `${loan.loan_reference}:DSB`,
      fromAccount: 'PARTNER_BALANCE',
      description: `Field partner loan: ${loan.loan_reference}`,
      actor: 'engine:field_partner_disburse',
    });

    await client.query(
      `UPDATE field_partners SET available_balance = available_balance - $1,
              total_loans_facilitated = total_loans_facilitated + $1,
              updated_at = NOW() WHERE id = $2`,
      [amountN, partnerId]
    );
    await client.query(
      `UPDATE field_partner_loans SET status = 'DISBURSED', disbursed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [loanId]
    );
    await client.query('COMMIT');
    return { success: true, loanId, reference: `${loan.loan_reference}:DSB`, disbursed: amountN };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FP_DISBURSE', error.message, { loanId });
    throw error;
  } finally {
    client.release();
  }
}

async function recordRepayment({ loanId, partnerId, amount, note = null }) {
  const amountN = Number(amount);
  if (!(amountN > 0)) throw createAppError('VALIDATION_ERROR', { field: 'amount' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loan = await loanInTx(client, loanId);
    if (!loan) throw createAppError('FP_LOAN_NOT_FOUND');
    if (loan.field_partner_id !== partnerId) throw createAppError('FIELD_PARTNER_UNAUTHORIZED');
    if (loan.status !== 'DISBURSED') throw createAppError('FP_LOAN_STATUS_INVALID');

    const paidSoFar = Number((await paidInTx(client, loanId)).rows[0].paid || 0);
    const toDate = Math.round((paidSoFar + amountN) * 100) / 100;
    const totalDue = Number(loan.total_due);
    if (toDate > totalDue + 0.005) throw createAppError('FP_REPAYMENT_EXCEEDS_DUE');

    const repayRef = generateReference('FPR');
    const ledgerRef = `${loan.loan_reference}:REP:${repayRef}`;
    await fin.debitWallet({
      client,
      userId: loan.borrower_user_id,
      amount: amountN,
      reference: ledgerRef,
      toAccount: 'PARTNER_BALANCE',
      description: `Field partner repayment: ${loan.loan_reference}`,
      actor: 'engine:field_partner_repay',
    });

    await client.query(
      `INSERT INTO field_partner_repayments (loan_id, borrower_user_id, amount, reference, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [loanId, loan.borrower_user_id, amountN, repayRef, note]
    );
    await client.query(
      `UPDATE field_partners SET available_balance = available_balance + $1, updated_at = NOW() WHERE id = $2`,
      [amountN, partnerId]
    );

    const repaid = toDate >= totalDue - 0.005;
    await client.query(
      `UPDATE field_partner_loans SET status = $1, updated_at = NOW() WHERE id = $2`,
      [repaid ? 'REPAID' : 'DISBURSED', loanId]
    );
    await client.query('COMMIT');
    return { success: true, loanId, reference: ledgerRef, repaid: amountN, outstanding: Math.max(0, Math.round((totalDue - toDate) * 100) / 100), fullyRepaid: repaid };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FP_REPAY', error.message, { loanId });
    throw error;
  } finally {
    client.release();
  }
}

async function selfRepay({ loanId, userId, amount }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loan = await loanInTx(client, loanId);
    if (!loan) throw createAppError('FP_LOAN_NOT_FOUND');
    if (loan.borrower_user_id !== userId) throw createAppError('FIELD_PARTNER_UNAUTHORIZED');
    if (loan.status !== 'DISBURSED') throw createAppError('FP_LOAN_STATUS_INVALID');

    const amountN = Number(amount);
    if (!(amountN > 0)) throw createAppError('VALIDATION_ERROR', { field: 'amount' });

    const paidSoFar = Number((await paidInTx(client, loanId)).rows[0].paid || 0);
    const toDate = Math.round((paidSoFar + amountN) * 100) / 100;
    const totalDue = Number(loan.total_due);
    if (toDate > totalDue + 0.005) throw createAppError('FP_REPAYMENT_EXCEEDS_DUE');

    const repayRef = generateReference('FPR');
    const ledgerRef = `${loan.loan_reference}:REP:${repayRef}`;
    await fin.debitWallet({
      client,
      userId,
      amount: amountN,
      reference: ledgerRef,
      toAccount: 'PARTNER_BALANCE',
      description: `Field partner repayment (self): ${loan.loan_reference}`,
      actor: 'engine:field_partner_repay',
    });

    await client.query(
      `INSERT INTO field_partner_repayments (loan_id, borrower_user_id, amount, reference, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [loanId, userId, amountN, repayRef, 'self-serve repayment']
    );
    await client.query(
      `UPDATE field_partners SET available_balance = available_balance + $1, updated_at = NOW() WHERE id = $2`,
      [amountN, loan.field_partner_id]
    );

    const repaid = toDate >= totalDue - 0.005;
    await client.query(
      `UPDATE field_partner_loans SET status = $1, updated_at = NOW() WHERE id = $2`,
      [repaid ? 'REPAID' : 'DISBURSED', loanId]
    );
    await client.query('COMMIT');
    return { success: true, loanId, repaid: amountN, outstanding: Math.max(0, Math.round((totalDue - toDate) * 100) / 100), fullyRepaid: repaid };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FP_SELF_REPAY', error.message, { loanId });
    throw error;
  } finally {
    client.release();
  }
}

async function listLoans({ partnerId, status = null }) {
  const params = [partnerId];
  let where = 'l.field_partner_id = $1';
  if (status) {
    params.push(status);
    where += ` AND l.status = $${params.length}`;
  }
  const r = await pool.query(
    `SELECT l.id, l.field_partner_id, l.borrower_user_id, l.loan_reference, l.purpose,
            l.amount, l.interest_rate, l.term_months, l.total_due, l.status,
            l.disbursed_at, l.created_at,
            u.full_name AS borrower_name, u.phone_number AS borrower_phone,
            COALESCE(p.sum, 0) AS paid_amount
     FROM field_partner_loans l
     JOIN users u ON u.id = l.borrower_user_id
     LEFT JOIN (SELECT loan_id, SUM(amount) AS sum FROM field_partner_repayments GROUP BY loan_id) p
       ON p.loan_id = l.id
     WHERE ${where}
     ORDER BY l.created_at DESC`,
    params
  );
  return r.rows;
}

async function getBorrowerLoans(userId) {
  const r = await pool.query(
    `SELECT l.id, l.field_partner_id, l.loan_reference, l.purpose, l.amount,
            l.interest_rate, l.term_months, l.total_due, l.status, l.disbursed_at, l.created_at,
            fp.name AS partner_name,
            COALESCE(p.sum, 0) AS paid_amount
     FROM field_partner_loans l
     JOIN field_partners fp ON fp.id = l.field_partner_id
     LEFT JOIN (SELECT loan_id, SUM(amount) AS sum FROM field_partner_repayments GROUP BY loan_id) p
       ON p.loan_id = l.id
     WHERE l.borrower_user_id = $1
     ORDER BY l.created_at DESC`,
    [userId]
  );
  return r.rows;
}

async function getSummary(partnerId) {
  const r = await pool.query(
    `SELECT
       (SELECT available_balance FROM field_partners WHERE id = $1) AS available_balance,
       (SELECT total_loans_facilitated FROM field_partners WHERE id = $1) AS total_loans_facilitated,
       COUNT(*) FILTER (WHERE status = 'DISBURSED') AS active_loans,
       COUNT(*) FILTER (WHERE status = 'REPAID') AS repaid_loans,
       COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_loans,
       COUNT(*) FILTER (WHERE status = 'DEFAULTED') AS defaulted_loans,
       COALESCE(SUM(amount) FILTER (WHERE status = 'DISBURSED'), 0) AS outstanding_principal
     FROM field_partner_loans WHERE field_partner_id = $1`,
    [partnerId]
  );
  return r.rows[0];
}

async function loanInTx(client, loanId) {
  const r = await client.query('SELECT * FROM field_partner_loans WHERE id = $1 FOR UPDATE', [loanId]);
  return r.rows[0] || null;
}

async function paidInTx(client, loanId) {
  return client.query(`SELECT COALESCE(SUM(amount),0) AS paid FROM field_partner_repayments WHERE loan_id = $1`, [loanId]);
}

module.exports = {
  listPartners,
  getPartner,
  getPartnerForUser,
  createPartner,
  updatePartner,
  bindUser,
  fundPartner,
  createLoan,
  disburseLoan,
  recordRepayment,
  selfRepay,
  listLoans,
  getBorrowerLoans,
  getSummary,
};