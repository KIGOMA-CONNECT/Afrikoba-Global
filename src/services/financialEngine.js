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
 * Atomic idempotency gate using the financial_operations registry.
 * Attempts to claim the reference; if already present, we dedup.
 * Runs *inside* the caller's transaction (client must be mid-BEGIN).
 * Returns { claimed: boolean } - true means this call owns the operation.
 */
async function claimOperation({ client, operationType, reference, transactionId = null, userId = null, amount = 0 }) {
  const r = await client.query(
    `INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts)
     VALUES ($1,$2,$3,$4,$5,'NEW',1)
     ON CONFLICT (reference_id) DO NOTHING
     RETURNING id`,
    [operationType, reference, transactionId, userId, amount]
  );
  return { claimed: r.rows.length > 0 };
}

/**
 * Write a financial audit row describing one projection-balance mutation.
 */
async function auditBalance({ client, accountKind, accountId, operation, amount, balanceBefore, balanceAfter, reference, actor = 'engine' }) {
  try {
    await client.query(
      `INSERT INTO financial_audit_log
         (account_kind, account_id, operation, amount, balance_before, balance_after, reference_id, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [accountKind, accountId, operation, amount, balanceBefore, balanceAfter, reference, actor]
    );
  } catch (e) {
    logger.error('FIN_AUDIT', `audit write failed for ${reference}: ${e.message}`);
  }
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

    const amountN = Number(amount);
    const commissionN = Number(commission || 0);

    // Hard idempotency: claim the reference atomically. A retried reference
    // returns nothing to post and is reported as a duplicate.
    const op = await claimOperation({
      client, operationType: 'DEPOSIT', reference,
      transactionId: null, userId, amount: amountN,
    });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

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

    const before = await client.query(`SELECT wallet_balance FROM users WHERE id = $1`, [userId]);
    const beforeBal = Number(before.rows[0].wallet_balance);

    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
      [amountN, userId]
    );
    await client.query(
      `UPDATE company_revenue SET total_commission = total_commission + $1, updated_at = NOW() WHERE id = 1`,
      [commissionN]
    );

    await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'deposit', amount: amountN, balanceBefore: beforeBal, balanceAfter: beforeBal + amountN, reference, actor: 'engine:deposit' });
    if (commissionN > 0) {
      await auditBalance({ client, accountKind: 'COMPANY_REVENUE', accountId: 1, operation: 'commission', amount: commissionN, balanceBefore: null, balanceAfter: null, reference, actor: 'engine:deposit' });
    }

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

    const amountN = Number(amount);

    const op = await claimOperation({
      client, operationType: 'HOLD', reference, userId, amount: amountN,
    });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

    // Validate available funds before locking.
    const { rows } = await client.query(
      `SELECT wallet_balance, locked_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]
    );
    if (rows.length === 0) throw new Error('User not found');
    const avail = Number(rows[0].wallet_balance);
    const lockedBefore = Number(rows[0].locked_balance);
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

    await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'hold', amount: amountN, balanceBefore: avail, balanceAfter: avail - amountN, reference, actor: 'engine:hold' });
    await auditBalance({ client, accountKind: 'USER_LOCKED', accountId: userId, operation: 'hold', amount: amountN, balanceBefore: lockedBefore, balanceAfter: lockedBefore + amountN, reference, actor: 'engine:hold' });

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

    const amountN = Number(amount);

    const op = await claimOperation({
      client, operationType: 'RELEASE', reference, userId, amount: amountN,
    });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

    const { rows } = await client.query(
      `SELECT wallet_balance, locked_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]
    );
    const availBefore = Number(rows[0].wallet_balance);
    const lockedBefore = Number(rows[0].locked_balance);

    await postJournal({
      client,
      lines: [
        { accountCode: 'CARD_HOLD', direction: 'DR', amount: amountN },
        { accountCode, direction: 'CR', amount: amountN },
      ],
      referenceId: reference, description, postedBy: 'engine:release'
    });

    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance + $1, locked_balance = locked_balance - $1 WHERE id = $2`,
      [amountN, userId]
    );

    await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'release', amount: amountN, balanceBefore: availBefore, balanceAfter: availBefore + amountN, reference, actor: 'engine:release' });
    await auditBalance({ client, accountKind: 'USER_LOCKED', accountId: userId, operation: 'release', amount: amountN, balanceBefore: lockedBefore, balanceAfter: lockedBefore - amountN, reference, actor: 'engine:release' });

    await client.query('COMMIT');
    return { success: true, reference, released: amountN };
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

    const amountN = Number(amount);

    const op = await claimOperation({
      client, operationType: 'CAPTURE', reference, userId, amount: amountN,
    });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }

    const { rows } = await client.query(
      `SELECT locked_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]
    );
    const lockedBefore = Number(rows[0].locked_balance);

    await postJournal({
      client,
      lines: [
        { accountCode: 'CARD_HOLD', direction: 'DR', amount: amountN },
        { accountCode: 'MNO_CLEARING', direction: 'CR', amount: amountN },
      ],
      referenceId: reference, description, postedBy: 'engine:capture'
    });

    await client.query(
      `UPDATE users SET locked_balance = locked_balance - $1 WHERE id = $2`,
      [amountN, userId]
    );

    await auditBalance({ client, accountKind: 'USER_LOCKED', accountId: userId, operation: 'capture', amount: amountN, balanceBefore: lockedBefore, balanceAfter: lockedBefore - amountN, reference, actor: 'engine:capture' });

    await client.query('COMMIT');
    return { success: true, reference, captured: amountN };
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

    const amountN = Number(amount);

    const op = await claimOperation({
      client, operationType: 'TRANSFER', reference, userId: fromUserId, amount: amountN,
    });
    if (!op.claimed) {
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
    const fromBefore = Number(rows[0].wallet_balance);
    if (fromBefore < amountN) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    }
    const toRows = await client.query(`SELECT wallet_balance FROM users WHERE id = $1`, [toUserId]);
    const toBefore = Number(toRows.rows[0].wallet_balance);

    await postJournal({
      client,
      lines: [
        { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
        { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
      ],
      referenceId: reference, description, postedBy: 'engine:transfer'
    });

    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`, [amountN, fromUserId]
    );
    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [amountN, toUserId]
    );

    await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: fromUserId, operation: 'transfer_debit', amount: amountN, balanceBefore: fromBefore, balanceAfter: fromBefore - amountN, reference, actor: 'engine:transfer' });
    await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: toUserId, operation: 'transfer_credit', amount: amountN, balanceBefore: toBefore, balanceAfter: toBefore + amountN, reference, actor: 'engine:transfer' });

    await client.query('COMMIT');
    return { success: true, reference, transferred: amountN };
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

