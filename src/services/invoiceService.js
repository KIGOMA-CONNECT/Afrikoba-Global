/**
 * Merchant Invoices Service
 * Merchants issue itemised invoices (INV-* codes); customers settle them
 * through merchantService.payMerchant (the canonical merchant money path).
 * Payment is idempotent: an already-PAID invoice returns the recorded ref.
 */

const pool = require('../config/db');
const crypto = require('crypto');
const merchantService = require('./merchantService');
const { logAudit } = require('./auditService');

function invoiceError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

async function getMyMerchantId(userId) {
  const res = await pool.query(
    'SELECT id FROM merchants WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
    [userId]
  );
  if (res.rows.length === 0) {
    throw invoiceError('Jisajili kama biashara kwanza (POST /api/merchant/register).', 400);
  }
  return res.rows[0].id;
}

async function createInvoice(userId, { customerName, customerPhone, lineItems, amount, currency, note, expiresInHours }) {
  const merchantId = await getMyMerchantId(userId);

  let amountNum = parseFloat(amount);
  if (lineItems && Array.isArray(lineItems) && lineItems.length > 0) {
    const computed = lineItems.reduce((sum, it) => sum + (Number(it.quantity || 1) * Number(it.unit_price || 0)), 0);
    if (!amountNum || amountNum <= 0) amountNum = computed;
  }
  if (!amountNum || amountNum <= 0) {
    throw invoiceError('Kiasi kinahitajika (au vivezalisha line items).', 400);
  }

  const code = `INV-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const expiresHours = parseInt(expiresInHours, 10) || 168;

  const result = await pool.query(
    `INSERT INTO merchant_invoices
       (merchant_id, code, customer_name, customer_phone, line_items, amount, currency, note, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9 || ' hours')::interval)
     RETURNING *`,
    [merchantId, code, customerName || null, customerPhone || null,
      JSON.stringify(Array.isArray(lineItems) ? lineItems : []),
      amountNum, currency || 'TZS', note || null, Math.max(1, Math.min(expiresHours, 720))]
  );

  await logAudit({
    eventType: 'INVOICE', action: 'CREATE', entityType: 'MERCHANT_INVOICE', entityId: result.rows[0].id,
    userId, referenceId: code, amount: amountNum, afterData: { merchant_id: merchantId },
  });

  return result.rows[0];
}

async function listInvoices(userId) {
  const me = await pool.query('SELECT id FROM merchants WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]);
  if (me.rows.length === 0) return [];
  const result = await pool.query(
    'SELECT * FROM merchant_invoices WHERE merchant_id = $1 ORDER BY created_at DESC',
    [me.rows[0].id]
  );
  return result.rows;
}

async function getInvoiceByCode(code) {
  const result = await pool.query('SELECT * FROM merchant_invoices WHERE code = $1', [code]);
  if (result.rows.length === 0) {
    throw invoiceError('Invoice haipatikani.', 404);
  }
  return result.rows[0];
}

async function cancelInvoice(userId, invoiceId) {
  const merchantId = await getMyMerchantId(userId);
  const result = await pool.query(
    `UPDATE merchant_invoices SET status = 'CANCELLED'
     WHERE id = $1 AND merchant_id = $2 AND status = 'ISSUED'
     RETURNING *`,
    [invoiceId, merchantId]
  );
  if (result.rows.length === 0) {
    throw invoiceError('Invoice haipatikani au haiko ISSUED.', 404);
  }
  await logAudit({
    eventType: 'INVOICE', action: 'CANCEL', entityType: 'MERCHANT_INVOICE', entityId: invoiceId,
    userId, referenceId: result.rows[0].code,
  });
  return result.rows[0];
}

async function payInvoice(payerId, code, amount) {
  const invoice = await getInvoiceByCode(code);

  if (invoice.status === 'PAID') {
    return {
      success: true, paid: true, alreadyPaid: true,
      invoice: invoice.code, reference: invoice.transaction_reference, amount: Number(invoice.amount),
    };
  }
  if (invoice.status !== 'ISSUED') {
    throw invoiceError('Invoice imefutwa.', 400);
  }
  if (invoice.expires_at && new Date(invoice.expires_at) < new Date()) {
    throw invoiceError('Invoice imeisha muda wake.', 400);
  }

  const requested = amount ? parseFloat(amount) : Number(invoice.amount);
  if (requested <= 0) {
    throw invoiceError('Kiasi si sahihi.', 400);
  }
  if (requested > Number(invoice.amount)) {
    throw invoiceError('Kiasi kikubwa kuliko invoice.', 400);
  }

  const payment = await merchantService.payMerchant(payerId, invoice.merchant_id, requested, `Invoice ${invoice.code}`);

  await pool.query(
    `UPDATE merchant_invoices
     SET status = 'PAID', paid_at = NOW(), paid_by = $1, transaction_reference = $2
     WHERE id = $3 AND status = 'ISSUED'
     RETURNING id`,
    [payerId, payment.reference, invoice.id]
  );

  await logAudit({
    eventType: 'INVOICE', action: 'PAY', entityType: 'MERCHANT_INVOICE', entityId: invoice.id,
    userId: payerId, referenceId: payment.reference, amount: requested,
    afterData: { invoice: invoice.code, merchant_id: invoice.merchant_id },
  });

  return { success: true, paid: true, invoice: invoice.code, reference: payment.reference, amount: requested };
}

module.exports = { createInvoice, listInvoices, getInvoiceByCode, cancelInvoice, payInvoice };