/**
 * Merchant Payment Service
 * Pay merchants, list merchants, payment history.
 */

const pool = require('../config/db');
const crypto = require('crypto');
const fin = require('./financialEngine');
const { creditMerchantProceeds } = require('./merchantPayoutService');

async function registerMerchant(userId, { name, business_type, phone, email }) {
  const result = await pool.query(
    `INSERT INTO merchants (user_id, name, business_type, phone, email)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, name, business_type || 'OTHER', phone, email || null]
  );
  return result.rows[0];
}

async function getMerchants(search = null) {
  // Usirudishe email/user_id kwenye public endpoint (PII protection)
  let query = `SELECT id, name, business_type, phone, is_active FROM merchants WHERE is_active = TRUE`;
  const params = [];
  if (search) {
    query += ` AND (name ILIKE $1 OR phone = $2)`;
    params.push(`%${search}%`, search);
  }
  query += ` ORDER BY name ASC`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function payMerchant(
  payerId,
  merchantId,
  amount,
  description,
  { client: callerClient = null, reference = null } = {}
) {
  const amountN = Number(amount);

  if (!Number.isFinite(amountN) || amountN <= 0) {
    throw new Error('Kiasi lazima kiwe chanya.');
  }

  const client = callerClient || await pool.connect();
  const ownTransaction = !callerClient;

  try {
    if (ownTransaction) await client.query('BEGIN');

    const merchantRes = await client.query(
      `SELECT *
         FROM merchants
        WHERE id = $1
          AND is_active = TRUE
        FOR UPDATE`,
      [merchantId]
    );

    if (merchantRes.rows.length === 0) {
      throw new Error('Biashara haipatikani.');
    }

    const merchant = merchantRes.rows[0];
    const merchantUserId = merchant.user_id;
    const ref = reference ||
      `MERCH-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    const existingOp = await client.query(
      `SELECT operation_type, user_id, amount, status
         FROM financial_operations
        WHERE reference_id = $1
        FOR UPDATE`,
      [ref]
    );

    if (existingOp.rows.length) {
      const op = existingOp.rows[0];

      if (op.operation_type !== 'MERCHANT_PAYMENT') {
        throw new Error(`Reference ${ref} tayari inatumika kwa operation nyingine.`);
      }

      if (
        op.user_id !== null &&
        Number(op.user_id) !== Number(payerId)
      ) {
        throw new Error(`Reference ${ref} haihusiani na payer huyu.`);
      }

      if (Number(op.amount) !== amountN) {
        throw new Error(`Reference ${ref} ina kiasi tofauti.`);
      }

      if (op.status === 'SUCCESS') {
        const payment = await client.query(
          `SELECT merchant_id, payer_id, amount, reference, status
             FROM merchant_payments
            WHERE reference = $1
            ORDER BY id DESC
            LIMIT 1`,
          [ref]
        );

        if (payment.rows.length) {
          if (
            Number(payment.rows[0].merchant_id) !== Number(merchantId) ||
            Number(payment.rows[0].payer_id) !== Number(payerId) ||
            Number(payment.rows[0].amount) !== amountN ||
            payment.rows[0].status !== 'SUCCESS'
          ) {
            throw new Error(`Reference ${ref} ina merchant payment isiyolingana.`);
          }

          if (ownTransaction) await client.query('COMMIT');

          return {
            success: true,
            reference: ref,
            merchant: merchant.name,
            dedup: true,
          };
        }

        throw new Error(
          `Financial operation ${ref} iko SUCCESS lakini merchant payment haipo.`
        );
      }

      if (op.status === 'NEW') {
        throw new Error(
          `Reference ${ref} iko NEW bila merchant payment iliyokamilika.`
        );
      }

      throw new Error(`Reference ${ref} iko katika state ${op.status}.`);
    }

    const acc = await creditMerchantProceeds({
      client,
      payerId,
      merchantId,
      amount: amountN,
      reference: ref,
      description: `Merchant payment to ${merchant.name}`,
    });

    if (acc.dedup) {
      throw new Error(
        `Reference ${ref} ilidaiwa lakini merchant payment haikupatikana kama SUCCESS.`
      );
    }

    if (!acc.credited) {
      if (merchantUserId && Number(merchantUserId) !== Number(payerId)) {
        await fin.internalTransfer({
          client,
          fromUserId: payerId,
          toUserId: merchantUserId,
          amount: amountN,
          reference: ref,
          description: `Merchant payment to ${merchant.name}`,
        });
      } else {
        await fin.debitWallet({
          client,
          userId: payerId,
          amount: amountN,
          reference: ref,
          toAccount: 'SUSPENSE',
          description: `Merchant payment to ${merchant.name}`,
        });
      }
    }

    const paymentInsert = await client.query(
      `INSERT INTO merchant_payments
         (merchant_id, payer_id, amount, reference, description, status)
       VALUES ($1, $2, $3, $4, $5, 'SUCCESS')
       RETURNING id`,
      [
        merchantId,
        payerId,
        amountN,
        ref,
        description || `Malipo kwa ${merchant.name}`,
      ]
    );

    await client.query(
      `INSERT INTO transactions
         (user_id, type, total_charged, wallet_amount, commission,
          status, reference_id, meta)
       VALUES ($1, 'TRANSFER', $2, 0, 0, 'SUCCESS', $3, $4)`,
      [
        payerId,
        amountN,
        ref,
        JSON.stringify({
          merchant_id: merchantId,
          merchant_name: merchant.name,
          type: 'MERCHANT_PAYMENT',
          merchant_payment_id: paymentInsert.rows[0].id,
        }),
      ]
    );

    if (ownTransaction) {
      await client.query('COMMIT');
    }

    return {
      success: true,
      reference: ref,
      merchant: merchant.name,
      dedup: false,
    };
  } catch (error) {
    if (ownTransaction) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    if (ownTransaction) client.release();
  }
}
async function getMerchantPayments(merchantId) {
  const result = await pool.query(
    `SELECT mp.*, u.phone AS payer_phone, u.name AS payer_name
     FROM merchant_payments mp
     LEFT JOIN users u ON mp.payer_id = u.id
     WHERE mp.merchant_id = $1
     ORDER BY mp.created_at DESC`,
    [merchantId]
  );
  return result.rows;
}

module.exports = { registerMerchant, getMerchants, payMerchant, getMerchantPayments };
