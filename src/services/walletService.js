const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config');
const { triggerMnoCheckout, triggerPayout, queryTransactionStatus } = require('./azampayService');
const { classifyGatewayDeposit } = require('./depositVerification');
const { sendSMS } = require('./smsService');
const { computeDepositAmounts, generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const logger = require('../utils/logger');

/**
 * 1) KUANZISHA DEPOSIT
 * - Walet Amount (W) inaingia wallet, Fee ya 1% (F) inaongezwa juu (Add-on)
 * - totalCharged = W + F inaenda AzamPay USSD Push
 */
async function initiateDeposit(userId, amount, provider) {
  if (!config.azampay.enabled) {
    throw Object.assign(
      new Error('Deposit kupitia MNO imezimwa kwa sasa.'),
      { statusCode: 503, code: 'AZAMPAY_DISABLED' }
    );
  }

  if (parseFloat(amount) < 1000) {
    throw Object.assign(new Error('Kiasi kidogo cha deposit ni TZS 1,000.'), { statusCode: 400 });
  }
  if (!provider) {
    throw Object.assign(new Error('Chagua mtandao: Mpesa, Tigo, Airtel, Halopesa.'), { statusCode: 400 });
  }

  const { walletAmount, commission, totalCharged } = computeDepositAmounts(
    amount,
    config.fees.depositCommissionPercent
  );
  const referenceId = generateReference('DP');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT id, phone_number, full_name FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (userResult.rows.length === 0) {
      throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });
    }
    const user = userResult.rows[0];

    await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', 'DEPOSIT')`,
      [referenceId, userId, walletAmount, commission, totalCharged]
    );
    await client.query('COMMIT');

    const azamResponse = await triggerMnoCheckout(
      user.phone_number,
      totalCharged,
      referenceId,
      provider
    );

    if (!azamResponse.success) {
      const failedTransition = await client.query(
        `UPDATE transactions
            SET status = 'FAILED',
                failure_reason = $1,
                updated_at = NOW()
          WHERE reference_id = $2
            AND status = 'PENDING'`,
        [azamResponse.message, referenceId]
      );
      if (failedTransition.rowCount !== 1) {
        throw Object.assign(
          new Error('Deposit failure transition did not update exactly one pending transaction'),
          { code: 'DEPOSIT_INITIATION_FAILURE_TRANSITION_CONFLICT' }
        );
      }
      throw Object.assign(new Error(azamResponse.message), { statusCode: 400 });
    }

    return {
      referenceId,
      walletAmount,
      commission,
      totalCharged,
      status: 'PENDING',
      message: 'Ombi limetumwa. Ingiza PIN yako kwenye simu kukamilisha deposit.',
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 2) PROCESS AZAMPAY CALLBACK
 * - FOR UPDATE lock kwenye transactions & users row (kuzuia double crediting)
 * - Idempotency: transaction iliyo SUCCESS/FAILED haijatibiwa tena
 */
