const pool = require('../config/db');
const { queryTransactionStatus } = require('../services/azampayService');
const { sendSMS } = require('../services/smsService');
const { formatMoney } = require('../utils/helpers');
const fin = require('../services/financialEngine');
const logger = require('../utils/logger');

/**
 * RECONCILIATION ENGINE v2.0
 * Every 5 minutes:
 *   - reconcile PENDING deposits against AzamPay query-status API
 *   - settle PROCESSING withdrawals by gateway state (NEVER by blind timeout)
 *
 * SAFETY GUARANTEE (v2):
 *   - A withdrawal is only refunded (releaseHold) after the gateway EXPLICITLY
 *     reports FAILED. PENDING/UNKNOWN withdrawals become reconciliation
 *     EXCEPTIONS - they are never auto-refunded - so a customer can never be
 *     double-credited because their MNO may actually have paid them.
 *   - Deposits are only honoured after re-confirming, inside a fresh row lock,
 *     that the transaction is still PENDING (avoids racing the async callback
 *     and double-crediting).
 */

/**
 * Honour a single deposit. Opens its own connection/transaction so the
 * financial-engine postings and the business-status update are atomic and,
 * crucially, the earlier PENDING check is re-verified under a row lock.
 */
async function settleDeposit(tx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Row lock + re-check: if the async callback already moved this tx, skip.
    const claim = await client.query(
      `SELECT status FROM transactions WHERE id = $1 FOR UPDATE`, [tx.id]
    );
    if (claim.rows.length === 0 || claim.rows[0].status !== 'PENDING') {
      await client.query('COMMIT');
      return { skipped: true, reason: 'status_changed' };
    }

    const gateway = await queryTransactionStatus(tx.reference_id);

    if (gateway.status === 'SUCCESS') {
      // Idempotent - financial engine guards on reference_id.
      const posted = await fin.postDeposit({
        userId: tx.user_id,
        amount: tx.wallet_amount,
        commission: tx.commission,
        reference: tx.reference_id,
        externalTxId: null,
        description: 'Deposit confirmed (reconciliation)',
      });
      if (posted && posted.dedup) {
        // Already posted (e.g. callback succeeded). Just mark SUCCESS.
        await client.query(
          `UPDATE transactions SET status = 'SUCCESS', updated_at = NOW() WHERE id = $1`,
          [tx.id]
        );
        await client.query('COMMIT');
        return { dedup: true };
      }
      await client.query(
        `UPDATE transactions SET status = 'SUCCESS', external_tx_id = $1, updated_at = NOW() WHERE id = $2`,
        [gateway.data?.externalId || null, tx.id]
      );
      const { rows } = await client.query(
        'SELECT wallet_balance, phone_number, full_name FROM users WHERE id = $1', [tx.user_id]
      );
      const newBalance = rows[0].wallet_balance;
      await client.query('COMMIT');
      const smsMsg = `Habari ${rows[0].full_name}, deposit yako ya ${formatMoney(tx.wallet_amount)} imethibitishwa (Reconciliation). Salio: ${formatMoney(newBalance)}. Ref: ${tx.reference_id}`;
      await sendSMS(rows[0].phone_number, smsMsg).catch(() => {});
      return { success: true };
    }

    if (gateway.status === 'FAILED') {
      await client.query(
        `UPDATE transactions SET status = 'FAILED', failure_reason = 'Failed at gateway (recon)', updated_at = NOW() WHERE id = $1`,
        [tx.id]
      );
      await client.query('COMMIT');
      return { failed: true };
    }

    // PENDING / UNKNOWN. Open an exception after 15 minutes but never resolve
    // a deposit by guessing.
    const ageMinutes = (new Date() - new Date(tx.created_at)) / (1000 * 60);
    await client.query('COMMIT');
    if (ageMinutes > 15) {
      await fin.recordException({
        type: 'STALE_DEPOSIT',
        reference: tx.reference_id,
        transactionId: tx.id,
        detail: { gatewayStatus: gateway.status, ageMinutes },
      });
    }
    return { unresolved: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('RECON_DEPOSIT', error.message, { id: tx.id });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Settle a single withdrawal. Own connection/transaction. Only gateway state
 * drives the outcome - never a blind timeout.
 */
async function settleWithdrawal(tx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fresh = await client.query(
      `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [tx.id]
    );
    if (fresh.rows.length === 0 || fresh.rows[0].status !== 'PROCESSING') {
      await client.query('COMMIT');
      return { skipped: true };
    }

    const gateway = await queryTransactionStatus(tx.reference_id);

    if (gateway.status === 'SUCCESS') {
      await fin.captureHold({
        userId: tx.user_id,
        amount: tx.wallet_amount,
        accountCode: 'CUSTOMER_WALLET',
        reference: `${tx.reference_id}-CAPTURE`,
        description: 'Withdrawal settled (MNO paid)',
      });
      await client.query(
        `UPDATE transactions SET status = 'SUCCESS', updated_at = NOW() WHERE id = $1`,
        [tx.id]
      );
      await client.query('COMMIT');
      logger.info('RECON', `Withdrawal ${tx.reference_id} settled (gateway SUCCESS)`);
      return { settled: true };
    }

    if (gateway.status === 'FAILED') {
      await fin.releaseHold({
        userId: tx.user_id,
        amount: tx.wallet_amount,
        accountCode: 'CUSTOMER_WALLET',
        reference: `${tx.reference_id}-RELEASE`,
        description: 'Withdrawal failed - funds returned',
      });
      await client.query(
        `UPDATE transactions SET status = 'FAILED',
           failure_reason = 'Failed at gateway.',
           updated_at = NOW()
         WHERE id = $1`,
        [tx.id]
      );
      const { rows } = await client.query(
        `SELECT phone_number FROM users WHERE id = $1`, [tx.user_id]
      );
      await client.query('COMMIT');
      if (rows[0]) {
        const msg = `AFRIKOBA: Withdrawal yako ya ${formatMoney(tx.wallet_amount)} haijafanikiwa. Fedha zimerudishwa kwenye wallet yako. Ref: ${tx.reference_id}`;
        await sendSMS(rows[0].phone_number, msg).catch(() => {});
      }
      logger.info('RECON', `Withdrawal ${tx.reference_id} refunded (gateway FAILED)`);
      return { refunded: true };
    }

    // gateway PENDING/UNKNOWN -> DO NOT auto-refund. Surface as an exception.
    await client.query('COMMIT');
    await fin.recordException({
      type: 'STALE_WITHDRAWAL',
      reference: tx.reference_id,
      transactionId: tx.id,
      detail: { status: gateway.status },
    });
    logger.warn('RECON', `Withdrawal ${tx.reference_id} unresolved at gateway (${gateway.status}) - opened exception, not auto-refunded`);
    return { exception: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('RECON_WITHDRAW', error.message, { id: tx.id });
    throw error;
  } finally {
    client.release();
  }
}

async function reconcilePendingDeposits() {
  let checkedDeposits = 0;
  let processedWithdrawals = [];

  // 1) Deposits
  const dep = await pool.connect();
  try {
    const { rows: pending } = await dep.query(
      `SELECT t.id, t.reference_id, t.wallet_amount, t.commission, t.user_id, t.created_at
       FROM transactions t
       WHERE t.status = 'PENDING'
         AND t.type = 'DEPOSIT'
         AND t.created_at < NOW() - INTERVAL '3 minutes'
       LIMIT 20`
    );
    checkedDeposits = pending.length;
    for (const tx of pending) {
      await settleDeposit(tx);
    }
  } finally {
    dep.release();
  }

  // 2) Withdrawals - settle independently by gateway state.
  const wd = await pool.connect();
  try {
    const { rows: processingWithdrawals } = await wd.query(
      `SELECT * FROM transactions
       WHERE status = 'PROCESSING' AND type = 'WITHDRAWAL'
       ORDER BY created_at ASC
       LIMIT 20`
    );
    processedWithdrawals = processingWithdrawals.map((r) => ({ id: r.id, reference_id: r.reference_id }));
    for (const tx of processingWithdrawals) {
      await settleWithdrawal(tx);
    }
  } finally {
    wd.release();
  }

  return { checkedDeposits, processedWithdrawals };
}

module.exports = { reconcilePendingDeposits };
