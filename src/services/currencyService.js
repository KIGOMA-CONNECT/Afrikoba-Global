const pool = require('../config/db');

/**
 * Multi-currency service — exchange rates + conversion.
 * Rates are stored relative to TZS as base.
 */

/**
 * Get all active currencies.
 */
async function getCurrencies() {
  const result = await pool.query(
    'SELECT code, name, symbol, decimals FROM currencies WHERE is_active = TRUE ORDER BY code'
  );
  return result.rows;
}

/**
 * Get exchange rate between two currencies.
 * Returns { rate, from, to } or null if not found.
 */
async function getExchangeRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return { rate: 1, from: fromCurrency, to: toCurrency };

  const result = await pool.query(
    `SELECT rate FROM exchange_rates
     WHERE from_currency = $1 AND to_currency = $2
       AND (valid_until IS NULL OR valid_until > NOW())
     ORDER BY valid_from DESC LIMIT 1`,
    [fromCurrency, toCurrency]
  );

  if (result.rows.length === 0) return null;
  return { rate: parseFloat(result.rows[0].rate), from: fromCurrency, to: toCurrency };
}

/**
 * Convert amount from one currency to another.
 */
async function convert(amount, fromCurrency, toCurrency) {
  const rateData = await getExchangeRate(fromCurrency, toCurrency);
  if (!rateData) throw Object.assign(new Error(`Exchange rate ${fromCurrency}→${toCurrency} haipatikani.`), { statusCode: 400 });
  return {
    originalAmount: amount,
    fromCurrency,
    toCurrency,
    rate: rateData.rate,
    convertedAmount: parseFloat((amount * rateData.rate).toFixed(2)),
  };
}

/**
 * Update exchange rate (admin only).
 */
async function updateRate(fromCurrency, toCurrency, rate, source = 'MANUAL') {
  await pool.query(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_currency, to_currency, valid_from)
     DO UPDATE SET rate = $3, source = $4`,
    [fromCurrency, toCurrency, rate, source]
  );
  return { success: true, from: fromCurrency, to: toCurrency, rate };
}

/**
 * Get user's currency.
 */
async function getUserCurrency(userId) {
  const result = await pool.query('SELECT currency_code FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });
  return result.rows[0].currency_code || 'TZS';
}

/**
 * Set user's currency.
 */
async function setUserCurrency(userId, currencyCode) {
  const exists = await pool.query('SELECT code FROM currencies WHERE code = $1 AND is_active = TRUE', [currencyCode]);
  if (exists.rows.length === 0) throw Object.assign(new Error(`Sarafu ${currencyCode} haijaungwa.`), { statusCode: 400 });
  await pool.query('UPDATE users SET currency_code = $1 WHERE id = $2', [currencyCode, userId]);
  return { success: true, currency: currencyCode };
}

module.exports = { getCurrencies, getExchangeRate, convert, updateRate, getUserCurrency, setUserCurrency };
