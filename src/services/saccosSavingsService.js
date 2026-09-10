/**
 * SACCOS Digital Core - Savings (increment 3).
 * Member savings deposits/withdrawals ledgered via the shared
 * double-entry core (financialEngine):
 *   deposit   -> debitWallet(user)  DR CUSTOMER_WALLET / CR SACCOS<id>_SAVINGS_LIABILITY
 *   withdraw  -> creditWallet(user) DR SACCOS<id>_SAVINGS_LIABILITY / CR CUSTOMER_WALLET
 * Withdrawals are auto-approved or OWNER/BOARD-gated
 * (config.savings.autoApproveWithdrawals). PENDING withdrawals
 * reserve funds (no journal + no credit) until approved;
 * rejections move nothing. Balance projections update only on
 * APPROVED releases so rejection is naturally free.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

const DEFAULT_SAVINGS_CONFIG = {
  savingsType: 'VOLUNTARY',
  minDeposit: 0,
  maxDeposit: null,
  minBalanceToRetain: 0,
  autoApproveWithdrawals: true,
};

function savingsConfig(saccos) {
  const c = (saccos.config && saccos.config.savings) || {};
  return { ...DEFAULT_SAVINGS_CONFIG, ...c };
}

function savingsLiabilityCode(saccosId) {
  return `SACCOS${saccosId}_SAVINGS_LIABILITY`;
}

function newSolarRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

async function fetchActiveOrg(actorId, saccosId) {
  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  if (org.rows[0].status !== 'ACTIVE') throw createAppError('SACCOS_SHARES_NOT_ACTIVE');
  return org.rows[0];
}

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function ensureSavingsLiability(client, saccosId) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type)
     VALUES ($1, $2, 'LIABILITY')
     ON CONFLICT (account_code) DO NOTHING`,
    [savingsLiabilityCode(saccosId), `SACCOS #${saccosId} Member Savings`]
  );
}

async function ensureMemberAccount(client, saccosId, membershipId, savingsType) {
  const member = await client.query('SELECT member_number FROM saccos_members WHERE id = $1', [membershipId]);
  const accountNo = `SAV-${saccosId}-${member.rows[0].member_number}`;
  const acc = await client.query(
    `INSERT INTO saccos_savings_accounts (saccos_id, member_id, account_no, account_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [saccosId, membershipId, accountNo, savingsType || 'VOLUNTARY']
  );
  return acc.rows[0];
}

async function getSavingsAccount(saccosId, membershipId) {
  const r = await pool.query(
    'SELECT a.*, m.member_number FROM saccos_savings_accounts a JOIN saccos_members m ON m.id = a.member_id WHERE a.saccos_id = $1 AND a.member_id = $2',
    [saccosId, membershipId]
  );
  return r.rows[0] || null;
}

async function pendingSum(savingsId) {
  const r = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS p FROM saccos_savings_withdrawals WHERE account_id = $1 AND status = $2',
    [savingsId, 'PENDING']
  );
  return Number(r.rows[0].p);
}

async function deposit(actorId, saccosId, { amount }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw createAppError('SACCOS_SAVINGS_AMOUNT_INVALID');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const membership = await requireActiveMember(actorId, saccosId);
  const cfg = savingsConfig(saccos);
  if (value < cfg.minDeposit) throw createAppError('SACCOS_SAVINGS_BELOW_MIN_DEPOSIT');
  if (cfg.maxDeposit !== null && value > cfg.maxDeposit) throw createAppError('SACCOS_SAVINGS_ABOVE_MAX_DEPOSIT');

  const ref = newSolarRef('SAV');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSavingsLiability(client, saccosId);
    const account = await ensureMemberAccount(client, saccosId, membership.id, cfg.savingsType);
    await fin.debitWallet({
      client, userId: actorId, amount: value, reference: ref,
      toAccount: savingsLiabilityCode(saccosId),
      description: `Amana ya akiba SACCOS #${saccosId}`, actor: 'saccos:savings:deposit',
    });
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_SAVINGS_DEPOSIT', $4)`,
      [ref, actorId, value, JSON.stringify({ saccosId, accountId: account.id })]
    );
    await client.query(
      `UPDATE saccos_savings_accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
      [value, account.id]
    );
    await client.query(
      `INSERT INTO saccos_savings_movements (saccos_id, member_id, account_id, reference_id, type, amount, status)
       VALUES ($1, $2, $3, $4, 'DEPOSIT', $5, 'APPROVED')`,
      [saccosId, membership.id, account.id, ref, value]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_SAVINGS_DEPOSIT', { referenceId: saccosId, details: { accountId: account.id, amount: value } }).catch(() => {});
    return { reference: ref, accountNo: account.account_no, balance: Number(account.balance) + value };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function withdraw(actorId, saccosId, { amount }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw createAppError('SACCOS_SAVINGS_AMOUNT_INVALID');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const membership = await requireActiveMember(actorId, saccosId);
  const cfg = savingsConfig(saccos);

  const account = await getSavingsAccount(saccosId, membership.id);
  const available = (account ? Number(account.balance) : 0) - cfg.minBalanceToRetain - await pendingSum(account ? account.id : 0);
  if (value > available) throw createAppError('SACCOS_SAVINGS_INSUFFICIENT');

  const auto = cfg.autoApproveWithdrawals !== false;
  const ref = newSolarRef('SWD');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSavingsLiability(client, saccosId);
    await ensureMemberAccount(client, saccosId, membership.id, cfg.savingsType);
    if (auto) {
      await fin.creditWallet({
        client, userId: actorId, amount: value, reference: ref,
        fromAccount: savingsLiabilityCode(saccosId),
        description: `Uondoaji wa akiba SACCOS #${saccosId}`, actor: 'saccos:savings:withdraw',
      });
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_SAVINGS_WITHDRAWAL', $4)`,
        [ref, actorId, value, JSON.stringify({ saccosId, accountId: account.id, autoApproved: true })]
      );
    }
    await client.query(
      `INSERT INTO saccos_savings_withdrawals (saccos_id, member_id, account_id, reference_id, amount, status, requires_approval, decided_by, decision_at, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [saccosId, membership.id, account.id, ref, value,
       auto ? 'APPROVED' : 'PENDING', !auto,
       auto ? actorId : null, auto ? new Date() : null, auto ? new Date() : null]
    );
    await client.query(
      `INSERT INTO saccos_savings_movements (saccos_id, member_id, account_id, reference_id, type, amount, status)
       VALUES ($1, $2, $3, $4, 'WITHDRAWAL', $5, $6)`,
      [saccosId, membership.id, account.id, ref, value, auto ? 'APPROVED' : 'PENDING']
    );
    if (auto) {
      await client.query(`UPDATE saccos_savings_accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2`, [value, account.id]);
    }
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_SAVINGS_WITHDRAWAL', { referenceId: saccosId, details: { amount: value, status: auto ? 'APPROVED' : 'PENDING' } }).catch(() => {});
    return { reference: ref, status: auto ? 'APPROVED' : 'PENDING', requiresApproval: !auto, newBalance: auto ? Number(account.balance) - value : Number(account.balance) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function fetchWithdrawal(saccosId, withdrawalId) {
  const r = await pool.query(
    `SELECT w.*, m.user_id AS member_user_id FROM saccos_savings_withdrawals w
     JOIN saccos_savings_accounts a ON a.id = w.account_id
     JOIN saccos_members m ON m.id = w.member_id
     WHERE w.id = $1 AND w.saccos_id = $2`,
    [withdrawalId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_SAVINGS_WITHDRAWAL_NOT_FOUND');
  return r.rows[0];
}

async function decideWithdrawal(actorId, saccosId, withdrawalId, decision) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const wd = await fetchWithdrawal(saccosId, withdrawalId);
  if (wd.status !== 'PENDING') throw createAppError('SACCOS_SAVINGS_DECIDED');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (decision === 'APPROVE') {
      const acct = await client.query('SELECT balance FROM saccos_savings_accounts WHERE id = $1', [wd.account_id]);
      if (Number(acct.rows[0].balance) < Number(wd.amount)) throw createAppError('SACCOS_SAVINGS_INSUFFICIENT');
      await fin.creditWallet({
        client, userId: wd.member_user_id, amount: Number(wd.amount), reference: wd.reference_id,
        fromAccount: savingsLiabilityCode(wd.saccos_id),
        description: `Uondoaji wa akiba SACCOS #${wd.saccos_id}`, actor: 'saccos:savings:withdraw:approve',
      });
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_SAVINGS_WITHDRAWAL', $4)`,
        [wd.reference_id, wd.member_user_id, Number(wd.amount), JSON.stringify({ saccosId: wd.saccos_id, accountId: wd.account_id, approvedBy: actorId })]
      );
      await client.query(
        `UPDATE saccos_savings_accounts SET balance = balance - $1, updated_at = NOW() WHERE id = $2`,
        [Number(wd.amount), wd.account_id]
      );
      await client.query(
        `UPDATE saccos_savings_withdrawals SET status = 'APPROVED', decided_by = $1, decision_at = NOW(), released_at = NOW() WHERE id = $2`,
        [actorId, withdrawalId]
      );
      await client.query(`UPDATE saccos_savings_movements SET status = 'APPROVED' WHERE reference_id = $1`, [wd.reference_id]);
    } else {
      await client.query(
        `UPDATE saccos_savings_withdrawals SET status = 'REJECTED', decided_by = $1, decision_at = NOW() WHERE id = $2`,
        [actorId, withdrawalId]
      );
      await client.query(`UPDATE saccos_savings_movements SET status = 'REJECTED' WHERE reference_id = $1`, [wd.reference_id]);
    }
    await client.query('COMMIT');
    await logAudit(actorId, decision === 'APPROVE' ? 'SACCOS_SAVINGS_WITHDRAWAL_APPROVED' : 'SACCOS_SAVINGS_WITHDRAWAL_REJECTED', { referenceId: saccosId, details: { withdrawalId } }).catch(() => {});
    return { success: true, withdrawalId, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listMySavings(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const account = await getSavingsAccount(saccosId, membership.id);
  if (!account) return { account: null, movements: [], pendingWithdrawals: 0 };
  const [movements, pend] = await Promise.all([
    pool.query(
      'SELECT id, reference_id, type, amount, status, created_at FROM saccos_savings_movements WHERE account_id = $1 ORDER BY created_at DESC LIMIT 25',
      [account.id]
    ),
    pool.query("SELECT COUNT(*)::int AS c FROM saccos_savings_withdrawals WHERE account_id = $1 AND status = 'PENDING'", [account.id]),
  ]);
  return {
    account: { ...account, balance: Number(account.balance) },
    movements: movements.rows,
    pendingWithdrawals: pend.rows[0].c,
  };
}

async function listSavingsAccounts(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query(
    `SELECT a.id, a.account_no, a.account_type, a.balance, m.member_number, u.full_name, u.phone_number
     FROM saccos_savings_accounts a
     JOIN saccos_members m ON m.id = a.member_id
     JOIN users u ON u.id = m.user_id
     WHERE a.saccos_id = $1
     ORDER BY a.account_no`,
    [saccosId]
  );
  return r.rows.map((row) => ({ ...row, balance: Number(row.balance) }));
}

async function savingsSummary(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS total_deposits,
            COALESCE(SUM(CASE WHEN type = 'WITHDRAWAL' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS total_withdrawals,
            COUNT(DISTINCT account_id)::int AS accounts
     FROM saccos_savings_movements WHERE saccos_id = $1`,
    [saccosId]
  );
  const bal = await pool.query('SELECT COALESCE(SUM(balance), 0) AS balance FROM saccos_savings_accounts WHERE saccos_id = $1', [saccosId]);
  return { ...r.rows[0], balance: Number(bal.rows[0].balance), currency: 'TZS' };
}

module.exports = {
  deposit,
  withdraw,
  decideWithdrawal,
  listMySavings,
  listSavingsAccounts,
  savingsSummary,
  savingsLiabilityCode,
};