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

module.exports = { listCountries, getCountryByCode, addCountry, updateCountry, quoteTransfer };
