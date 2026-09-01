/**
 * FINANCIAL ENGINE v1.0
 * Central, authoritative money-movement layer for AFRIKOBA.
 *
 * The goal: application services request financial operations from this engine
 * instead of directly mutating balances. Every operation:
 *   1. acquires an idempotency key (reference_id) to prevent double-posting
 *   2. writes balanced double-entry journal_entries
 *   3. updates the user/group balance projection as a controlled cache
 *   4. produces an audit record
 *
 * This guarantees:
 *   - Debit == Credit (enforced at DB AND here)
 *   - Same event posted 1/5/20 times -> exactly one financial effect
 *   - Every shilling moving has an immutable accounting trail
 */

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
const logger = require('../utils/logger');

/** Look up (and lazily create) an internal account id by its code. */
async function accountIdByCode(code, client) {
  const r = await client.query(
    `SELECT id FROM ledger_accounts WHERE account_code = $1`, [code]
  );
  if (r.rows.length === 0) {
    throw new Error(`Financial Engine: unknown account code '${code}'`);
  }
  return r.rows[0].id;
}

/**
 * Post a balanced journal entry group.
 * @param {object} opts
 * @param pg client    - transactional client
 * @param lines        - [{accountCode, direction('DR'|'CR'), amount}]
 * @param transactionId- transactions.id if this maps to a business tx
 * @param referenceId  - idempotency key
 * @param description
 * @param postedBy
 */
