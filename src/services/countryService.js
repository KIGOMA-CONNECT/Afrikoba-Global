/**
 * Cross-Border / Country Service
 * Country & regulator abstraction over the FX engine. Countries have a currency,
 * region, and fee schedule. Enables regulator-aware cross-border payments.
 */

const pool = require('../config/db');
const currencyService = require('./currencyService');

async function listCountries(activeOnly = true) {
  let query = `SELECT * FROM supported_countries`;
  if (activeOnly) query += ` WHERE is_active = TRUE`;
  query += ` ORDER BY region ASC, name ASC`;
  const result = await pool.query(query);
  return result.rows;
}

async function getCountryByCode(code) {
  const result = await pool.query(
    `SELECT * FROM supported_countries WHERE code = $1 AND is_active = TRUE`,
    [code.toUpperCase()]
  );
  return result.rows[0] || null;
}

async function addCountry({ code, name, currency, region, min_fee, percent_fee }) {
  const result = await pool.query(
    `INSERT INTO supported_countries (code, name, currency, region, min_fee, percent_fee)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [code.toUpperCase(), name, currency.toUpperCase(), region, min_fee || 0, percent_fee || 0]
  );
  return result.rows[0];
}

async function updateCountry(id, updates) {
  const allowed = ['name', 'currency', 'region', 'is_active', 'min_fee', 'percent_fee'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      params.push(updates[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) throw new Error('Hakuna mabadiliko.');
  params.push(id);
  const result = await pool.query(
    `UPDATE supported_countries SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return result.rows[0];
}

/**
 * Quote a cross-border transfer: local-currency fees + FX conversion to target currency.
 * Returns amount_out (in target currency) given amount_in (TZS) and target country currency.
 */
async function quoteTransfer(fromCurrency, toCountryCode, amountIn) {
  const country = await getCountryByCode(toCountryCode);
  if (!country) throw new Error('Nchi haitambuliki au haifanyi kazi.');

  const amount = Number(amountIn);
  if (!amount || amount <= 0) throw new Error('Kiasi kinahitajika.');

  // Fee: percent of amount, floored at min_fee (in source currency).
  const percentFee = Number(country.percent_fee || 0);
  const minFee = Number(country.min_fee || 0);
  const fee = Math.max(amount * percentFee, minFee);

  const transferable = amount - fee;
  const rate = await currencyService.getExchangeRate(fromCurrency, country.currency);
  const amountOut = transferable * rate;

  return {
    country: { code: country.code, name: country.name, currency: country.currency, region: country.region },
    amountIn: amount,
    fee,
    rate,
    amountOut,
    netAfterFee: transferable,
  };
}

/**
 * Execute a cross-border transfer: deducts fee and principal from user wallet,
 * posts ledger entries, and records transaction.
 */
async function executeTransfer(userId, toCountryCode, amountIn, recipientDetails, note = null) {
  const quote = await quoteTransfer('TZS', toCountryCode, amountIn);
  const { fee, amountOut, netAfterFee, country } = quote;
  const fin = require('./financialEngine');
  const { generateReference } = require('../utils/helpers');
  const { logAudit } = require('./auditService');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      `SELECT id, wallet_balance, phone_number, full_name FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (userRes.rows.length === 0) throw new Error('Mtumiaji hajapatikana.');
    const user = userRes.rows[0];

    if (Number(user.wallet_balance) < amountIn) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    }

    const referenceId = generateReference('XB');
    const meta = {
      is_cross_border: true,
      target_country: country.code,
      target_currency: country.currency,
      exchange_rate: quote.rate,
      amount_out: amountOut,
      recipient: recipientDetails,
      note: note || null
    };

    const txResult = await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, $4, $5, 'SUCCESS', 'TRANSFER', $6)
       RETURNING id`,
      [referenceId, userId, netAfterFee, fee, amountIn, JSON.stringify(meta)]
    );

    const txId = txResult.rows[0].id;

    if (fee > 0) {
      await fin.debitWallet({
        client,
        userId,
        amount: fee,
        reference: `${referenceId}:FEE`,
        toAccount: 'COMMISSION',
        description: `Ada ya muamala wa kuelekea ${country.name}`,
        actor: 'engine:cross_border'
      });
    }

    await fin.debitWallet({
      client,
      userId,
      amount: netAfterFee,
      reference: `${referenceId}:PRN`,
      toAccount: 'REMITTANCE_CLEARING',
      description: `Tuma pesa kwenda ${country.name} (${amountOut} ${country.currency})`,
      actor: 'engine:cross_border'
    });

    await client.query(
      `INSERT INTO wallet_ledger (transaction_id, reference_id, from_user_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, NULL, $4, $5)`,
      [txId, referenceId, userId, amountIn, `Cross-border transfer to ${country.name}`]
    );

    await client.query('COMMIT');

    await logAudit({
      eventType: 'CROSS_BORDER_TRANSFER',
      action: 'CREATE',
      entityType: 'TRANSACTION',
      userId,
      referenceId,
      amount: amountIn,
      afterData: meta
    }).catch(() => {});

    return {
      success: true,
      referenceId,
      amountIn,
      fee,
      amountOut,
      currency: country.currency,
      message: 'Muamala wa mpaka-mbali umekamilika na unashughulikiwa.'
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { listCountries, getCountryByCode, addCountry, updateCountry, quoteTransfer, executeTransfer };
