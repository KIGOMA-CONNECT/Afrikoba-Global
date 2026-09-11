/**
 * SACCOS Digital Core - Fund Management + Loan-Loss Reserves
 * (increment 9).
 *
 * 1) Fund buckets: OWNER/BOARD create per-SACCOS LIABILITY ledger
 *    accounts `SACCOS<id>_FUND_<CODE>`; ACTIVE members contribute
 *    (`debitWallet` DR CUSTOMER_WALLET / CR fund account, txn
 *    SACCOS_FUND_CONTRIBUTION, FNC-*); OWNER/BOARD transfer
 *    balance between funds (balanced journal DR from / CR to,
 *    reference FTF-*). Funds with residual balance cannot archive.
 *
 * 2) Loan-loss reserves: provision expected losses on a disbursed
 *    loan once (UNIQUE(saccos_id, loan_id)) — DR
 *    `SACCOS<id>_LOAN_LOSS_EXPENSE`(EXPENSE) / CR
 *    `SACCOS<id>_LOAN_LOSS_RESERVES`(LIABILITY), LLR-*;
 *    release reverses the journal. Provisions surface immediately
 *    in the accounting income statement (ledger-computed).
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function fundAccountCode(saccosId, code) {
  return `SACCOS${saccosId}_FUND_${code}`;
}

function loanLossExpenseCode(saccosId) {
  return `SACCOS${saccosId}_LOAN_LOSS_EXPENSE`;
}

function loanLossReserveCode(saccosId) {
  return `SACCOS${saccosId}_LOAN_LOSS_RESERVES`;
}

async function requireAdminOrActive(actorId, saccosId) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  if (isPlatformAdmin) return { membership: null };
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return { membership };
}

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function fetchFund(saccosId, fundId) {
  const r = await pool.query('SELECT * FROM saccos_funds WHERE id = $1 AND saccos_id = $2', [fundId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_FUND_NOT_FOUND');
  return r.rows[0];
}

async function fundBalance(client, accountCode) {
  const r = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE -amount END), 0)::numeric AS balance
     FROM journal_entries je
     JOIN ledger_accounts la ON la.id = je.account_id
     WHERE la.account_code = $1`,
    [accountCode]
  );
  return Number(r.rows[0].balance);
}

async function createFund(actorId, saccosId, { code, name, purpose, targetAmount, minimumBalance }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const clean = (name || '').trim();
  const codeClean = (code || '').trim().toUpperCase();
  const target = Number(targetAmount) || 0;
  const minBal = Number(minimumBalance) || 0;
  if (!/^[A-Z0-9_]{2,24}$/.test(codeClean)) throw createAppError('SACCOS_FUND_CODE');
  if (!clean) throw createAppError('SACCOS_FUND_CODE');
  if (target < 0) throw createAppError('SACCOS_FUND_TARGET');
  if (minBal < 0) throw createAppError('SACCOS_FUND_TARGET');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT id FROM saccos_funds WHERE saccos_id = $1 AND code = $2', [saccosId, codeClean]);
    if (dup.rows.length) throw createAppError('SACCOS_FUND_EXISTS');
    await client.query(
      `INSERT INTO ledger_accounts (account_code, name, account_type)
       VALUES ($1, $2, 'LIABILITY') ON CONFLICT (account_code) DO NOTHING`,
      [fundAccountCode(saccosId, codeClean), `SACCOS #${saccosId} Fund ${codeClean}`]
    );
    const r = await client.query(
      `INSERT INTO saccos_funds (saccos_id, reference_id, code, name, purpose, account_code, target_amount, minimum_balance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [saccosId, newRef('FND'), codeClean, clean, purpose || null, fundAccountCode(saccosId, codeClean), target, minBal, actorId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_FUND_CREATED', { referenceId: saccosId, details: { fundId: r.rows[0].id, code: codeClean } }).catch(() => {});
    return { ...r.rows[0], target_amount: Number(r.rows[0].target_amount), minimum_balance: Number(r.rows[0].minimum_balance), balance: 0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listFunds(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query('SELECT * FROM saccos_funds WHERE saccos_id = $1 ORDER BY created_at ASC', [saccosId]);
  const out = [];
  for (const f of r.rows) {
    const b = await fundBalance(pool, f.account_code);
    out.push({ ...f, target_amount: Number(f.target_amount), minimum_balance: Number(f.minimum_balance), balance: b });
  }
  return out;
}

async function archiveFund(actorId, saccosId, fundId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const fund = await fetchFund(saccosId, fundId);
  if (fund.status !== 'ACTIVE') throw createAppError('SACCOS_FUND_STATE');
  const b = await fundBalance(pool, fund.account_code);
  if (b !== 0) throw createAppError('SACCOS_FUND_HAS_BALANCE');
  const r = await pool.query("UPDATE saccos_funds SET status = 'ARCHIVED', updated_at = NOW() WHERE id = $1 RETURNING *", [fundId]);
  await logAudit(actorId, 'SACCOS_FUND_ARCHIVED', { referenceId: saccosId, details: { fundId } }).catch(() => {});
  return r.rows[0];
}

async function contributeFund(actorId, saccosId, fundId, amount) {
  const membership = await requireActiveMember(actorId, saccosId);
  const fund = await fetchFund(saccosId, fundId);
  if (fund.status !== 'ACTIVE') throw createAppError('SACCOS_FUND_STATE');
  const amountN = Number(amount);
  if (!(amountN > 0)) throw createAppError('SACCOS_FUND_AMOUNT');

  const reference = newRef('FNC');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [actorId]);
    if (Number(w.rows[0].wallet_balance) < amountN) throw createAppError('WALLET_INSUFFICIENT_FUNDS');
    const debit = await fin.debitWallet({
      client, userId: actorId, amount: amountN,
      toAccount: fund.account_code,
      reference, description: `SACCOS #${saccosId} fund ${fund.code} contribution`, actor: 'saccos-funds',
    });
    if (debit.dedup) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    const c = await client.query(
      `INSERT INTO saccos_fund_contributions (saccos_id, member_id, fund_id, reference_id, amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [saccosId, membership.id, fundId, reference, amountN]
    );
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_FUND_CONTRIBUTION', $4)`,
      [reference, actorId, amountN, JSON.stringify({ saccosId, fundId, fundCode: fund.code })]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_FUND_CONTRIBUTED', { referenceId: saccosId, details: { reference, fundId, amount: amountN } }).catch(() => {});
    return { ...c.rows[0], amount: Number(c.rows[0].amount) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function transferFund(actorId, saccosId, { fromFundId, toFundId, amount, reason }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const from = await fetchFund(saccosId, fromFundId);
  const to = await fetchFund(saccosId, toFundId);
  if (from.status !== 'ACTIVE' || to.status !== 'ACTIVE') throw createAppError('SACCOS_FUND_STATE');
  if (from.id === to.id) throw createAppError('SACCOS_FUND_SAME');
  const amountN = Number(amount);
  if (!(amountN > 0)) throw createAppError('SACCOS_FUND_AMOUNT');

  const reference = newRef('FTF');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fromBal = await fundBalance(client, from.account_code);
    if (fromBal < amountN) throw createAppError('SACCOS_FUND_INSUFFICIENT');
    const op = await fin.claimOperation({ client, operationType: 'SACCOS_FUND_TRANSFER', reference, userId: actorId, amount: amountN });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    await fin.postJournal({
      client,
      lines: [
        { accountCode: from.account_code, direction: 'DR', amount: amountN },
        { accountCode: to.account_code, direction: 'CR', amount: amountN },
      ],
      referenceId: reference, description: `SACCOS #${saccosId} fund transfer ${from.code} -> ${to.code}`, postedBy: 'saccos-funds',
    });
    await client.query(
      `INSERT INTO saccos_fund_transfers (saccos_id, reference_id, from_fund_id, to_fund_id, amount, reason, authorized_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [saccosId, reference, from.id, to.id, amountN, reason || null, actorId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_FUND_TRANSFERRED', { referenceId: saccosId, details: { reference, fromFundId: from.id, toFundId: to.id, amount: amountN } }).catch(() => {});
    return { success: true, reference, amount: amountN, from_balance: fromBal - amountN };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listTransfers(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    `SELECT t.*, f.code AS from_code, g.code AS to_code
     FROM saccos_fund_transfers t
     JOIN saccos_funds f ON f.id = t.from_fund_id
     JOIN saccos_funds g ON g.id = t.to_fund_id
     WHERE t.saccos_id = $1 ORDER BY t.executed_at DESC`,
    [saccosId]
  );
  return r.rows.map((x) => ({ ...x, amount: Number(x.amount) }));
}

async function myContributions(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT c.*, f.code, f.name FROM saccos_fund_contributions c
     JOIN saccos_funds f ON f.id = c.fund_id
     WHERE c.member_id = $1 AND c.saccos_id = $2 ORDER BY c.created_at DESC`,
    [membership.id, saccosId]
  );
  return r.rows.map((x) => ({ ...x, amount: Number(x.amount) }));
}

async function fundsSummary(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const funds = await listFunds(actorId, saccosId);
  return {
    fund_count: funds.length,
    active_funds: funds.filter((f) => f.status === 'ACTIVE').length,
    total_balance: funds.reduce((s, f) => s + f.balance, 0),
    funds,
  };
}

async function provisionLoanLoss(actorId, saccosId, { loanId, amount, ratePercent }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const loan = await pool.query('SELECT * FROM saccos_loans WHERE id = $1 AND saccos_id = $2', [loanId, saccosId]);
  if (!loan.rows.length) throw createAppError('SACCOS_LOAN_NOT_FOUND');
  const amountN = Number(amount);
  if (!(amountN > 0)) throw createAppError('SACCOS_LLR_AMOUNT');
  const rate = ratePercent !== undefined ? Number(ratePercent) : 0;
  if (!(rate >= 0)) throw createAppError('SACCOS_LLR_AMOUNT');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT id FROM saccos_loan_loss_reserves WHERE saccos_id = $1 AND loan_id = $2', [saccosId, loanId]);
    if (dup.rows.length) throw createAppError('SACCOS_LLR_EXISTS');
    await client.query(
      `INSERT INTO ledger_accounts (account_code, name, account_type)
       VALUES ($1, $2, 'EXPENSE'), ($3, $4, 'LIABILITY')
       ON CONFLICT (account_code) DO NOTHING`,
      [loanLossExpenseCode(saccosId), `SACCOS #${saccosId} Loan-Loss Expense`,
       loanLossReserveCode(saccosId), `SACCOS #${saccosId} Loan-Loss Reserves`]
    );
    const reference = newRef('LLR');
    const op = await fin.claimOperation({ client, operationType: 'SACCOS_LOAN_LOSS_PROVISION', reference, userId: actorId, amount: amountN });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    await fin.postJournal({
      client,
      lines: [
        { accountCode: loanLossExpenseCode(saccosId), direction: 'DR', amount: amountN },
        { accountCode: loanLossReserveCode(saccosId), direction: 'CR', amount: amountN },
      ],
      referenceId: reference, description: `SACCOS #${saccosId} loan-loss provision on ${loan.rows[0].reference_id}`, postedBy: 'saccos-funds',
    });
    const r = await client.query(
      `INSERT INTO saccos_loan_loss_reserves (saccos_id, loan_id, reference_id, provision_amount, provision_rate_percent, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [saccosId, loanId, reference, amountN, rate, actorId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LLR_PROVISIONED', { referenceId: saccosId, details: { reference, loanId, amount: amountN } }).catch(() => {});
    return { ...r.rows[0], provision_amount: Number(r.rows[0].provision_amount), provision_rate_percent: Number(r.rows[0].provision_rate_percent) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function releaseLoanLoss(actorId, saccosId, llrId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const llr = await pool.query('SELECT * FROM saccos_loan_loss_reserves WHERE id = $1 AND saccos_id = $2', [llrId, saccosId]);
  if (!llr.rows.length) throw createAppError('SACCOS_LLR_NOT_FOUND');
  if (llr.rows[0].status !== 'PROVISIONED') throw createAppError('SACCOS_LLR_STATE');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reference = newRef('LLR');
    const op = await fin.claimOperation({ client, operationType: 'SACCOS_LOAN_LOSS_RELEASE', reference, userId: actorId, amount: Number(llr.rows[0].provision_amount) });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    await fin.postJournal({
      client,
      lines: [
        { accountCode: loanLossReserveCode(saccosId), direction: 'DR', amount: Number(llr.rows[0].provision_amount) },
        { accountCode: loanLossExpenseCode(saccosId), direction: 'CR', amount: Number(llr.rows[0].provision_amount) },
      ],
      referenceId: reference, description: `SACCOS #${saccosId} loan-loss release`, postedBy: 'saccos-funds',
    });
    const r = await client.query(
      `UPDATE saccos_loan_loss_reserves SET status = 'RELEASED', released_at = NOW() WHERE id = $1 RETURNING *`,
      [llrId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LLR_RELEASED', { referenceId: saccosId, details: { llrId, reference } }).catch(() => {});
    return { ...r.rows[0], provision_amount: Number(r.rows[0].provision_amount) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listLoanLossReserves(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    `SELECT l.*, sl.reference_id AS loan_reference FROM saccos_loan_loss_reserves l
     JOIN saccos_loans sl ON sl.id = l.loan_id
     WHERE l.saccos_id = $1 ORDER BY l.created_at DESC`,
    [saccosId]
  );
  return r.rows.map((x) => ({ ...x, provision_amount: Number(x.provision_amount), provision_rate_percent: Number(x.provision_rate_percent) }));
}

async function loanLossSummary(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'PROVISIONED')::int AS provisioned,
            COUNT(*) FILTER (WHERE status = 'RELEASED')::int AS released,
            COALESCE(SUM(provision_amount) FILTER (WHERE status = 'PROVISIONED'), 0)::numeric AS provisioned_total
     FROM saccos_loan_loss_reserves WHERE saccos_id = $1`,
    [saccosId]
  );
  return { ...r.rows[0], provisioned_total: Number(r.rows[0].provisioned_total) };
}

module.exports = {
  createFund,
  listFunds,
  archiveFund,
  contributeFund,
  transferFund,
  listTransfers,
  myContributions,
  fundsSummary,
  provisionLoanLoss,
  releaseLoanLoss,
  listLoanLossReserves,
  loanLossSummary,
};