/* ============================================================
 * MERCHANT CONNECTED ACCOUNTS + PAYOUTS (Stripe-Connect-style)
 * Merchants link a settlement target, proceeds accumulate into
 * MERCHANT_BALANCE, and settlement runs are executed by admins
 * against the ledger (DR MERCHANT_BALANCE / CR PLATFORM_FEES +
 * CR MNO_CLEARING), mirroring the BAP payout rails.
 * ============================================================ */
const pool = require('../config/db');
const fin = require('./financialEngine');
const { generateReference } = require('../utils/helpers');
const { logAction } = require('./auditService');

function badge(msg, statusCode) {
  return Object.assign(new Error(msg), { statusCode });
}

/** Connected account for a merchant, or null. */
async function getConnectedAccountByMerchant(merchantId) {
  const r = await pool.query(
    'SELECT * FROM connected_merchant_accounts WHERE merchant_id = $1', [merchantId]
  );
  return r.rows[0] || null;
}

/** Connected account for the merchant owned by `userId`, or an error. */
async function getConnectedAccount(userId) {
  const m = await pool.query('SELECT * FROM merchants WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]);
  if (!m.rows[0]) throw badge('Huna biashara iliyosajiliwa.', 404);
  return { merchant: m.rows[0], account: await getConnectedAccountByMerchant(m.rows[0].id) };
}

async function merchantForUser(userId) {
  const m = await pool.query('SELECT * FROM merchants WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]);
  if (!m.rows[0]) throw badge('Huna biashara iliyosajiliwa.', 404);
  return m.rows[0];
}

/** Create / update the merchant's payout-target account. */
async function upsertConnectedAccount(userId, { payout_type, payout_reference, bank_name, account_holder }) {
  if (!payout_reference) throw badge('Payout reference inahitajika (namba ya MNO au akaunti ya benki).', 400);
  const merchant = await merchantForUser(userId);
  const type = (payout_type || 'MNO_PHONE').toUpperCase();
  if (!['MNO_PHONE', 'BANK_ACCOUNT'].includes(type)) {
    throw badge('Payout type inatakiwa kuwa MNO_PHONE au BANK_ACCOUNT.', 400);
  }
  const r = await pool.query(
    `INSERT INTO connected_merchant_accounts
       (merchant_id, payout_type, payout_reference, bank_name, account_holder, status)
     VALUES ($1,$2,$3,$4,$5,'PENDING')
     ON CONFLICT (merchant_id) DO UPDATE SET
       payout_type = EXCLUDED.payout_type,
       payout_reference = EXCLUDED.payout_reference,
       bank_name = EXCLUDED.bank_name,
       account_holder = EXCLUDED.account_holder,
       status = 'PENDING',
       updated_at = NOW()
     RETURNING *`,
    [merchant.id, type, payout_reference, bank_name || null, account_holder || null]
  );
  return r.rows[0];
}

/** Admin: list connected accounts with merchant info. */
async function adminListConnected() {
  const r = await pool.query(
    `SELECT c.*, m.name AS merchant_name, m.business_type, m.phone AS merchant_phone
     FROM connected_merchant_accounts c
     JOIN merchants m ON m.id = c.merchant_id
     ORDER BY c.created_at DESC`
  );
  return r.rows;
}

/** Admin: activate / suspend a connected account. */
async function adminSetConnectedStatus(adminId, accountId, status) {
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) throw badge('Hali inatakiwa kuwa ACTIVE au SUSPENDED.', 400);
  const setClauses = ['status = $1', 'updated_at = NOW()'];
  const params = [status];
  if (status === 'ACTIVE') {
    setClauses.push('kyc_verified_at = NOW()', `verified_by = $${params.length + 1}`);
    params.push(adminId);
  } else {
    setClauses.push('kyc_verified_at = kyc_verified_at', 'verified_by = verified_by');
  }
  params.push(accountId);
  const r = await pool.query(
    `UPDATE connected_merchant_accounts
     SET ${setClauses.join(', ')}
     WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (r.rows.length === 0) throw badge('Akaunti haipatikani.', 404);
  await logAction(adminId, 'MERCHANT_CONNECTED_' + status, 'CONNECTED_MERCHANT_ACCOUNT', accountId, {}, null);
  return r.rows[0];
}

/** Merchant: request a settlement. Reserves the balance immediately. */
async function requestPayout(userId, { amount }) {
  const amountN = Number(amount);
  if (!(amountN > 0)) throw badge('Kiasi batili.', 400);
  const merchant = await merchantForUser(userId);
  const account = await getConnectedAccountByMerchant(merchant.id);
  if (!account) throw badge('Unganisha akaunti ya payout (MNO/Bank) kwanza.', 404);
  if (account.status !== 'ACTIVE') throw badge('Akaunti ya payout haijaamilishwa na admin.', 409);
  if (amountN > Number(account.balance)) {
    throw badge(`Kiasi kinazidi salio linalopatikana (${Number(account.balance).toFixed(2)}).`, 400);
  }
  const feePercent = 1.0;
  const feeAmount = Math.round(amountN * feePercent) / 100;
  const netAmount = amountN - feeAmount;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reserved = await client.query(
      `UPDATE connected_merchant_accounts SET balance = balance - $1, updated_at = NOW()
       WHERE id = $2 AND balance >= $1 RETURNING balance`,
      [amountN, account.id]
    );
    if (reserved.rows.length === 0) throw badge('Salio halitoshi.', 409);
    const ref = generateReference('MPO');
    const payout = await client.query(
      `INSERT INTO merchant_payouts
        (payout_reference, merchant_id, account_id, gross_amount, fee_percent, fee_amount, net_amount, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8) RETURNING *`,
      [ref, merchant.id, account.id, amountN, feePercent, feeAmount, netAmount, userId]
    );
    await client.query('COMMIT');
    return payout.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Merchant: their own payout history. */
async function listPayouts(userId) {
  const merchant = await merchantForUser(userId);
  const r = await pool.query(
    `SELECT * FROM merchant_payouts WHERE merchant_id = $1 ORDER BY created_at DESC`,
    [merchant.id]
  );
  return r.rows;
}

/** Admin: list payouts, optionally by status. */
async function adminListPayouts(status = null) {
  const r = await pool.query(
    `SELECT p.*, m.name AS merchant_name, m.phone AS merchant_phone,
            c.payout_type, c.payout_reference AS target_reference
     FROM merchant_payouts p
     JOIN merchants m ON m.id = p.merchant_id
     LEFT JOIN connected_merchant_accounts c ON c.id = p.account_id
     WHERE ($1::text IS NULL OR p.status = $1)
     ORDER BY p.created_at DESC`,
    [status]
  );
  return r.rows;
}

/**
 * Admin: execute a PENDING payout. Journals DR MERCHANT_BALANCE (gross),
 * CR PLATFORM_FEES (fee) and CR MNO_CLEARING (net). Balance was already
 * reserved at request time.
 */
async function adminExecutePayout(adminId, payoutId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query(
      'SELECT * FROM merchant_payouts WHERE id = $1 AND status = \'PENDING\' FOR UPDATE', [payoutId]
    )).rows[0];
    if (!p) throw badge('Payout haipatikani au tayari imetengenezwa.', 404);

    const ref = p.payout_reference;
    const op = await fin.claimOperation({ client, operationType: 'MERCHANT_PAYOUT', reference: ref, userId: p.merchant_id, amount: Number(p.gross_amount) });
    if (!op.claimed) throw badge('Payout hii imeshatengenezwa (duplicate).', 409);

    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'MERCHANT_BALANCE', direction: 'DR', amount: Number(p.gross_amount) },
        { accountCode: 'PLATFORM_FEES', direction: 'CR', amount: Number(p.fee_amount) },
        { accountCode: 'MNO_CLEARING', direction: 'CR', amount: Number(p.net_amount) },
      ],
      referenceId: ref,
      description: `Merchant payout ${p.merchant_id} ${ref} (net ${p.net_amount})`,
      postedBy: `admin:${adminId}`,
    });

    const merchantUser = (await client.query('SELECT user_id FROM merchants WHERE id = $1', [p.merchant_id])).rows[0];
    if (merchantUser && merchantUser.user_id) {
      await client.query(
        `INSERT INTO transactions (user_id, type, total_charged, wallet_amount, commission, status, reference_id, meta)
         VALUES ($1, 'MERCHANT_PAYOUT', $2, $3, $4, 'SUCCESS', $5, $6::jsonb)`,
        [merchantUser.user_id, Number(p.gross_amount), 0, Number(p.fee_amount), ref,
         JSON.stringify({ feature: 'merchant_payout', net_amount: Number(p.net_amount), payout_reference: ref })]
      );
    }

    await client.query(
      `UPDATE merchant_payouts
       SET status = 'EXECUTED', executed_by = $1, executed_at = NOW(), ledger_ref = $2, updated_at = NOW()
       WHERE id = $3`,
      [adminId, ref, payoutId]
    );
    const { enqueueOutbox } = require('./outboxService');
    await enqueueOutbox({
      eventType: 'MERCHANT_PAYOUT_EXECUTED',
      aggregateId: String(payoutId),
      payload: { merchantId: p.merchant_id, payoutId, amount: Number(p.net_amount), gross: Number(p.gross_amount), fee: Number(p.fee_amount), reference: ref },
      reference: `PAYOUT:${payoutId}:${ref}`,
      tx: client,
    }).catch(() => {});
    await client.query('COMMIT');
    await logAction(adminId, 'MERCHANT_PAYOUT_EXECUTED', 'MERCHANT_PAYOUT', payoutId, { reference: ref, gross: p.gross_amount, net: p.net_amount }, null);
    return (await pool.query('SELECT * FROM merchant_payouts WHERE id = $1', [payoutId])).rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Credit a connected merchant's held proceeds (called from the accept-payment
 * flow): DR CUSTOMER_WALLET (payer) / CR MERCHANT_BALANCE + balance projection.
 * Returns { credited, account } — credited=false when the merchant has no
 * ACTIVE connected account (caller keeps the legacy path).
 */
async function creditMerchantProceeds({ client, merchantId, amount, reference, description }) {
  const account = (await client.query(
    'SELECT * FROM connected_merchant_accounts WHERE merchant_id = $1 AND status = \'ACTIVE\' FOR UPDATE', [merchantId]
  )).rows[0];
  if (!account) return { credited: false, account: null };
  const amountN = Number(amount);
  await fin.postJournal({
    client,
    lines: [
      { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
      { accountCode: 'MERCHANT_BALANCE', direction: 'CR', amount: amountN },
    ],
    referenceId: reference,
    description: description || `Merchant proceeds credit #${merchantId}`,
    postedBy: 'engine:merchant:pay',
  });
  await client.query(
    `UPDATE connected_merchant_accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
    [amountN, account.id]
  );
  return { credited: true, account };
}

module.exports = {
  getConnectedAccount,
  getConnectedAccountByMerchant,
  upsertConnectedAccount,
  adminListConnected,
  adminSetConnectedStatus,
  requestPayout,
  listPayouts,
  adminListPayouts,
  adminExecutePayout,
  creditMerchantProceeds,
};