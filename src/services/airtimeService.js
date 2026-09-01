/**
 * Airtime/Data Purchase Service
 */

const pool = require('../config/db');
const crypto = require('crypto');
const fin = require('./financialEngine');

const PROVIDERS = {
  VODACOM: { name: 'Vodacom', prefixes: ['0754', '0755', '0756', '0757', '0758'] },
  AIRTEL: { name: 'Airtel', prefixes: ['0784', '0785', '0786', '0787'] },
  TIGO: { name: 'Tigo', prefixes: ['0713', '0714', '0715', '0716'] },
  HALOPESA: { name: 'HaloPesa', prefixes: ['0620', '0621', '0622', '0623'] },
};

async function getProducts(provider) {
  const products = {
    AIRTIME: [
      { id: 'AT-1000', name: 'TSh 1,000 Airtime', amount: 1000, type: 'AIRTIME' },
      { id: 'AT-2000', name: 'TSh 2,000 Airtime', amount: 2000, type: 'AIRTIME' },
      { id: 'AT-5000', name: 'TSh 5,000 Airtime', amount: 5000, type: 'AIRTIME' },
      { id: 'AT-10000', name: 'TSh 10,000 Airtime', amount: 10000, type: 'AIRTIME' },
    ],
    DATA: [
      { id: 'DT-500', name: '100MB/Day', amount: 500, validity: '1 day', data: '100MB' },
      { id: 'DT-1000', name: '300MB/Day', amount: 1000, validity: '1 day', data: '300MB' },
      { id: 'DT-3000', name: '1GB/Week', amount: 3000, validity: '7 days', data: '1GB' },
      { id: 'DT-5000', name: '2GB/Week', amount: 5000, validity: '7 days', data: '2GB' },
      { id: 'DT-10000', name: '5GB/Month', amount: 10000, validity: '30 days', data: '5GB' },
      { id: 'DT-20000', name: '12GB/Month', amount: 20000, validity: '30 days', data: '12GB' },
    ],
  };

  return products;
}

async function purchaseAirtime(userId, { phone, provider, product_id, amount }) {
  if (!phone || !provider || !amount) throw new Error('Taarifa zote zinahitajika.');
  if (!PROVIDERS[provider]) throw new Error('Mtoa huduma batili.');

  const ref = `AIR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await fin.debitWallet({
      client, userId, amount, reference: ref,
      toAccount: 'MNO_CLEARING',
      description: `Airtime purchase: ${phone}`
    });

    const result = await client.query(
      `INSERT INTO airtime_purchases (user_id, phone, provider, product_type, amount, reference, status)
       VALUES ($1, $2, $3, 'AIRTIME', $4, $5, 'SUCCESS') RETURNING *`,
      [userId, phone, provider, amount, ref]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, total_charged, commission, status, reference_id, meta)
       VALUES ($1, 'WITHDRAWAL', $2, 0, 'SUCCESS', $3, $4)`,
      [userId, amount, ref, JSON.stringify({ type: 'AIRTIME', phone, provider })]
    );

    await client.query('COMMIT');
    return { success: true, reference: ref, phone, provider: PROVIDERS[provider].name, amount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getPurchaseHistory(userId, limit = 20) {
  const result = await pool.query(
    `SELECT * FROM airtime_purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = { getProducts, purchaseAirtime, getPurchaseHistory, PROVIDERS };