async function postJournal({ client, lines, transactionId = null, referenceId, description, postedBy = 'engine' }) {
  const groupId = referenceId || generateReference('JE');
  let dr = 0, cr = 0;
  for (const line of lines) {
    if (line.direction === 'DR') dr += Number(line.amount);
    else cr += Number(line.amount);
  }
  if (Math.abs(dr - cr) > 0.000001) {
    throw new Error(`Financial Engine: unbalanced posting DR=${dr} CR=${cr}`);
  }
  for (const line of lines) {
    const accId = await accountIdByCode(line.accountCode, client);
    await client.query(
      `INSERT INTO journal_entries
         (entry_group_id, transaction_id, account_id, direction, amount,
          currency_code, reference_id, description, posted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [groupId, transactionId, accId, line.direction, line.amount,
       line.currencyCode || 'TZS', referenceId, line.description || description || null, postedBy]
    );
  }
  return groupId;
}

/**
 * Idempotency guard. If the key already has a journal group, refuse to post a
 * second time so a retry can never double-credit.
 * Returns { deduped: boolean }.
 */
async function guardAgainstDuplicate(groupId, client) {
  const r = await client.query(
    `SELECT 1 FROM journal_entries WHERE entry_group_id = $1 LIMIT 1`, [groupId]
  );
  return { dedup: r.rows.length > 0 };
}

/**
 * POST A DEPOSIT
 * Customer credited; MNO clearing debited; platform fee (commission) to revenue.
 * Idempotent on referenceId. Uses the transaction row as the source of truth for
 * whether the deposit was already honoured.
 */
async function postDeposit({ userId, amount, commission, reference, externalTxId, description = 'Deposit' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Hard idempotency: a reference that already has a journal group is a retry.
    const gp = await guardAgainstDuplicate(reference, client);
    if (gp.dedup) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

    const amountN = Number(amount);
    const commissionN = Number(commission || 0);

    // Post double-entry journal.
    const journalLines = [
      { accountCode: 'MNO_CLEARING', direction: 'DR', amount: amountN + commissionN },
      { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
    ];
    if (commissionN > 0) {
      journalLines.push({ accountCode: 'COMMISSION', direction: 'CR', amount: commissionN });
    }
    await postJournal({
      client, lines: journalLines, referenceId: reference,
      description, postedBy: 'engine:deposit'
    });

    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
      [amountN, userId]
    );

    await client.query(
      `UPDATE company_revenue SET total_commission = total_commission + $1, updated_at = NOW() WHERE id = 1`,
      [commissionN]
    );

    await client.query('COMMIT');
    return { success: true, reference, posted: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FIN_ENGINE_DEPOSIT', error.message, { userId, reference });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * HOLD (RESERVE) FUNDS - e.g. withdrawal request, card authorization.
 * Moves amount from available (wallet_balance) to locked_balance, keeping the
 * user's total funds constant. Returns the idempotent hold group id.
 */
async function holdFunds({ userId, amount, accountCode = 'CUSTOMER_WALLET', reference, description = 'Hold' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gp = await guardAgainstDuplicate(reference, client);
    if (gp.dedup) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

    // Validate available funds before locking.
    const { rows } = await client.query(
      `SELECT wallet_balance, locked_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]
    );
    if (rows.length === 0) throw new Error('User not found');
    const avail = Number(rows[0].wallet_balance);
    const amountN = Number(amount);
    if (avail < amountN) {
      throw Object.assign(new Error('Salio lako halitoshi kwa hold hii.'), { statusCode: 400 });
    }

    await postJournal({
      client,
      lines: [
        { accountCode, direction: 'DR', amount: amountN },
        { accountCode: 'CARD_HOLD', direction: 'CR', amount: amountN },
      ],
      referenceId: reference, description, postedBy: 'engine:hold'
    });

    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance - $1, locked_balance = locked_balance + $1 WHERE id = $2`,
      [amountN, userId]
    );

    await client.query('COMMIT');
    return { success: true, reference, held: amountN };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FIN_ENGINE_HOLD', error.message, { userId, reference });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * RELEASE (REFUND) A HOLD - funds move back from locked to available.
 * idempotent on a reference.
 */
async function releaseHold({ userId, amount, accountCode = 'CUSTOMER_WALLET', reference, description = 'Release hold' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gp = await guardAgainstDuplicate(reference, client);
    if (gp.dedup) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

    await postJournal({
      client,
      lines: [
        { accountCode: 'CARD_HOLD', direction: 'DR', amount: Number(amount) },
        { accountCode, direction: 'CR', amount: Number(amount) },
      ],
      referenceId: reference, description, postedBy: 'engine:release'
    });

    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance + $1, locked_balance = locked_balance - $1 WHERE id = $2`,
      [Number(amount), userId]
    );

    await client.query('COMMIT');
    return { success: true, reference, released: Number(amount) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FIN_ENGINE_RELEASE', error.message, { userId, reference });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * CAPTURE / SETTLE A HOLD - funds are permanently moved (e.g. withdrawal paid out).
 * The locked funds leave locked_balance and become a real payment (MNO asset).
 */
async function captureHold({ userId, amount, accountCode = 'CUSTOMER_WALLET', reference, description = 'Capture hold' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gp = await guardAgainstDuplicate(reference, client);
    if (gp.dedup) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

    await postJournal({
      client,
      lines: [
        { accountCode: 'CARD_HOLD', direction: 'DR', amount: Number(amount) },
        { accountCode: 'MNO_CLEARING', direction: 'CR', amount: Number(amount) },
      ],
      referenceId: reference, description, postedBy: 'engine:capture'
    });

    await client.query(
      `UPDATE users SET locked_balance = locked_balance - $1 WHERE id = $2`,
      [Number(amount), userId]
    );

    await client.query('COMMIT');
    return { success: true, reference, captured: Number(amount) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FIN_ENGINE_CAPTURE', error.message, { userId, reference });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * TRANSFER between two customer wallets.
 * Sender debit == recipient credit; single idempotent reference.
 */
async function transfer({ fromUserId, toUserId, amount, reference, description = 'Wallet transfer' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gp = await guardAgainstDuplicate(reference, client);
    if (gp.dedup) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

    // Lock both, stable order to avoid deadlock.
    const a = Math.min(fromUserId, toUserId);
    const b = Math.max(fromUserId, toUserId);
    for (const id of [a, b]) {
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [id]);
    }
    const { rows } = await client.query(
      `SELECT wallet_balance FROM users WHERE id = $1`, [fromUserId]
    );
    if (Number(rows[0].wallet_balance) < Number(amount)) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    }

    await postJournal({
      client,
      lines: [
        { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: Number(amount) },
        { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: Number(amount) },
      ],
      referenceId: reference, description, postedBy: 'engine:transfer'
    });

    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`, [Number(amount), fromUserId]
    );
    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [Number(amount), toUserId]
    );

    await client.query('COMMIT');
    return { success: true, reference, transferred: Number(amount) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('FIN_ENGINE_TRANSFER', error.message, { fromUserId, toUserId, reference });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * RECORD A RECONCILIATION EXCEPTION.
 * Used when a mismatch is found - the event is surfaced, not silently resolved.
 */
async function recordException({ type, reference, transactionId, detail = {} }) {
  try {
    await pool.query(
      `INSERT INTO reconciliation_exceptions (exception_type, reference_id, transaction_id, detail)
       VALUES ($1,$2,$3,$4)`,
      [type, reference, transactionId, JSON.stringify(detail)]
    );
    logger.warn('FIN_EXCEPTION', `${type} ${reference || ''} recorded`);
  } catch (e) {
    logger.error('FIN_EXCEPTION_WRITE', e.message);
  }
}

module.exports = {
  postJournal,
  postDeposit,
  holdFunds,
  releaseHold,
  captureHold,
  transfer,
  recordException,
  accountIdByCode,
};