/* ============================================================================
 * TRANSACTION-AWARE PRIMITIVES (Phase 7)
 * These run INSIDE a caller-supplied transaction `client` so a service can
 * journal its money movement atomically with its own business updates.
 * Every primitive: claims the reference (idempotent), posts a balanced journal
 * group against CUSTOMER_WALLET, updates the projection, writes the audit log.
 * ==========================================================================*/

/**
 * Credit a user's available wallet balance.
 *   DR <fromAccount>   CR CUSTOMER_WALLET
 */
async function creditWallet({ client, userId, amount, reference, fromAccount = 'SUSPENSE', description = 'Wallet credit', actor = 'engine:credit' }) {
  const amountN = Number(amount);
  if (!(amountN > 0)) throw new Error('Invalid amount for credit');
  const op = await claimOperation({ client, operationType: 'CREDIT', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };

  const { rows } = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (rows.length === 0) throw new Error('User not found');
  const before = Number(rows[0].wallet_balance);

  await postJournal({
    client,
    lines: [
      { accountCode: fromAccount, direction: await legDirection(client, fromAccount, 'source'), amount: amountN },
      { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });

  await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [amountN, userId]);
  await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'credit', amount: amountN, balanceBefore: before, balanceAfter: before + amountN, reference, actor });
  return { success: true, reference, credited: amountN };
}

/**
 * Debit a user's available wallet balance (with insufficient-funds guard).
 *   DR CUSTOMER_WALLET   CR <toAccount>
 */
