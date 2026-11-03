const pool = require('../config/db');
const config = require('../config');
const { queryTransactionStatus } = require('../services/azampayService');
const { classifyGatewayDeposit } = require('../services/depositVerification');
const { sendSMS } = require('../services/smsService');
const { formatMoney } = require('../utils/helpers');
const fin = require('../services/financialEngine');
const logger = require('../utils/logger');

// Longer than the token (15s) and dispatch (20s) request timeouts combined.
const DISPATCH_GRACE_MS = 10 * 60 * 1000;

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
  // Query the gateway before acquiring a database row lock.
  const gateway = await queryTransactionStatus(tx.reference_id);
  const verdict = classifyGatewayDeposit(gateway, {
    referenceId: tx.reference_id,
    expectedTotal: tx.total_charged,
    contractVerified: config.azampay.statusContractVerified,
  });

  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    const freshResult = await client.query(
      `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
      [tx.id]
    );

    if (
      freshResult.rows.length === 0 ||
      freshResult.rows[0].status !== 'PENDING'
    ) {
      await client.query('COMMIT');
      committed = true;
      return { skipped: true, reason: 'status_changed' };
    }

    const fresh = freshResult.rows[0];

    // Do not apply a gateway result to a changed transaction identity/amount.
    if (
      String(fresh.reference_id) !== String(tx.reference_id) ||
      Math.abs(Number(fresh.total_charged) - Number(tx.total_charged)) >= 0.005
    ) {
      await client.query('COMMIT');
      committed = true;
      return { skipped: true, reason: 'transaction_changed' };
    }

    if (verdict.decision === 'SUCCESS') {
      // Serialize callback and reconciliation settlement for this reference.
      await client.query(
        'SELECT pg_advisory_xact_lock(0, hashtext($1))',
        [fresh.reference_id]
      );

      const posted = await fin.postDeposit({
        client,
        transactionId: fresh.id,
        userId: fresh.user_id,
        amount: fresh.wallet_amount,
        commission: fresh.commission,
        reference: fresh.reference_id,
        externalTxId: gateway.data?.externalId || null,
        description: 'Deposit confirmed (reconciliation)',
      });

      if (posted && posted.dedup && posted.verified !== true) {
        const error = new Error(
          `Unverified reconciliation deposit duplicate: ${fresh.reference_id}`
        );
        error.code = 'DEPOSIT_IDEMPOTENCY_CONFLICT';
        throw error;
      }

      await client.query(
        `INSERT INTO wallet_ledger
           (transaction_id, reference_id, to_user_id, amount, description)
         VALUES ($1, $2, $3, $4, 'Deposit confirmed (reconciliation)')
         ON CONFLICT DO NOTHING`,
        [fresh.id, fresh.reference_id, fresh.user_id, fresh.wallet_amount]
      );

      const ledgerResult = await client.query(
        `SELECT transaction_id, reference_id, to_user_id, amount
           FROM wallet_ledger
          WHERE reference_id = $1
          ORDER BY id
          FOR UPDATE`,
        [fresh.reference_id]
      );

      const { verifyWalletLedgerRows } = require('../services/depositVerification');
      if (!verifyWalletLedgerRows(ledgerResult.rows, {
        referenceId: fresh.reference_id,
        transactionId: fresh.id,
        userId: fresh.user_id,
        amount: fresh.wallet_amount
      })) {
        const error = new Error(
          `Reconciliation wallet-ledger conflict: ${fresh.reference_id}`
        );
        error.code = 'DEPOSIT_LEDGER_CONFLICT';
        throw error;
      }

      const updated = await client.query(
        `UPDATE transactions
            SET status = 'SUCCESS', external_tx_id = $1, updated_at = NOW()
          WHERE id = $2 AND status = 'PENDING'`,
        [gateway.data?.externalId || null, fresh.id]
      );

      if (updated.rowCount !== 1) {
        throw new Error(`Reconciliation status transition failed: ${fresh.reference_id}`);
      }

      const userResult = await client.query(
        'SELECT wallet_balance, phone_number, full_name FROM users WHERE id = $1',
        [fresh.user_id]
      );
      if (!userResult.rows.length) {
        throw new Error(`Reconciliation user missing: ${fresh.user_id}`);
      }

      await client.query('COMMIT');
      committed = true;

      const user = userResult.rows[0];
      const smsMsg = `Habari ${user.full_name}, deposit yako ya ${formatMoney(fresh.wallet_amount)} imethibitishwa (Reconciliation). Salio: ${formatMoney(user.wallet_balance)}. Ref: ${fresh.reference_id}`;
      await sendSMS(user.phone_number, smsMsg).catch((smsErr) =>
        logger.error('RECON_DEPOSIT', `SMS failed: ${smsErr.message}`, { id: fresh.id })
      );

      return {
        success: true,
        dedup: Boolean(posted && posted.dedup)
      };
    }

    if (verdict.decision === 'FAILED') {
      const updated = await client.query(
        `UPDATE transactions
            SET status = 'FAILED',
                failure_reason = 'Failed at gateway (recon)',
                external_tx_id = $1,
                updated_at = NOW()
          WHERE id = $2 AND status = 'PENDING'`,
        [gateway.data?.externalId || null, fresh.id]
      );

      if (updated.rowCount !== 1) {
        throw new Error(`Reconciliation failure transition failed: ${fresh.reference_id}`);
      }

      await client.query('COMMIT');
      committed = true;
      return { failed: true };
    }

    // PENDING / UNKNOWN / CONFLICT: never resolve by guessing.
    const ageMinutes = (new Date() - new Date(fresh.created_at)) / (1000 * 60);
    await client.query('COMMIT');
    committed = true;

    if (verdict.reason === 'STATUS_CONTRACT_UNVERIFIED') {
      await recordExceptionOnce({
        type: 'DEPOSIT_CONTRACT_UNVERIFIED',
        reference: fresh.reference_id,
        transactionId: fresh.id,
        detail: { reason: verdict.reason },
      });
      return { blocked: true };
    }

    if (verdict.decision === 'CONFLICT') {
      await recordExceptionOnce({
        type: 'DEPOSIT_GATEWAY_CONFLICT',
        reference: fresh.reference_id,
        transactionId: fresh.id,
        detail: { reason: verdict.reason },
      });
      return { conflict: true };
    }

    if (ageMinutes > 15) {
      await recordExceptionOnce({
        type: 'STALE_DEPOSIT',
        reference: fresh.reference_id,
        transactionId: fresh.id,
        detail: { gatewayStatus: gateway.status, ageMinutes },
      });
    }

    return { unresolved: true };
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => {});
    }
    logger.error('RECON_DEPOSIT', error.message, { id: tx.id });
    await recordExceptionOnce({
      type: 'DEPOSIT_SETTLEMENT_FAILED',
      reference: tx.reference_id,
      transactionId: tx.id,
      detail: { message: error.message, code: error.code || null },
    }).catch((recErr) =>
      logger.error('RECON_DEPOSIT', `exception write failed: ${recErr.message}`, { id: tx.id })
    );
    throw error;
  } finally {
    client.release();
  }
}

// One open exception per (reference, type). Recon runs every 5 minutes and
// would otherwise add a duplicate row each pass for the same stuck withdrawal.
async function recordExceptionOnce(exception) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reference = exception.reference || null;
    const lockKey = `${reference || ''}:${exception.type}`;
    await client.query(
      'SELECT pg_advisory_xact_lock(0, hashtext($1))',
      [lockKey]
    );

    const existing = await client.query(
      `SELECT 1 FROM reconciliation_exceptions
        WHERE reference_id IS NOT DISTINCT FROM $1
          AND exception_type = $2
        LIMIT 1`,
      [reference, exception.type]
    );
    if (existing.rows.length) {
      await client.query('COMMIT');
      return false;
    }

    await client.query(
      `INSERT INTO reconciliation_exceptions
         (exception_type, reference_id, transaction_id, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        exception.type,
        reference,
        exception.transactionId || null,
        JSON.stringify(exception.detail || {}),
      ]
    );
    await client.query('COMMIT');
    logger.warn('RECON_EXCEPTION', `${exception.type} ${reference || ''} recorded`);
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
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
  // Query the gateway BEFORE acquiring a database row lock, mirroring
  // settleDeposit. The batch result (tx) is only used to obtain the
  // reference; the freshly locked row is authoritative for all decisions.
  const gateway = await queryTransactionStatus(tx.reference_id);

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const fresh = await client.query(
      `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
      [tx.id]
    );

    if (fresh.rows.length === 0) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { skipped: true };
    }

    const lockedTx = fresh.rows[0];

    if (lockedTx.status !== 'PROCESSING' || lockedTx.type !== 'WITHDRAWAL') {
      await client.query('COMMIT');
      transactionOpen = false;
      return { skipped: true };
    }

    // Stale-response guard
    if (
      String(lockedTx.reference_id) !== String(tx.reference_id) ||
      Number(lockedTx.user_id) !== Number(tx.user_id) ||
      Math.abs(Number(lockedTx.wallet_amount) - Number(tx.wallet_amount)) >= 0.005
    ) {
      await client.query('COMMIT');
      transactionOpen = false;
      logger.warn('RECON', `Withdrawal ${tx.reference_id}: stale gateway response (transaction changed)`);
      return { skipped: true, reason: 'transaction_changed' };
    }

    const dispatched = Boolean(lockedTx.external_tx_id);
    const ageMs = Date.now() - new Date(lockedTx.created_at).getTime();

    if (!dispatched && ageMs < DISPATCH_GRACE_MS) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { skipped: true, reason: 'dispatch_in_flight' };
    }

    if (gateway.status === 'SUCCESS') {
      await fin.captureHold({
        userId: lockedTx.user_id,
        amount: lockedTx.wallet_amount,
        accountCode: 'CUSTOMER_WALLET',
        reference: `${lockedTx.reference_id}-CAPTURE`,
        description: 'Withdrawal settled (MNO paid)',
        client,
        transactionId: lockedTx.id,
      });

      const updated = await client.query(
        `UPDATE transactions
            SET status = 'SUCCESS',
                updated_at = NOW()
          WHERE id = $1
            AND status = 'PROCESSING'
            AND type = 'WITHDRAWAL'`,
        [lockedTx.id]
      );

      if (updated.rowCount !== 1) {
        throw Object.assign(
          new Error(`Withdrawal SUCCESS transition conflict: ${lockedTx.reference_id}`),
          { code: 'WITHDRAWAL_SUCCESS_TRANSITION_CONFLICT', statusCode: 409 }
        );
      }

      await client.query('COMMIT');
      transactionOpen = false;

      logger.info('RECON', `Withdrawal ${lockedTx.reference_id} settled (gateway SUCCESS)`);
      return { settled: true };
    }

    if (gateway.status === 'FAILED') {
      await fin.releaseHold({
        userId: lockedTx.user_id,
        amount: lockedTx.wallet_amount,
        accountCode: 'CUSTOMER_WALLET',
        reference: `${lockedTx.reference_id}-RELEASE`,
        description: 'Withdrawal failed - funds returned',
        client,
        transactionId: lockedTx.id,
      });

      const updated = await client.query(
        `UPDATE transactions
            SET status = 'FAILED',
                failure_reason = 'Failed at gateway.',
                updated_at = NOW()
          WHERE id = $1
            AND status = 'PROCESSING'
            AND type = 'WITHDRAWAL'`,
        [lockedTx.id]
      );

      if (updated.rowCount !== 1) {
        throw Object.assign(
          new Error(`Withdrawal FAILED transition conflict: ${lockedTx.reference_id}`),
          { code: 'WITHDRAWAL_FAILED_TRANSITION_CONFLICT', statusCode: 409 }
        );
      }

      const { rows } = await client.query(
        `SELECT phone_number FROM users WHERE id = $1`,
        [lockedTx.user_id]
      );

      await client.query('COMMIT');
      transactionOpen = false;

      if (rows[0]?.phone_number) {
        const msg = `AFRIKOBA: Withdrawal yako ya ${formatMoney(lockedTx.wallet_amount)} haijafanikiwa. Fedha zimerudishwa kwenye wallet yako. Ref: ${lockedTx.reference_id}`;
        await sendSMS(rows[0].phone_number, msg).catch((error) =>
          logger.error('RECON_WITHDRAW', `SMS failed after refund commit: ${error.message}`)
        );
      }

      logger.info('RECON', `Withdrawal ${lockedTx.reference_id} refunded (gateway FAILED)`);
      return { refunded: true };
    }

    // PENDING/UNKNOWN: preserve the hold; never auto-refund.
    await client.query(
      `UPDATE transactions
          SET updated_at = NOW()
        WHERE id = $1
          AND status = 'PROCESSING'
          AND type = 'WITHDRAWAL'`,
      [lockedTx.id]
    );

    await client.query('COMMIT');
    transactionOpen = false;

    let exceptionRecorded = false;

    try {
      await recordExceptionOnce({
        type: dispatched ? 'STALE_WITHDRAWAL' : 'UNDISPATCHED_WITHDRAWAL',
        reference: lockedTx.reference_id,
        transactionId: lockedTx.id,
        detail: {
          status: gateway.status,
          dispatch: lockedTx.meta?.dispatch || null,
        },
      });
      exceptionRecorded = true;
    } catch (exceptionError) {
      logger.error(
        'RECON_WITHDRAW',
        `Exception recording failed after hold-preserving commit for ${lockedTx.reference_id}: ${exceptionError.message}`
      );
    }

    if (exceptionRecorded) {
      logger.warn(
        'RECON',
        `Withdrawal ${lockedTx.reference_id} unresolved at gateway (${gateway.status}) - exception recorded, hold retained`
      );
    } else {
      logger.warn(
        'RECON',
        `Withdrawal ${lockedTx.reference_id} unresolved at gateway (${gateway.status}) - exception recording failed, hold retained`
      );
    }

    return { exception: true, exceptionRecorded };
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
      transactionOpen = false;
    }

    logger.error('RECON_WITHDRAW', error.message, { id: tx.id });
    throw error;
  } finally {
    client.release();
  }
}


async function reconcilePendingDeposits() {
  if (!config.azampay.enabled) {
    const wd = await pool.connect();
    let processingWithdrawals = [];
    try {
      const { rows: processing } = await wd.query(
        `SELECT id, reference_id FROM transactions
           WHERE status = 'PROCESSING' AND type = 'WITHDRAWAL'
           ORDER BY updated_at ASC
           LIMIT 20`
      );
      processingWithdrawals = processing.map((r) => ({ id: r.id, reference_id: r.reference_id }));
    } catch (e) {
      logger.error('RECON', 'disabled-path query failed: ' + e.message);
      throw e;
    } finally {
      try { wd.release(); } catch (e) { logger.warn('RECON', 'release failed: ' + e.message); }
    }
    logger.info('RECON', 'AzamPay disabled; provider reconciliation skipped.');
    return {
      checkedDeposits: 0,
      processedWithdrawals: processingWithdrawals,
      providerDisabled: true,
    };
  }

  let checkedDeposits = 0;
  let processedWithdrawals = [];

  // 1) Deposits
  const dep = await pool.connect();
  try {
    const { rows: pending } = await dep.query(
      `SELECT t.id, t.reference_id, t.wallet_amount, t.commission, t.total_charged, t.user_id, t.created_at
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
  // 2) Withdrawals - fetch candidates, release connection, then settle.
  const wd = await pool.connect();
  let processingWithdrawals = [];
  try {
    const { rows: processing } = await wd.query(
      `SELECT * FROM transactions
       WHERE status = 'PROCESSING' AND type = 'WITHDRAWAL'
       ORDER BY updated_at ASC
       LIMIT 20`
    );
    processingWithdrawals = processing.map((r) => ({ id: r.id, reference_id: r.reference_id }));
  } finally {
    wd.release();
  }
  for (const tx of processingWithdrawals) {
    await settleWithdrawal(tx);
  }

  return { checkedDeposits, processedWithdrawals };
}

module.exports = { reconcilePendingDeposits, settleDeposit };
