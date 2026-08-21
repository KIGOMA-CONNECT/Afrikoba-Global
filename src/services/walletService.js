const pool = require('../config/db');
const config = require('../config');
const { triggerMnoCheckout } = require('./azampayService');
const { sendSMS } = require('./smsService');
const { computeDepositAmounts, generateReference, formatMoney } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * 1) KUANZISHA DEPOSIT
 * - Walet Amount (W) inaingia wallet, Fee ya 1% (F) inaongezwa juu (Add-on)
 * - totalCharged = W + F inaenda AzamPay USSD Push
 */
async function initiateDeposit(userId, amount, provider) {
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
      await client.query(
        `UPDATE transactions SET status = 'FAILED', failure_reason = $1, updated_at = NOW()
         WHERE reference_id = $2`,
        [azamResponse.message, referenceId]
      );
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
async function processDepositCallback({ utilityref, transactionstatus, reference, message, provider }) {
  const referenceId = utilityref;
  const incomingStatus = (transactionstatus || '').toLowerCase() === 'success' ? 'SUCCESS' : 'FAILED';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `SELECT t.*, u.phone_number, u.full_name, u.currency_code
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE t.reference_id = $1
       FOR UPDATE OF t, u`,
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

    if (incomingStatus === 'SUCCESS') {
      await client.query(
        `UPDATE transactions SET status = 'SUCCESS', external_tx_id = $1, updated_at = NOW()
         WHERE reference_id = $2`,
        [reference || null, referenceId]
      );

      const walletResult = await client.query(
        `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance`,
        [tx.wallet_amount, tx.user_id]
      );
      const newBalance = walletResult.rows[0].wallet_balance;

      await client.query(
        `UPDATE company_revenue SET total_commission = total_commission + $1, updated_at = NOW()
         WHERE id = 1`,
        [tx.commission]
      );

      await client.query(
        `INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description)
         VALUES ($1, $2, $3, $4, 'Deposit kupitia AzamPay')`,
        [tx.id, referenceId, tx.user_id, tx.wallet_amount]
      );

      await client.query('COMMIT');

      const smsMsg = `Habari ${tx.full_name}, deposit yako ya ${formatMoney(tx.wallet_amount)} imefanikiwa! Salio jipya: ${formatMoney(newBalance)}. Ref: ${referenceId}`;
      await sendSMS(tx.phone_number, smsMsg).catch((smsErr) => logger.error('WALLET', `SMS post-deposit imefunga: ${smsErr.message}`));

      return { success: true, message: 'Deposit Processed Successfully.' };
    }

    await client.query(
      `UPDATE transactions SET status = 'FAILED', failure_reason = $1, external_tx_id = $2, updated_at = NOW()
       WHERE reference_id = $3`,
      [message || 'Transaction failed', reference || null, referenceId]
    );
    await client.query('COMMIT');
    return { success: true, message: 'Transaction Failed Recorded.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('WALLET CALLBACK', error.message);
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

    const referenceId = generateReference('TR');
    const txResult = await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'TRANSFER', $4)
       RETURNING id`,
      [referenceId, fromUserId, amountNum, JSON.stringify({ to_user_id: to.id, note: note || null })]
    );

    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2',
      [amountNum, from.id]
    );
    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
      [amountNum, to.id]
    );
    await client.query(
      `INSERT INTO wallet_ledger (transaction_id, reference_id, from_user_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [txResult.rows[0].id, referenceId, from.id, to.id, amountNum, note || 'Uhamisho wa wallet']
    );

    await client.query('COMMIT');

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
 */
async function withdrawToMno(userId, amount, provider) {
  const amountNum = parseFloat(amount);
  if (!amountNum || amountNum < 1000) {
    throw Object.assign(new Error('Kiasi kidogo cha withdrawal ni TZS 1,000.'), { statusCode: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query(
      'SELECT id, wallet_balance, phone_number, full_name FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const user = userRes.rows[0];
    if (Number(user.wallet_balance) < amountNum) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    }

    const referenceId = generateReference('WD');
    await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type)
       VALUES ($1, $2, $3, 0, $3, 'PENDING', 'WITHDRAWAL')`,
      [referenceId, userId, amountNum]
    );

    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2',
      [amountNum, userId]
    );
    await client.query('COMMIT');

    const msg = `AFRIKOBA: Ombi la kutoa ${formatMoney(amountNum)} limepokelewa. Ingiza PIN kwenye simu kuthibitisha.`;
    await sendSMS(user.phone_number, msg).catch((smsErr) => logger.error('WALLET', `SMS post-withdrawal imefunga: ${smsErr.message}`));

    return { success: true, referenceId, message: 'Ombi la withdrawal limepokelewa.', status: 'PENDING' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
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