async function debitWallet({ client, userId, amount, reference, toAccount = 'PLATFORM_FEES', description = 'Wallet debit', actor = 'engine:debit' }) {
  const amountN = Number(amount);
  if (!(amountN > 0)) throw new Error('Invalid amount for debit');
  const op = await claimOperation({ client, operationType: 'DEBIT', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };

  const { rows } = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (rows.length === 0) throw new Error('User not found');
  const before = Number(rows[0].wallet_balance);
  if (before < amountN) {
    throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
  }

  await postJournal({
    client,
    lines: [
      { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
      { accountCode: toAccount, direction: await legDirection(client, toAccount, 'target'), amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });

  await client.query(`UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`, [amountN, userId]);
  await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'debit', amount: amountN, balanceBefore: before, balanceAfter: before - amountN, reference, actor });
  return { success: true, reference, debited: amountN };
}

async function legDirection(client, accountCode, role) {
  const acct = await client.query('SELECT account_type FROM ledger_accounts WHERE account_code = $1', [accountCode]);
  const type = (acct.rows[0] && acct.rows[0].account_type) || 'ASSET';
  if (role === 'source') return type === 'ASSET' ? 'CR' : 'DR';
  return (type === 'ASSET' || type === 'EXPENSE') ? 'DR' : 'CR';
}

/**
 * Internal transfer between two customer wallets (aggregate-neutral).
 *   DR CUSTOMER_WALLET (from)   CR CUSTOMER_WALLET (to)
 */
async function internalTransfer({ client, fromUserId, toUserId, amount, reference, description = 'Internal transfer', actor = 'engine:transfer' }) {
  const amountN = Number(amount);
  const op = await claimOperation({ client, operationType: 'TRANSFER', reference, userId: fromUserId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };

  const a = Math.min(fromUserId, toUserId);
  const b = Math.max(fromUserId, toUserId);
  for (const id of [a, b]) {
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [id]);
  }
  const f = await client.query(`SELECT wallet_balance FROM users WHERE id = $1`, [fromUserId]);
  if (f.rows.length === 0) throw new Error('Sender not found');
  const fromBefore = Number(f.rows[0].wallet_balance);
  if (fromBefore < amountN) {
    throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
  }
  const t = await client.query(`SELECT wallet_balance FROM users WHERE id = $1`, [toUserId]);
  if (t.rows.length === 0) throw new Error('Recipient not found');
  const toBefore = Number(t.rows[0].wallet_balance);

  await postJournal({
    client,
    lines: [
      { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
      { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });

  await client.query(`UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`, [amountN, fromUserId]);
  await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [amountN, toUserId]);
  await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: fromUserId, operation: 'transfer_debit', amount: amountN, balanceBefore: fromBefore, balanceAfter: fromBefore - amountN, reference, actor });
  await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: toUserId, operation: 'transfer_credit', amount: amountN, balanceBefore: toBefore, balanceAfter: toBefore + amountN, reference, actor });
  return { success: true, reference, transferred: amountN };
}

/**
 * Move funds from a user wallet into a group wallet (e.g. VICOBA contribution).
 *   DR CUSTOMER_WALLET   CR <groupAccountCode>   [+ users -X, group +Y]
 */
