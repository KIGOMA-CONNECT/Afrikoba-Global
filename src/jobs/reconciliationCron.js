const pool = require('../config/db');
const config = require('../config');
const { queryTransactionStatus } = require('../services/azampayService');
const { sendSMS } = require('../services/smsService');
const { formatMoney } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * RECONCILIATION ENGINE
 * Kila dakika 5 - kagua miamala ya DEPOSIT iliyobaki PENDING > dakika 3
 * dhidi ya AzamPay Query Status API
 */
async function reconcilePendingDeposits() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: pending } = await client.query(
      `SELECT t.*, u.phone_number, u.full_name
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE t.status = 'PENDING'
         AND t.type = 'DEPOSIT'
         AND t.created_at < NOW() - INTERVAL '3 minutes'
       LIMIT 20
       FOR UPDATE OF t, u`
    );

    logger.info('RECON', `Miamala ya PENDING kupatikana: ${pending.length}`);

    for (const tx of pending) {
      const gateway = await queryTransactionStatus(tx.reference_id);

      if (gateway.status === 'SUCCESS') {
        await client.query(
          'UPDATE transactions SET status = $1, updated_at = NOW() WHERE reference_id = $2',
          ['SUCCESS', tx.reference_id]
        );
        const walletRes = await client.query(
          'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance',
          [tx.wallet_amount, tx.user_id]
        );
        await client.query(
          `UPDATE company_revenue SET total_commission = total_commission + $1, updated_at = NOW() WHERE id = 1`,
          [tx.commission]
        );
        const newBalance = walletRes.rows[0].wallet_balance;

        const smsMsg = `Habari ${tx.full_name}, deposit yako ya ${formatMoney(tx.wallet_amount)} imethibitishwa (Reconciliation). Salio: ${formatMoney(newBalance)}. Ref: ${tx.reference_id}`;
        await sendSMS(tx.phone_number, smsMsg);
      } else if (gateway.status === 'FAILED') {
        await client.query(
          `UPDATE transactions SET status = 'FAILED', failure_reason = 'Failed at gateway (recon)', updated_at = NOW()
           WHERE reference_id = $1`,
          [tx.reference_id]
        );
      } else {
        // PENDING au UNKNOWN - angalia expiry (dakika 15)
        const ageMinutes = (new Date() - new Date(tx.created_at)) / (1000 * 60);
        if (ageMinutes > 15) {
          await client.query(
            `UPDATE transactions SET status = 'FAILED', failure_reason = 'Expired (recon)', updated_at = NOW()
             WHERE reference_id = $1`,
            [tx.reference_id]
          );
          logger.warn('RECON', `Tx ${tx.reference_id} imefungwa kama expired`);
        }
      }
    }

    // WITHDRAWAL stale: hakuna gateway ya kukamilisha -> rudisha fedha kwenye wallet
    // (Usalama wa fedha: withdrawal inayobaki PENDING > dakika 15 inarudishwa)
    const { rows: staleWithdrawals } = await client.query(
      `SELECT * FROM transactions
       WHERE status = 'PENDING' AND type = 'WITHDRAWAL'
         AND created_at < NOW() - INTERVAL '15 minutes'
       LIMIT 20 FOR UPDATE`
    );

    if (!config.azampay.clientId && staleWithdrawals.length > 0) {
      logger.warn('RECON', `Withdrawals ${staleWithdrawals.length} zinarudishwa (hakuna gateway ya withdrawal)`);
    }

    for (const wd of staleWithdrawals) {
      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
        [wd.wallet_amount, wd.user_id]
      );
      await client.query(
        `UPDATE transactions SET status = 'FAILED',
             failure_reason = 'Withdrawal imemalizika muda - fedha zimerudishwa kwenye wallet.',
             updated_at = NOW()
         WHERE id = $1`,
        [wd.id]
      );
      logger.warn('RECON', `Withdrawal ${wd.reference_id} imerudishwa kwenye wallet`);
    }

    await client.query('COMMIT');
    return { checked: pending.length, refundedWithdrawals: staleWithdrawals.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('RECON', error.message);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { reconcilePendingDeposits };