async function recordCallbackExceptionOnce(type, referenceId, transactionId, detail) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockKey = `${referenceId || ''}:${type}`;
    await client.query(
      'SELECT pg_advisory_xact_lock(0, hashtext($1))',
      [lockKey]
    );

    const existing = await client.query(
      `SELECT 1 FROM reconciliation_exceptions
        WHERE reference_id IS NOT DISTINCT FROM $1
          AND exception_type = $2
        LIMIT 1`,
      [referenceId || null, type]
    );
    if (existing.rows.length) {
      await client.query('COMMIT');
      return false;
    }

    await client.query(
      `INSERT INTO reconciliation_exceptions
         (exception_type, reference_id, transaction_id, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [type, referenceId || null, transactionId || null, JSON.stringify(detail || {})]
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function processDepositCallback({ utilityref, transactionstatus, reference, message, provider }) {
  const referenceId = utilityref;
  const claimedStatus = (transactionstatus || '').toLowerCase() === 'success' ? 'SUCCESS' : 'FAILED';

  // The callback body is a claim, not evidence. Nothing is credited or failed on
  // the body alone. Replays of finished transactions return before any gateway call.
  const pre = await pool.query(
    'SELECT id, status, total_charged FROM transactions WHERE reference_id = $1', [referenceId]
  );
  if (pre.rows.length === 0) {
    return { success: false, message: 'Transaction ID haijapatikana.', code: 404 };
  }
  if (pre.rows[0].status !== 'PENDING') {
    return { success: true, duplicate: true, message: 'Muamala ulishapokelewa tayari.' };
  }

  const gateway = await queryTransactionStatus(referenceId);
  const verdict = classifyGatewayDeposit(gateway, {
    referenceId,
    expectedTotal: pre.rows[0].total_charged,
    contractVerified: config.azampay.statusContractVerified,
  });
  const agrees =
    (verdict.decision === 'SUCCESS' && claimedStatus === 'SUCCESS') ||
    (verdict.decision === 'FAILED' && claimedStatus === 'FAILED');
  if (!agrees) {
    const type = verdict.decision === 'UNVERIFIED' ? 'CALLBACK_UNVERIFIED' : 'CALLBACK_GATEWAY_CONFLICT';
    await recordCallbackExceptionOnce(type, referenceId, pre.rows[0].id, {
      claimedStatus, decision: verdict.decision, reason: verdict.reason,
    });
    logger.warn('WALLET CALLBACK', `Deposit ${referenceId} not applied: ${verdict.decision} (${verdict.reason})`);
    return { success: true, pending: true, verified: false, message: 'Deposit inasubiri uthibitisho wa gateway.' };
  }

  const incomingStatus = verdict.decision;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `SELECT t.*, u.phone_number, u.full_name, u.currency_code
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE t.reference_id = $1
       FOR UPDATE OF t`,
      [referenceId]
    );

    if (txResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Transaction ID haijapatikana.', code: 404 };
    }
    const tx = txResult.rows[0];

    if (tx.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return { success: true, duplicate: true, message: 'Muamala ulishapokelewa tayari.' };
    }

    // The gateway was checked before acquiring this row lock. Revalidate the
    // locked transaction identity and charged amount before any financial write.
    const preTotal = Number(pre.rows[0].total_charged);
    const lockedTotal = Number(tx.total_charged);
    const transactionChanged =
      String(tx.id) !== String(pre.rows[0].id) ||
      String(tx.reference_id) !== String(referenceId) ||
      !Number.isFinite(preTotal) ||
      !Number.isFinite(lockedTotal) ||
      Math.abs(preTotal - lockedTotal) > 0.005;

    if (transactionChanged) {
      await client.query('ROLLBACK');
      await recordCallbackExceptionOnce(
        'CALLBACK_TRANSACTION_CHANGED',
        referenceId,
        tx.id,
        {
          preTransactionId: pre.rows[0].id,
          lockedTransactionId: tx.id,
          preTotalCharged: pre.rows[0].total_charged,
          lockedTotalCharged: tx.total_charged,
        }
      );
      logger.warn(
        'WALLET CALLBACK',
        `Deposit ${referenceId} not applied: locked transaction differs from gateway-verified snapshot`
      );
      return {
        success: true,
        pending: true,
        verified: false,
        message: 'Deposit inasubiri uhakiki wa transaction.',
      };
    }

    if (incomingStatus === 'SUCCESS') {
      // Serialize callback and reconciliation settlement for this reference.
      await client.query(
        'SELECT pg_advisory_xact_lock(0, hashtext($1))',
        [referenceId]
      );

      const posted = await fin.postDeposit({
        client,
        transactionId: tx.id,
        userId: tx.user_id,
        amount: tx.wallet_amount,
        commission: tx.commission,
        reference: referenceId,
        externalTxId: reference || null,
        description: 'Deposit kupitia AzamPay',
      });

      if (posted && posted.dedup && posted.verified !== true) {
        const error = new Error(`Unverified deposit duplicate: ${referenceId}`);
        error.code = 'DEPOSIT_IDEMPOTENCY_CONFLICT';
        throw error;
      }

      await client.query(
        `INSERT INTO wallet_ledger
           (transaction_id, reference_id, to_user_id, amount, description)
         VALUES ($1, $2, $3, $4, 'Deposit kupitia AzamPay')
         ON CONFLICT DO NOTHING`,
        [tx.id, referenceId, tx.user_id, tx.wallet_amount]
      );

      const ledgerResult = await client.query(
        `SELECT transaction_id, reference_id, to_user_id, amount
           FROM wallet_ledger
          WHERE reference_id = $1
          ORDER BY id
          FOR UPDATE`,
        [referenceId]
      );

      const { verifyWalletLedgerRows } = require('./depositVerification');
      if (!verifyWalletLedgerRows(ledgerResult.rows, {
        referenceId,
        transactionId: tx.id,
        userId: tx.user_id,
        amount: tx.wallet_amount
      })) {
        const error = new Error(`Deposit wallet-ledger conflict: ${referenceId}`);
        error.code = 'DEPOSIT_LEDGER_CONFLICT';
        throw error;
      }

      const updated = await client.query(
        `UPDATE transactions
            SET status = 'SUCCESS', external_tx_id = $1, updated_at = NOW()
          WHERE id = $2 AND status = 'PENDING'`,
        [reference || null, tx.id]
      );

      if (updated.rowCount !== 1) {
        throw new Error(`Deposit status transition failed: ${referenceId}`);
      }

      const balRes = await client.query(
        'SELECT wallet_balance, phone_number, full_name FROM users WHERE id = $1',
        [tx.user_id]
      );
      if (!balRes.rows.length) {
        throw new Error(`Deposit user missing after posting: ${tx.user_id}`);
      }

      await client.query('COMMIT');

      await logAudit({
        eventType: 'DEPOSIT',
        action: 'CREATE',
        entityType: 'TRANSACTION',
        userId: tx.user_id,
        referenceId,
        amount: tx.wallet_amount,
        afterData: { status: 'SUCCESS', provider }
      });

      const bal = balRes.rows[0];
      const smsMsg = `Habari ${bal.full_name}, deposit yako ya ${formatMoney(tx.wallet_amount)} imefanikiwa! Salio jipya: ${formatMoney(bal.wallet_balance)}. Ref: ${referenceId}`;
      await sendSMS(bal.phone_number, smsMsg).catch((smsErr) =>
        logger.error('WALLET', `SMS post-deposit imefunga: ${smsErr.message}`)
      );

      return {
        success: true,
        duplicate: Boolean(posted && posted.dedup),
        message: 'Deposit Processed Successfully.'
      };
    }

    const failedUpdate = await client.query(
      `UPDATE transactions
          SET status = 'FAILED', failure_reason = $1,
              external_tx_id = $2, updated_at = NOW()
        WHERE id = $3 AND status = 'PENDING'`,
      [message || 'Transaction failed', reference || null, tx.id]
    );
    if (failedUpdate.rowCount !== 1) {
      throw new Error('DEPOSIT_FAILURE_TRANSITION_CONFLICT: expected one PENDING transaction');
    }
    await client.query('COMMIT');
    return { success: true, message: 'Transaction Failed Recorded.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('WALLET CALLBACK', error.message);
    // Settlement failed after the gateway was checked: keep an operator-visible
    // exception instead of leaving the deposit silently PENDING.
    await recordCallbackExceptionOnce(
      'DEPOSIT_SETTLEMENT_FAILED',
      referenceId,
      pre.rows[0].id,
      { message: error.message, code: error.code || null }
    ).catch((recErr) => logger.error('WALLET CALLBACK', `exception write failed: ${recErr.message}`));
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 3) INTERNAL WALLET TRANSFER (P2P kwa simu)
 * - Lock pande zote mbili kwa mpangilio thabiti kuzuia deadlock
 */
async function transferWallet(fromUserId, toPhoneNumber, amount, note) {
  const amountNum = parseFloat(amount);
  if (!amountNum || amountNum <= 0) {
    throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fromRes = await client.query(
      'SELECT id, wallet_balance, phone_number, full_name FROM users WHERE id = $1 FOR UPDATE',
      [fromUserId]
    );
    if (fromRes.rows.length === 0) {
      throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });
    }
    const from = fromRes.rows[0];

    const toRes = await client.query(
      `SELECT id, wallet_balance, phone_number, full_name FROM users
       WHERE phone_number = $1 FOR UPDATE`,
      [toPhoneNumber.trim()]
    );
    if (toRes.rows.length === 0) {
      throw Object.assign(new Error('Mpokeaji hajapatikana kwenye mfumo.'), { statusCode: 404 });
    }
    const to = toRes.rows[0];

    if (from.id === to.id) {
      throw Object.assign(new Error('Huwezi kutuma fedha kwako mwenyewe.'), { statusCode: 400 });
    }
    if (Number(from.wallet_balance) < amountNum) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    }

    // Sanctions screening on the recipient (blocks only on CONFIRMED hits)
    const sanctions = require('./sanctionsService');
    await sanctions.assertNotSanctioned('USER', to.id);
    const sHits = await sanctions.screenSubject({ type: 'USER', id: to.id, name: to.full_name, phone: to.phone_number });
    if (sHits.length) {
      await sanctions.recordHits(sHits, { subjectType: 'USER', subjectId: to.id, subjectName: to.full_name, subjectPhone: to.phone_number });
    }

    const referenceId = generateReference('TR');
    const txResult = await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'TRANSFER', $4)
       RETURNING id`,
      [referenceId, fromUserId, amountNum, JSON.stringify({ to_user_id: to.id, note: note || null })]
    );

    await fin.internalTransfer({ client, fromUserId: from.id, toUserId: to.id, amount: amountNum, reference: referenceId, description: note || 'Uhamisho wa wallet' });
    await client.query(
      `INSERT INTO wallet_ledger (transaction_id, reference_id, from_user_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [txResult.rows[0].id, referenceId, from.id, to.id, amountNum, note || 'Uhamisho wa wallet']
    );

    await client.query('COMMIT');

    await logAudit({ eventType: 'TRANSFER', action: 'CREATE', entityType: 'TRANSACTION', userId: from.id, referenceId, amount: amountNum, afterData: { to_user_id: to.id, via: 'WALLET' } });

    const msg = `Habari ${to.full_name}, umepokea ${formatMoney(amountNum)} kutoka kwa ${from.full_name}. Salio jipya: ${formatMoney(to.wallet_balance + amountNum)}. Ref: ${referenceId}`;
    await sendSMS(to.phone_number, msg).catch((smsErr) => logger.error('WALLET', `SMS post-transfer imefunga: ${smsErr.message}`));

    return {
      success: true,
      referenceId,
      amount: amountNum,
      message: 'Uhamisho umefanikiwa.',
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 4) WITHDRAWAL - salio la wallet linahamishwa kwenye mtandao wa simu
 *
 * FINANCIAL MODEL (reservation):
 *   available decline, locked rise, total unchanged on request.
 *   After MNO processing:
 *     SUCCESS -> captureHold (locked leaves, funds paid to MNO)
 *     FAILED  -> releaseHold (locked returns to available)
 * This removes the ambiguous "money disappeared into PENDING" state and the
 * dangerous timeout-based refund that could double-credit a customer.
 */
function withdrawalReference(userId, idempotencyKey) {
  const digest = crypto.createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex');
  // 35 chars: leaves room for the longest ledger suffix ("-RELEASE"/"-CAPTURE")
  // within reference_id VARCHAR(50) on wallet_ledger and journal_entries.
  return `WD-${digest.slice(0, 32).toUpperCase()}`;
}

async function withdrawToMno(userId, amount, provider, idempotencyKey = null) {
  if (!config.azampay.enabled) {
    throw Object.assign(
      new Error('Withdrawal kwenda MNO imezimwa kwa sasa.'),
      { statusCode: 503, code: 'AZAMPAY_DISABLED' }
    );
  }

  // Fail closed until the AzamPay payout contract is verified against official
  // docs (Phase 68 D1). Checked before any hold or transaction is created.
  if (!config.azampay.payoutContractVerified) {
    throw Object.assign(
      new Error('Withdrawal kwenda MNO imezuiwa: payout contract haijathibitishwa.'),
      { statusCode: 503, code: 'PAYOUT_CONTRACT_UNVERIFIED' }
    );
  }

  const amountNum = parseFloat(amount);
  if (!amountNum || amountNum < 1000) {
    throw Object.assign(new Error('Kiasi kidogo cha withdrawal ni TZS 1,000.'), { statusCode: 400 });
  }

  // With a client Idempotency-Key the reference is derived from (user, key), so a
  // concurrent or repeated request hits the UNIQUE reference in holdFunds and
  // cannot create a second hold or a second dispatch.
  const referenceId = idempotencyKey
    ? withdrawalReference(userId, idempotencyKey)
    : generateReference('WD');

  try {
    const held = await fin.holdFunds({
      userId,
      amount: amountNum,
      accountCode: 'CUSTOMER_WALLET',
      reference: referenceId,
      description: 'Withdrawal reservation',
    });

    if (held.dedup) {
      const existing = await pool.query(
        `SELECT status, failure_reason FROM transactions WHERE reference_id = $1`, [referenceId]
      );
      if (existing.rows.length && existing.rows[0].status === 'FAILED') {
        return { success: false, referenceId, message: existing.rows[0].failure_reason || 'Withdrawal imeshindwa.', status: 'FAILED' };
      }
      const status = existing.rows.length ? existing.rows[0].status : 'PENDING';
      return { success: true, referenceId, message: 'Ombi hili tayari limepokelewa.', status };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userRes = await client.query(
        `SELECT id, phone_number, full_name FROM users WHERE id = $1`, [userId]
      );
      const user = userRes.rows[0];

      const txRes = await client.query(
        `INSERT INTO transactions
          (reference_id, user_id, wallet_amount, commission, total_charged, status, type,
           available_balance, locked_balance, meta)
         VALUES ($1, $2, $3, 0, $3, 'PROCESSING', 'WITHDRAWAL', 0, $3, $4)
         RETURNING id`,
        [referenceId, userId, amountNum, JSON.stringify({ dispatch: 'INTENT', provider })]
      );

      await client.query(
        `INSERT INTO wallet_ledger (transaction_id, reference_id, from_user_id, to_user_id, amount, description)
         VALUES ($1, $2, $3, NULL, $4, 'Withdrawal reserved (locked)')`,
        [txRes.rows[0].id, referenceId, userId, amountNum]
      );
      await client.query('COMMIT');

      // D1: dispatch the payout to the gateway AFTER commit (mirrors
      // initiateDeposit). If the gateway refuses the request, release the
      // reservation and mark the transaction FAILED, so funds are never left
      // locked for a payout that was never sent.
      const payout = await triggerPayout(user.phone_number, amountNum, referenceId, provider);
      const accepted = payout.success && payout.data?.success !== false;
      const refused = !accepted && !payout.ambiguous;

      if (!accepted && !refused) {
        // Timeout, network error or 5xx: the provider may already have accepted
        // the payout. Keep the hold and PROCESSING; reconciliation decides from
        // the gateway's record. Releasing here could double-credit the customer.
        await pool.query(
          `UPDATE transactions
           SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{dispatch}', '"UNCERTAIN"'), updated_at = NOW()
           WHERE reference_id = $1`,
          [referenceId]
        );
        logger.warn('WALLET_WD', `Dispatch uncertain ref=${referenceId} - hold kept for reconciliation`);
        await logAudit({ eventType: 'WITHDRAWAL', action: 'DISPATCH_UNCERTAIN', entityType: 'TRANSACTION', userId, referenceId, amount: amountNum, afterData: { status: 'PROCESSING', provider, error: payout.message } });
        return { success: true, referenceId, message: 'Ombi la withdrawal limepokelewa.', status: 'PROCESSING' };
      }

      if (refused) {
        const reason = payout.message || payout.data?.message || 'Gateway dispatch failed';
        await fin.releaseHold({
          userId,
          amount: amountNum,
          accountCode: 'CUSTOMER_WALLET',
          reference: `${referenceId}-RELEASE`,
          description: 'Withdrawal dispatch failed - funds returned',
        });
        await pool.query(
          `UPDATE transactions
           SET status = 'FAILED', failure_reason = $1,
               meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{dispatch}', '"REFUSED"'),
               updated_at = NOW()
           WHERE reference_id = $2`,
          [reason, referenceId]
        );
        await logAudit({ eventType: 'WITHDRAWAL', action: 'DISPATCH_FAILED', entityType: 'TRANSACTION', userId, referenceId, amount: amountNum, afterData: { status: 'FAILED', provider, error: reason } });
        throw Object.assign(
          new Error(reason),
          { statusCode: 502, code: 'GATEWAY_DISPATCH_FAILED' }
        );
      }

      await pool.query(
        `UPDATE transactions
         SET external_tx_id = $1,
             meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{dispatch}', '"ACCEPTED"'),
             updated_at = NOW()
         WHERE reference_id = $2`,
        [payout.data?.externalId || 'DISPATCHED', referenceId]
      );

      await logAudit({ eventType: 'WITHDRAWAL', action: 'CREATE', entityType: 'TRANSACTION', userId, referenceId, amount: amountNum, afterData: { status: 'PROCESSING', provider } });

      const msg = `AFRIKOBA: Ombi la kutoa ${formatMoney(amountNum)} limepokelewa. Ingiza PIN kwenye simu kuthibitisha.`;
      await sendSMS(user.phone_number, msg).catch((smsErr) => logger.error('WALLET', `SMS post-withdrawal imefunga: ${smsErr.message}`));

      return { success: true, referenceId, message: 'Ombi la withdrawal limepokelewa.', status: 'PROCESSING' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('WALLET_WD', error.message, { userId, amount: amountNum, referenceId });
    throw error;
  }
}

async function getBalance(userId) {
  const result = await pool.query(
    `SELECT wallet_balance, locked_balance, currency_code FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) throw new Error('Mtumiaji hajapatikana.');
  return result.rows[0];
}

async function getTransactionHistory(userId, limit = 50) {
  const result = await pool.query(
    `SELECT id, reference_id, external_tx_id, wallet_amount, commission, total_charged,
            type, status, failure_reason, meta, created_at
     FROM transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = {
  initiateDeposit,
  processDepositCallback,
  transferWallet,
  withdrawToMno,
  getBalance,
  getTransactionHistory,
};
