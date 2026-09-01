const pool = require('../config/db');
const { createAppError } = require('../utils/errorCodes');
const { tr } = require('../i18n');
const fin = require('../services/financialEngine');

/**
 * Unified multi-currency service.
 * - ONE canonical rate store: `exchange_rates` (ISO 4217 pairs).
 * - Rate resolution: direct pair → inverse pair → triangulated via TZS.
 * - Personal holdings live in `user_balances`; the primary wallet is TZS.
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

/** Direct pair lookup (active / not expired). */
async function findDirectPair(from, to) {
  const result = await pool.query(
    `SELECT rate FROM exchange_rates
     WHERE from_currency = $1 AND to_currency = $2
       AND (valid_until IS NULL OR valid_until > NOW())
     ORDER BY valid_from DESC LIMIT 1`,
    [from, to]
  );
  return result.rows.length ? parseFloat(result.rows[0].rate) : null;
}

/**
 * Resolve an exchange rate with fallbacks so every active currency pair works:
 *   1. direct pair          (from→to)
 *   2. inverse pair         (to→from) → 1/rate
 *   3. triangulation via TZS (from→TZS)×(TZS→to)
 * Returns { rate, from, to, source } or null.
 */
async function getExchangeRate(fromCurrency, toCurrency) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (from === to) return { rate: 1, from, to, source: 'IDENTITY' };

  const direct = await findDirectPair(from, to);
  if (direct !== null) return { rate: direct, from, to, source: 'DIRECT' };

  const inverse = await findDirectPair(to, from);
  if (inverse !== null && inverse !== 0) return { rate: 1 / inverse, from, to, source: 'INVERSE' };

  const fromTzs = await findDirectPair(from, 'TZS') ?? (await findDirectPair('TZS', from));
  const tzsTo = await findDirectPair('TZS', to) ?? (await findDirectPair(to, 'TZS'));
  if (fromTzs !== null && tzsTo !== null) {
    // from→TZS: direct if stored from→TZS, else 1/(TZS→from)
    const f2t = findDirectPair(from, 'TZS') !== null ? fromTzs : 1 / fromTzs;
    // TZS→to: direct if stored TZS→to, else 1/(to→TZS)
    const t2o = findDirectPair('TZS', to) !== null ? tzsTo : 1 / tzsTo;
    return { rate: f2t * t2o, from, to, source: 'TRIANGULATED' };
  }

  return null;
}

/**
 * Convert amount between two currencies (unified FX).
 */
async function convert(amount, fromCurrency, toCurrency) {
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) throw createAppError('WALLET_INVALID_AMOUNT');
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();

  const rateData = await getExchangeRate(from, to);
  if (!rateData) throw Object.assign(createAppError('FX_RATE_NOT_FOUND'), { _i18nVars: { from, to } });

  return {
    originalAmount: amountNum,
    fromCurrency: from,
    toCurrency: to,
    rate: rateData.rate,
    source: rateData.source,
    convertedAmount: parseFloat((amountNum * rateData.rate).toFixed(2)),
  };
}

/**
 * Rate to TZS for a currency (used by wallet/family foreign-currency pricing).
 */
async function getRateToTzs(currency) {
  const currencyCode = String(currency || '').toUpperCase();
  if (currencyCode === 'TZS') return 1;
  const r = await getExchangeRate(currencyCode, 'TZS');
  if (!r) throw Object.assign(createAppError('FX_RATE_NOT_FOUND'), { _i18nVars: { from: currencyCode, to: 'TZS' } });
  return r.rate;
}

/**
 * Update exchange rate (admin only).
 */