async function walletToGroup({ client, userId, groupId, groupAccount = 'VICOBA_GROUP', groupSql, amount, reference, description = 'Wallet to group', actor = 'engine:walletToGroup' }) {
  const amountN = Number(amount);
  const op = await claimOperation({ client, operationType: 'WALLET_TO_GROUP', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };

  const { rows } = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (rows.length === 0) throw new Error('User not found');
  const before = Number(rows[0].wallet_balance);
  if (before < amountN) {
    throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
  }

  await postJournal({
    client,
    lines: [
      { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
      { accountCode: groupAccount, direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });

  await client.query(`UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`, [amountN, userId]);
  if (groupSql) {
    await client.query(groupSql, [amountN, groupId]);
  }
  await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'wallet_to_group', amount: amountN, balanceBefore: before, balanceAfter: before - amountN, reference, actor });
  return { success: true, reference, moved: amountN };
}

/**
 * Move funds from a group wallet back to a user wallet (e.g. VICOBA payout).
 *   DR <groupAccountCode>   CR CUSTOMER_WALLET   [+ group -Y, users +X]
 */
async function groupToWallet({ client, userId, groupId, groupAccount = 'VICOBA_GROUP', groupSql, amount, reference, description = 'Group to wallet', actor = 'engine:groupToWallet' }) {
  const amountN = Number(amount);
  const op = await claimOperation({ client, operationType: 'GROUP_TO_WALLET', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };

  const { rows } = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (rows.length === 0) throw new Error('User not found');
  const before = Number(rows[0].wallet_balance);

  await postJournal({
    client,
    lines: [
      { accountCode: groupAccount, direction: 'DR', amount: amountN },
      { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });

  if (groupSql) {
    await client.query(groupSql, [amountN, groupId]);
  }
  await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [amountN, userId]);
  await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'group_to_wallet', amount: amountN, balanceBefore: before, balanceAfter: before + amountN, reference, actor });
  return { success: true, reference, moved: amountN };
}

/**
 * LOCK available funds (available -> locked). In-transaction hold.
 *   DR <sourceAccount>   CR CARD_HOLD
 */
async function lockWallet({ client, userId, amount, reference, sourceAccount = 'CUSTOMER_WALLET', description = 'Lock funds', actor = 'engine:lock' }) {
  const amountN = Number(amount);
  const op = await claimOperation({ client, operationType: 'LOCK', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };

  const { rows } = await client.query(`SELECT wallet_balance, locked_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (rows.length === 0) throw new Error('User not found');
  const availBefore = Number(rows[0].wallet_balance);
  const lockedBefore = Number(rows[0].locked_balance);
  if (availBefore < amountN) {
    throw Object.assign(new Error('Salio lako halitoshi kwa hold hii.'), { statusCode: 400 });
  }

  await postJournal({
    client,
    lines: [
      { accountCode: sourceAccount, direction: 'DR', amount: amountN },
      { accountCode: 'CARD_HOLD', direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });

  await client.query(`UPDATE users SET wallet_balance = wallet_balance - $1, locked_balance = locked_balance + $1 WHERE id = $2`, [amountN, userId]);
  await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'lock', amount: amountN, balanceBefore: availBefore, balanceAfter: availBefore - amountN, reference, actor });
  await auditBalance({ client, accountKind: 'USER_LOCKED', accountId: userId, operation: 'lock', amount: amountN, balanceBefore: lockedBefore, balanceAfter: lockedBefore + amountN, reference, actor });
  return { success: true, reference, locked: amountN };
}

/**
 * UNLOCK reserved funds (locked -> available). In-transaction release.
 *   DR CARD_HOLD   CR <sourceAccount>
 */
async function unlockWallet({ client, userId, amount, reference, sourceAccount = 'CUSTOMER_WALLET', description = 'Unlock funds', actor = 'engine:unlock' }) {
  const amountN = Number(amount);
  const op = await claimOperation({ client, operationType: 'UNLOCK', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };

  const { rows } = await client.query(`SELECT wallet_balance, locked_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (rows.length === 0) throw new Error('User not found');
  const availBefore = Number(rows[0].wallet_balance);
  const lockedBefore = Number(rows[0].locked_balance);

  await postJournal({
    client,
    lines: [
      { accountCode: 'CARD_HOLD', direction: 'DR', amount: amountN },
      { accountCode: sourceAccount, direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });

  await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1, locked_balance = locked_balance - $1 WHERE id = $2`, [amountN, userId]);
  await auditBalance({ client, accountKind: 'USER_BALANCE', accountId: userId, operation: 'unlock', amount: amountN, balanceBefore: availBefore, balanceAfter: availBefore + amountN, reference, actor });
  await auditBalance({ client, accountKind: 'USER_LOCKED', accountId: userId, operation: 'unlock', amount: amountN, balanceBefore: lockedBefore, balanceAfter: lockedBefore - amountN, reference, actor });
  return { success: true, reference, unlocked: amountN };
}

/**
 * CAPTURE locked funds (locked funds permanently leave to MNO/merchant).
 *   DR CARD_HOLD   CR <toAccount>
 */
async function captureLock({ client, userId, amount, reference, toAccount = 'MNO_CLEARING', description = 'Capture locked funds', actor = 'engine:captureLock' }) {
  const amountN = Number(amount);
  const op = await claimOperation({ client, operationType: 'CAPTURE', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };

  const { rows } = await client.query(`SELECT locked_balance FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (rows.length === 0) throw new Error('User not found');
  const lockedBefore = Number(rows[0].locked_balance);

  await postJournal({
    client,
    lines: [
      { accountCode: 'CARD_HOLD', direction: 'DR', amount: amountN },
      { accountCode: toAccount, direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });

  await client.query(`UPDATE users SET locked_balance = locked_balance - $1 WHERE id = $2`, [amountN, userId]);
  await auditBalance({ client, accountKind: 'USER_LOCKED', accountId: userId, operation: 'capture', amount: amountN, balanceBefore: lockedBefore, balanceAfter: lockedBefore - amountN, reference, actor });
  return { success: true, reference, captured: amountN };
}

module.exports = {
  postJournal,
  postDeposit,
  holdFunds,
  releaseHold,
  captureHold,
  transfer,
  creditWallet,
  debitWallet,
  internalTransfer,
  walletToGroup,
  groupToWallet,
  lockWallet,
  unlockWallet,
  captureLock,
  claimOperation,
  auditBalance,
  recordException,
  accountIdByCode,
};
