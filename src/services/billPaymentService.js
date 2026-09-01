/**
 * Bill Payment Service
 * Pay utility bills (TANESCO, DAWASCO, etc.).
 */

const pool = require('../config/db');
const crypto = require('crypto');
const fin = require('./financialEngine');

async function getBillers(category = null) {
  let query = `SELECT * FROM billers WHERE is_active = TRUE`;
  const params = [];
  if (category) { query += ` AND category = $1`; params.push(category); }
  query += ` ORDER BY name`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function payBill(userId, { biller_id, account_number, amount }) {
  if (!biller_id || !account_number || !amount) throw new Error('Taarifa zote zinahitajika.');

  const biller = await pool.query(`SELECT * FROM billers WHERE id = $1 AND is_active = TRUE`, [biller_id]);
  if (biller.rows.length === 0) throw new Error('Haiwezekani. Biller haipatikani.');

  const b = biller.rows[0];
  if (amount < parseFloat(b.min_amount) || amount > parseFloat(b.max_amount)) {
    throw new Error(`Kiasi lazima kiwe kati ya TSh ${b.min_amount} na TSh ${b.max_amount}.`);
  }

  // Calculate fee
  let fee = 0;
  if (b.fee_type === 'FIXED') fee = parseFloat(b.fee_value);
  else if (b.fee_type === 'PERCENTAGE') fee = amount * parseFloat(b.fee_value) / 100;

  const totalCharged = amount + fee;

  const ref = `BILL-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await fin.debitWallet({
      client, userId, amount, reference: `${ref}:AMT`,
      toAccount: 'MNO_CLEARING',
      description: `Bill payment to ${b.name}`
    });
    if (fee > 0) {
      await fin.debitWallet({
        client, userId, amount: fee, reference: `${ref}:FEE`,
        toAccount: 'PLATFORM_FEES',
        description: `Bill payment fee to ${b.name}`
      });
    }

    const result = await client.query(
      `INSERT INTO bill_payments (user_id, biller_id, account_number, amount, fee, total_charged, reference, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'SUCCESS') RETURNING *`,
      [userId, biller_id, account_number, amount, fee, totalCharged, ref]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, meta)
       VALUES ($1, 'WITHDRAWAL', $2, 0, 'SUCCESS', $3, $4)`,
      [userId, totalCharged, ref, JSON.stringify({ type: 'BILL_PAYMENT', biller: b.name, account: account_number })]
    );

    await client.query('COMMIT');
    return { success: true, reference: ref, biller: b.name, amount, fee, total: totalCharged };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getBillPayments(userId, limit = 20) {
  const result = await pool.query(
    `SELECT bp.*, b.name AS biller_name, b.category
     FROM bill_payments bp JOIN billers b ON bp.biller_id = b.id
     WHERE bp.user_id = $1 ORDER BY bp.created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = { getBillers, payBill, getBillPayments };