async function updateRate(fromCurrency, toCurrency, rate, source = 'MANUAL') {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  const rateNum = Number(rate);
  if (!Number.isFinite(rateNum) || rateNum <= 0) throw createAppError('WALLET_INVALID_AMOUNT');
  await validateActiveCurrency(from);
  await validateActiveCurrency(to);

  await pool.query(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_currency, to_currency, valid_from)
     DO UPDATE SET rate = $3, source = $4`,
    [from, to, rateNum, source]
  );
  return { success: true, from, to, rate: rateNum };
}

/** List all stored rates (admin). */
async function listRates() {
  const result = await pool.query(
    `SELECT from_currency, to_currency, rate, source, valid_from, valid_until
     FROM exchange_rates
     WHERE valid_until IS NULL OR valid_until > NOW()
     ORDER BY from_currency, to_currency`
  );
  return result.rows.map((r) => ({ ...r, rate: parseFloat(r.rate) }));
}

async function validateActiveCurrency(code) {
  const r = await pool.query('SELECT code FROM currencies WHERE code = $1 AND is_active = TRUE', [code]);
  if (!r.rows.length) throw Object.assign(createAppError('CURRENCY_NOT_SUPPORTED'), { _i18nVars: { code } });
}

/**
 * Get user's preferred display currency.
 */
async function getUserCurrency(userId) {
  const result = await pool.query('SELECT currency_code FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) throw Object.assign(createAppError('CURRENCY_USER_NOT_FOUND'), { statusCode: 404 });
  return result.rows[0].currency_code || 'TZS';
}

/**
 * Set user's preferred display currency.
 */
async function setUserCurrency(userId, currencyCode) {
  const code = String(currencyCode || '').toUpperCase();
  await validateActiveCurrency(code);
  await pool.query('UPDATE users SET currency_code = $1 WHERE id = $2', [code, userId]);
  return { success: true, currency: code };
}

/**
 * Personal multi-currency portfolio: TZS wallet + foreign holdings,
 * each annotated with live TZS conversion + total portfolio worth.
 */
async function getMyHoldings(userId) {
  const main = await pool.query('SELECT wallet_balance, locked_balance, currency_code FROM users WHERE id = $1', [userId]);
  const tzs = Number(main.rows[0]?.wallet_balance || 0);
  const tzsLocked = Number(main.rows[0]?.locked_balance || 0);

  const balances = await pool.query(
    'SELECT currency_code, balance FROM user_balances WHERE user_id = $1 AND balance <> 0 ORDER BY currency_code',
    [userId]
  );

  let tzsTotal = tzs;
  const currencies = [];
  for (const row of balances.rows) {
    let rate = null;
    try {
      rate = await getRateToTzs(row.currency_code);
    } catch (e) {
      rate = null;
    }
    const tzsValue = rate !== null ? Number((Number(row.balance) * rate).toFixed(2)) : null;
    if (tzsValue !== null) tzsTotal += tzsValue;
    currencies.push({ currency: row.currency_code, balance: Number(row.balance), rateToTzs: rate, tzsValue });
  }

  return {
    tzs,
    tzsLocked,
    currencies,
    tzsTotal: Number(tzsTotal.toFixed(2)),
    displayCurrency: main.rows[0]?.currency_code || 'TZS',
  };
}

/**
 * Convert between the user's own currency balances (ledgered).
 * Supports TZS ↔ foreign (TZS lives on users.wallet_balance) and
 * foreign ↔ foreign. Records an auditable transactions row
 * (CURRENCY_CONVERT) carrying fx_rate + fx_base_currency.
 */
async function convertHolding(userId, fromCurrency, toCurrency, amount) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  const amountNum = Number(amount);
  if (from === to) throw createAppError('WALLET_INVALID_AMOUNT');
  if (!Number.isFinite(amountNum) || amountNum <= 0) throw createAppError('WALLET_INVALID_AMOUNT');
  await validateActiveCurrency(from);
  await validateActiveCurrency(to);

  const rateData = await getExchangeRate(from, to);
  if (!rateData) throw Object.assign(createAppError('FX_RATE_NOT_FOUND'), { _i18nVars: { from, to } });
  const converted = parseFloat((amountNum * rateData.rate).toFixed(2));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fxRef = 'FX-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
    // Debit source
    if (from === 'TZS') {
      const u = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (Number(u.rows[0].wallet_balance) < amountNum) {
        throw createAppError('WALLET_INSUFFICIENT_FUNDS');
      }
      await fin.debitWallet({ client, userId, amount: amountNum, reference: fxRef + ':DR', toAccount: 'SUSPENSE', description: 'Currency conversion debit' });
    } else {
      const debit = await client.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND currency_code = $2 FOR UPDATE',
        [userId, from]
      );
      if (!debit.rows.length || Number(debit.rows[0].balance) < amountNum) {
        throw Object.assign(createAppError('CURRENCY_BALANCE_MISSING'), { _i18nVars: { currency: from } });
      }
      await client.query(
        'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND currency_code = $3',
        [amountNum, userId, from]
      );
    }

    // Credit destination
    if (to === 'TZS') {
      await fin.creditWallet({ client, userId, amount: converted, reference: fxRef + ':CR', fromAccount: 'SUSPENSE', description: 'Currency conversion credit' });
    } else {
      await client.query(
        `INSERT INTO user_balances (user_id, currency_code, balance) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, currency_code) DO UPDATE SET balance = user_balances.balance + $3`,
        [userId, to, converted]
      );
    }

    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, currency_code, fx_rate, fx_base_currency, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, $4, $5, $6, 'SUCCESS', 'CURRENCY_CONVERT', $7)`,
      [
        fxRef,
        userId,
        amountNum,
        from,
        rateData.rate,
        'TZS',
        JSON.stringify({ to, converted, rateSource: rateData.source }),
      ]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return { success: true, from, to, amount: amountNum, converted, rate: rateData.rate, source: rateData.source };
}

module.exports = {
  getCurrencies,
  getExchangeRate,
  convert,
  getRateToTzs,
  updateRate,
  listRates,
  getUserCurrency,
  setUserCurrency,
  getMyHoldings,
  convertHolding,
};