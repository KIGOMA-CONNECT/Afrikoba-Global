/**
 * SACCOS Digital Core - Member Exit & Settlement (increment 10).
 * Closes the membership lifecycle: an ACTIVE member (never the OWNER)
 * settles book value in one atomic step and exits:
 *   - savings  creditWallet DR SACCOS<id>_SAVINGS_LIABILITY / CR wallet (SXC-*-:SAV)
 *   - shares   postJournal DR SACCOS<id>_SHARES_CAPITAL (EQUITY) / CR wallet (SXC-*-:SHR),
 *              holdings zeroed
 *   - dividends: every PENDING payout on DECLARED runs is paid now
 *                (DR SACCOS<id>_DIVIDEND_DISTRIBUTED / CR wallet on the
 *                payout's own DIVP-* ref, marked PAID so a later board
 *                distribution only pays remaining members)
 * Membership flips to EXITED atomically. One settlement per member.
 * Self-only by caller; ADMINs read the ledger (listExits).
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

function savingsLiabilityCode(saccosId) { return `SACCOS${saccosId}_SAVINGS_LIABILITY`; }
function sharesCapitalCode(saccosId) { return `SACCOS${saccosId}_SHARES_CAPITAL`; }
function dividendExpenseCode(saccosId) { return `SACCOS${saccosId}_DIVIDEND_DISTRIBUTED`; }

async function requireAdminOrActive(actorId, saccosId) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  if (isPlatformAdmin) return { membership: null };
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return { membership };
}

async function fetchMembership(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.user_id !== actorId) throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function settleAndExit(actorId, saccosId) {
  const membership = await fetchMembership(actorId, saccosId);
  if (membership.status !== 'ACTIVE') throw createAppError('SACCOS_MEMBER_STATUS_INVALID');
  if (membership.role === 'OWNER') throw createAppError('SACCOS_RBAC');
  const existing = await pool.query('SELECT id FROM saccos_member_exits WHERE saccos_id = $1 AND member_id = $2', [saccosId, membership.id]);
  if (existing.rows.length) throw createAppError('SACCOS_EXIT_ALREADY_SETTLED');

  const reference = newRef('SXC');
  const client = await pool.connect();
  let savingsSettled = 0;
  let shareCount = 0;
  let shareRedemption = 0;
  let dividendSettled = 0;

  try {
    await client.query('BEGIN');

    // 1. Savings balance back to the member's wallet - only the member's
    //    own deposit book value (their savings account), not the whole
    //    entity liability, which may include other members' funds.
    const ownSav = await client.query('SELECT balance FROM saccos_savings_accounts WHERE member_id = $1', [membership.id]);
    const sBalance = ownSav.rows.length ? Number(ownSav.rows[0].balance) : 0;
    if (sBalance > 0) {
      const ref = reference + ':SAV';
      const debit = await fin.creditWallet({
        client, userId: actorId, amount: sBalance,
        fromAccount: savingsLiabilityCode(saccosId),
        reference: ref, description: `SACCOS #${saccosId} exit savings settlement`, actor: 'saccos-exits',
      });
      if (debit.dedup) throw createAppError('SACCOS_EXIT_ALREADY_SETTLED');
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_EXIT_SAVINGS_SETTLEMENT', $4)`,
        [ref, actorId, sBalance, JSON.stringify({ saccosId, savingsSettled: sBalance })]
      );
      savingsSettled = sBalance;
    }

    // 2. Shares redemption at holdings book value.
    const holding = await client.query(
      'SELECT share_count, total_value FROM saccos_share_holdings WHERE saccos_id = $1 AND member_id = $2',
      [saccosId, membership.id]
    );
    if (holding.rows.length && Number(holding.rows[0].share_count) > 0) {
      shareCount = Number(holding.rows[0].share_count);
      shareRedemption = Number(holding.rows[0].total_value);
      const ref = reference + ':SHR';
      const op = await fin.claimOperation({ client, operationType: 'SACCOS_EXIT_SHARE_REDEMPTION', reference: ref, userId: actorId, amount: shareRedemption });
      if (!op.claimed) throw createAppError('SACCOS_EXIT_ALREADY_SETTLED');
      const beforeSh = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [actorId]);
      await fin.postJournal({
        client,
        lines: [
          { accountCode: sharesCapitalCode(saccosId), direction: 'DR', amount: shareRedemption },
          { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: shareRedemption },
        ],
        referenceId: ref, description: `SACCOS #${saccosId} exit share redemption`, postedBy: 'saccos-exits',
      });
      await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [shareRedemption, actorId]);
      await fin.auditBalance({ client, accountKind: 'USER_BALANCE', accountId: actorId, operation: 'exit_share_redemption', amount: shareRedemption, balanceBefore: Number(beforeSh.rows[0].wallet_balance), balanceAfter: Number(beforeSh.rows[0].wallet_balance) + shareRedemption, reference: ref, actor: 'saccos-exits' }).catch(() => {});
      await client.query(
        `UPDATE saccos_share_holdings SET share_count = 0, total_value = 0, avg_price = 0, updated_at = NOW() WHERE member_id = $1`,
        [membership.id]
      );
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_EXIT_SHARE_REDEMPTION', $4)`,
        [ref, actorId, shareRedemption, JSON.stringify({ saccosId, shareCount })]
      );
    }

    // 3. Pending dividend payouts on this member (DECLARED runs) paid on exit.
    await client.query(
      `INSERT INTO ledger_accounts (account_code, name, account_type)
       VALUES ($1, $2, 'EXPENSE') ON CONFLICT (account_code) DO NOTHING`,
      [dividendExpenseCode(saccosId), `SACCOS #${saccosId} Dividend Distributed`]
    );
    const pend = await client.query(
      `SELECT p.id, p.reference_id, p.amount FROM saccos_dividend_payouts p
       JOIN saccos_dividend_runs r ON r.id = p.run_id
       WHERE p.member_id = $1 AND p.saccos_id = $2 AND p.status = 'PENDING'`,
      [membership.id, saccosId]
    );
    for (const payout of pend.rows) {
      const amountN = Number(payout.amount);
      const op = await fin.claimOperation({ client, operationType: 'SACCOS_DIVIDEND_PAYOUT', reference: payout.reference_id, userId: actorId, amount: amountN });
      if (!op.claimed) continue;
      const before = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [actorId]);
      await fin.postJournal({
        client,
        lines: [
          { accountCode: dividendExpenseCode(saccosId), direction: 'DR', amount: amountN },
          { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
        ],
        referenceId: payout.reference_id, description: `SACCOS #${saccosId} exit dividend settlement`, postedBy: 'saccos-exits',
      });
      await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [amountN, actorId]);
      await fin.auditBalance({ client, accountKind: 'USER_BALANCE', accountId: actorId, operation: 'exit_dividend_settlement', amount: amountN, balanceBefore: Number(before.rows[0].wallet_balance), balanceAfter: Number(before.rows[0].wallet_balance) + amountN, reference: payout.reference_id, actor: 'saccos-exits' }).catch(() => {});
      await client.query(`UPDATE saccos_dividend_payouts SET status = 'PAID', paid_at = NOW() WHERE id = $1`, [payout.id]);
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_EXIT_DIVIDEND_SETTLEMENT', $4)`,
        [payout.reference_id, actorId, amountN, JSON.stringify({ saccosId, payoutId: payout.id })]
      );
      dividendSettled = Math.round((dividendSettled + amountN) * 100) / 100;
    }

    const total = Math.round((savingsSettled + shareRedemption + dividendSettled) * 100) / 100;
    await client.query(
      `INSERT INTO saccos_member_exits (saccos_id, member_id, reference_id, savings_settled, share_count_settled, share_redemption_amount, dividend_settled, total_settlement, settled_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [saccosId, membership.id, reference, savingsSettled, shareCount, shareRedemption, dividendSettled, total, actorId]
    );
    await client.query(
      `UPDATE saccos_members SET status = 'EXITED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [membership.id]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_EXIT_SETTLED', { referenceId: saccosId, details: { reference, memberId: membership.id, total, savingsSettled, shareRedemption, dividendSettled } }).catch(() => {});
    return {
      reference_id: reference,
      savings_settled: savingsSettled,
      share_count_settled: shareCount,
      share_redemption_amount: shareRedemption,
      dividend_settled: dividendSettled,
      total_settlement: total,
      member_number: membership.member_number,
      exited: true,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listExits(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    `SELECT e.*, m.member_number, u.full_name FROM saccos_member_exits e
     JOIN saccos_members m ON m.id = e.member_id
     JOIN users u ON u.id = m.user_id
     WHERE e.saccos_id = $1 ORDER BY e.settled_at DESC`,
    [saccosId]
  );
  return r.rows.map((x) => ({ ...x, savings_settled: Number(x.savings_settled), share_redemption_amount: Number(x.share_redemption_amount), dividend_settled: Number(x.dividend_settled), total_settlement: Number(x.total_settlement) }));
}

async function myExit(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.user_id !== actorId) throw createAppError('SACCOS_NOT_MEMBER');
  const r = await pool.query('SELECT * FROM saccos_member_exits WHERE saccos_id = $1 AND member_id = $2', [saccosId, membership.id]);
  if (!r.rows.length) throw createAppError('SACCOS_EXIT_NONE');
  return { ...r.rows[0], savings_settled: Number(r.rows[0].savings_settled), share_redemption_amount: Number(r.rows[0].share_redemption_amount), dividend_settled: Number(r.rows[0].dividend_settled), total_settlement: Number(r.rows[0].total_settlement) };
}

module.exports = {
  settleAndExit,
  listExits,
  myExit,
};