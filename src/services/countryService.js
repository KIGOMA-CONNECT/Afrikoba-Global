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

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

/**
 * Resolve the active country from an E.164-ish MSISDN by longest calling-code match
 * (e.g. '2557...' -> TZ, '2547...' -> KE). Guards against empty calling codes.
 */
async function getCountryByPhone(phone) {
  const digits = normalizePhone(phone);
  if (digits.length < 7) return null;
  const result = await pool.query(
    `SELECT * FROM supported_countries
     WHERE is_active = TRUE AND calling_code <> '' AND $1 LIKE (calling_code || '%')
     ORDER BY LENGTH(calling_code) DESC
     LIMIT 1`,
    [digits]
  );
  return result.rows[0] || null;
}

/** Resolve a user's regulatory country: users.country_code first, else phone prefix. */
async function getCountryForUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, country_code, phone_number FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const country = await getCountryByCode(rows[0].country_code);
  if (country) return country;
  return getCountryByPhone(rows[0].phone_number);
}

/** Public/regulator-facing projection of a country row's compliance attributes. */
async function getRegulatoryConfig(country) {
  if (!country) return null;
  return {
    code: country.code,
    name: country.name,
    currency: country.currency,
    region: country.region,
    callingCode: country.calling_code,
    maxDailyTransferLimit: country.max_daily_transfer_limit == null
      ? null : Number(country.max_daily_transfer_limit),
    withholdingTaxRate: Number(country.withholding_tax_rate || 0),
    kycDocTypeRequired: country.kyc_doc_type_required,
    license: {
      status: country.regulatory_license_status,
      name: country.regulatory_license_name
    },
    support: {
      phone: country.local_support_phone,
      email: country.local_compliance_email
    }
  };
}

function computeWithholdingTax(amount, taxRate) {
  const rate = Number(taxRate || 0);
  if (rate <= 0) return 0;
  return Math.round(Number(amount) * rate * 100) / 100;
}

/** Today's recorded outbound-transfer total for a user in a country (UTC day). */
async function getDailyUsage({ client = pool, userId, countryCode }) {
  const { rows } = await client.query(
    `SELECT total_amount FROM user_daily_transfer_totals
     WHERE user_id = $1 AND country_code = $2 AND txn_date = CURRENT_DATE`,
    [userId, countryCode]
  );
  return Number(rows[0]?.total_amount || 0);
}

function assertWithinDailyLimit(usage, amount, limit) {
  if (!limit || Number(limit) <= 0) return usage + Number(amount);
  const projected = usage + Number(amount);
  if (projected > Number(limit)) {
    throw Object.assign(new Error('Umefikia kikomo cha kila siku cha uhamisho kwa nchi hii.'), {
      statusCode: 402,
      code: 'REGULATORY_DAILY_LIMIT',
      data: { limit: Number(limit), used: usage, requested: Number(amount) }
    });
  }
  return projected;
}

/** Enforce a country's per-user daily outbound-transfer cap (no-op when no cap). */
async function enforceDailyTransferLimit({ client = pool, userId, countryCode, amount }) {
  const country = await getCountryByCode(countryCode);
  if (!country || country.max_daily_transfer_limit == null) return;
  const usage = await getDailyUsage({ client, userId, countryCode });
  assertWithinDailyLimit(usage, amount, country.max_daily_transfer_limit);
}

/** Append to today's per-country outbound total (idempotent bump per transfer). */
async function recordDailyTransfer({ client, userId, countryCode, amount }) {
  await client.query(
    `INSERT INTO user_daily_transfer_totals (user_id, country_code, txn_date, total_amount)
     VALUES ($1, $2, CURRENT_DATE, $3)
     ON CONFLICT (user_id, country_code, txn_date)
     DO UPDATE SET total_amount = user_daily_transfer_totals.total_amount + EXCLUDED.total_amount`,
    [userId, countryCode, amount]
  );
}

async function addCountry({
  code, name, currency, region, min_fee, percent_fee,
  calling_code, max_daily_transfer_limit, withholding_tax_rate, kyc_doc_type_required,
  regulatory_license_status, regulatory_license_name, local_support_phone, local_compliance_email
}) {
  const result = await pool.query(
    `INSERT INTO supported_countries
      (code, name, currency, region, min_fee, percent_fee, calling_code,
       max_daily_transfer_limit, withholding_tax_rate, kyc_doc_type_required,
       regulatory_license_status, regulatory_license_name, local_support_phone, local_compliance_email)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, ''),
             $8, COALESCE($9, 0), COALESCE($10, 'NATIONAL_ID'),
             COALESCE($11, 'SANDBOX'), $12, $13, $14) RETURNING *`,
    [code.toUpperCase(), name, currency.toUpperCase(), region, min_fee || 0, percent_fee || 0,
     calling_code || null, max_daily_transfer_limit ?? null, withholding_tax_rate ?? null,
     kyc_doc_type_required || null, regulatory_license_status || null, regulatory_license_name || null,
     local_support_phone || null, local_compliance_email || null]
  );
  return result.rows[0];
}

async function updateCountry(id, updates) {
  const allowed = [
    'name', 'currency', 'region', 'is_active', 'min_fee', 'percent_fee',
    'calling_code', 'max_daily_transfer_limit', 'withholding_tax_rate', 'kyc_doc_type_required',
    'regulatory_license_status', 'regulatory_license_name', 'local_support_phone', 'local_compliance_email'
  ];
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
      `SELECT id, wallet_balance, phone_number, full_name, country_code FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (userRes.rows.length === 0) throw new Error('Mtumiaji hajapatikana.');
    const user = userRes.rows[0];

    const sourceCountry = (await getCountryByCode(user.country_code))
      || (await getCountryByPhone(user.phone_number));

    const withholdingTaxRate = Number(sourceCountry?.withholding_tax_rate || 0);
    const withholdingTax = computeWithholdingTax(amountIn, withholdingTaxRate);

    await enforceDailyTransferLimit({
      client,
      userId,
      countryCode: sourceCountry?.code || 'TZ',
      amount: amountIn
    });

    if (Number(user.wallet_balance) < amountIn + withholdingTax) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    }

    const referenceId = generateReference('XB');
    const meta = {
      is_cross_border: true,
      source_country: sourceCountry?.code || null,
      target_country: country.code,
      target_currency: country.currency,
      exchange_rate: quote.rate,
      amount_out: amountOut,
      withholding_tax: withholdingTax,
      tax_rate: withholdingTaxRate,
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

    if (withholdingTax > 0) {
      await fin.debitWallet({
        client,
        userId,
        amount: withholdingTax,
        reference: `${referenceId}:WHT`,
        toAccount: 'GOVERNMENT_WHT',
        description: `Kodi ya withholding (${(withholdingTaxRate * 100).toFixed(2)}%) - ${sourceCountry?.name || 'nchi ya mtumiaji'}`,
        actor: 'engine:cross_border'
      });
    }

    await recordDailyTransfer({
      client,
      userId,
      countryCode: sourceCountry?.code || 'TZ',
      amount: amountIn
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
      withholdingTax,
      taxRate: withholdingTaxRate,
      sourceCountry: sourceCountry?.code || null,
      message: 'Muamala wa mpaka-mbali umekamilika na unashughulikiwa.'
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  listCountries, getCountryByCode, getCountryByPhone, getCountryForUser,
  getRegulatoryConfig, computeWithholdingTax, getDailyUsage,
  enforceDailyTransferLimit, recordDailyTransfer,
  addCountry, updateCountry, quoteTransfer, executeTransfer
};
