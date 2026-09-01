/**
 * Business & Commerce OS
 * H1: Business accounts | H2: Payment links | H3: Invoices (tax-aware)
 * H4: Inventory | H5: Payroll | H6: Suppliers | H7: Sales analytics
 * H8: Business loans | H9: Tax & compliance | H10: Staff roles + POS
 */

const pool = require('../config/db');
const { transferWallet } = require('./walletService');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const fin = require('./financialEngine');

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function findUserByPhone(phone) {
  const r = await pool.query('SELECT id, full_name, phone_number, wallet_balance FROM users WHERE phone_number = $1', [phone.trim()]);
  return r.rows[0];
}

async function assertBusinessAccess(businessId, userId) {
  const biz = await pool.query('SELECT * FROM business_accounts WHERE id = $1', [businessId]);
  if (!biz.rows.length) throw Object.assign(new Error('Biashara haipatikani.'), { statusCode: 404 });
  if (biz.rows[0].owner_id !== userId) {
    const staff = await pool.query("SELECT * FROM business_members WHERE business_id = $1 AND user_id = $2 AND is_active = TRUE", [businessId, userId]);
    if (!staff.rows.length) throw Object.assign(new Error('Huna ufikiaji wa biashara hii.'), { statusCode: 403 });
  }
  return biz.rows[0];
}

/** Log a financial event to transactions (types walizoruhusiwa na CHECK). */
async function logTx(client, userId, amount, type, meta) {
  await client.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', $4, $5)`,
    [generateReference(), userId, amount, type, JSON.stringify(meta || {})]
  );
}

// ====================================================================
// H1: BUSINESS ACCOUNTS
// ====================================================================

async function registerBusiness(userId, data) {
  const { business_name, business_type, tax_id, description, currency } = data;
  if (!business_name) throw Object.assign(new Error('Jina la biashara ni lazima.'), { statusCode: 400 });
  const owner = await pool.query('SELECT phone_number FROM users WHERE id = $1', [userId]);
  const phone = data.phone || (owner.rows[0] && owner.rows[0].phone_number) || '';
  const tax = data.tin_number || data.tax_id || null;
  const res = await pool.query(
    `INSERT INTO business_accounts (owner_id, business_name, business_type, tax_id, phone, email, balance, currency, description)
     VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8) RETURNING *`,
    [userId, business_name, business_type || 'RETAIL', tax, phone, data.email || null, currency || 'TZS', description || null]
  );
  await logAudit(userId, 'BUSINESS_REGISTER', `Biashara ${business_name} imesajiliwa`).catch(() => {});
  return res.rows[0];
}

async function listBusinesses(userId) {
  const res = await pool.query(
    `SELECT DISTINCT b.* FROM business_accounts b
     LEFT JOIN business_members bm ON b.id = bm.business_id
     WHERE b.owner_id = $1 OR bm.user_id = $1 ORDER BY b.created_at DESC`,
    [userId]
  );
  return res.rows;
}

async function getBusiness(businessId, userId) {
  const biz = await assertBusinessAccess(businessId, userId);
  const invoices = await pool.query("SELECT id, invoice_number, total_amount, status FROM business_invoices WHERE business_id = $1 ORDER BY created_at DESC LIMIT 20", [businessId]);
  const links = await pool.query('SELECT id, reference, title, amount, status FROM payment_links WHERE business_id = $1 ORDER BY created_at DESC LIMIT 20', [businessId]);
  return { ...biz, invoices: invoices.rows, payment_links: links.rows };
}

async function fundBusiness(businessId, ownerId, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const biz = await assertBusinessAccess(businessId, ownerId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.debitWallet({ client, userId: ownerId, amount: amountNum, reference: generateReference('BIZFUND'), toAccount: 'BUSINESS_WALLET', description: 'Business wallet top-up' });
    await client.query('UPDATE business_accounts SET balance = balance + $1 WHERE id = $2', [amountNum, businessId]);
    await logTx(client, ownerId, amountNum, 'DEPOSIT', { feature: 'business_fund', business_id: businessId });
    await client.query('COMMIT');
    return { success: true, business: biz.business_name, amount: amountNum, message: 'Fedha zimeingia kwenye biashara.' };
  } finally { client.release(); }
}

async function businessToWallet(businessId, ownerId, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  await assertBusinessAccess(businessId, ownerId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT balance FROM business_accounts WHERE id = $1 FOR UPDATE', [businessId]);
    if (Number(b.rows[0].balance) < amountNum) throw Object.assign(new Error('Salio la biashara halitoshi.'), { statusCode: 400 });
    await client.query('UPDATE business_accounts SET balance = balance - $1 WHERE id = $2', [amountNum, businessId]);
    await fin.creditWallet({ client, userId: ownerId, amount: amountNum, reference: generateReference('BIZOUT'), fromAccount: 'BUSINESS_WALLET', description: 'Business withdraw to wallet' });
    await logTx(client, ownerId, amountNum, 'WITHDRAWAL', { feature: 'business_withdraw', business_id: businessId });
    await client.query('COMMIT');
    return { success: true, amount: amountNum, message: 'Fedha zimetolewa kwenye wallet yako.' };
  } finally { client.release(); }
}

// ====================================================================
// H2: PAYMENT LINKS
// ====================================================================

function linkReference() {
  return 'PL-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function createPaymentLink(businessId, ownerId, data) {
  const { title, amount, currency } = data;
  if (!title || !amount || Number(amount) <= 0) throw Object.assign(new Error('Jina na kiasi vinahitajika.'), { statusCode: 400 });
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query(
    `INSERT INTO payment_links (business_id, reference, title, currency, amount) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [businessId, linkReference(), title, currency || 'TZS', Number(amount)]
  );
  return res.rows[0];
}

async function listPaymentLinks(businessId, ownerId) {
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query('SELECT * FROM payment_links WHERE business_id = $1 ORDER BY created_at DESC', [businessId]);
  return res.rows;
}

async function payPaymentLink(reference, payerUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const link = await client.query("SELECT * FROM payment_links WHERE reference = $1 AND status = 'ACTIVE' FOR UPDATE", [reference]);
    if (!link.rows.length) throw Object.assign(new Error('Kiungo hakipatikani au hakitumiki.'), { statusCode: 404 });
    const l = link.rows[0];
    await fin.debitWallet({ client, userId: payerUserId, amount: l.amount, reference: `BIZLINK:${l.reference}:PAID`, toAccount: 'BUSINESS_WALLET', description: 'Payment link payment' });
    await client.query('UPDATE business_accounts SET balance = balance + $1 WHERE id = $2', [l.amount, l.business_id]);
    await client.query("UPDATE payment_links SET status = 'PAID', payer_user_id = $1, paid_amount = $2, paid_at = NOW() WHERE id = $3", [payerUserId, l.amount, l.id]);
    await logTx(client, payerUserId, Number(l.amount), 'TRANSFER', { feature: 'payment_link', payment_link: l.reference, business_id: l.business_id });
    await client.query('COMMIT');
    return { success: true, amount: Number(l.amount), reference: l.reference, message: 'Umefaulu kulipa.' };
  } finally { client.release(); }
}

// ====================================================================
// H3: INVOICES (tax-aware)
// ====================================================================

async function nextInvoiceNumber(client, businessId) {
  const r = await client.query('SELECT COUNT(*)::int AS c FROM business_invoices WHERE business_id = $1', [businessId]);
  return `AFK-${String(process.env.INVOICE_PREFIX || 'BIZ').toUpperCase()}-${String(new Date().getFullYear())}-${String(r.rows[0].c + 1).padStart(4, '0')}`;
}

async function createInvoice(businessId, ownerId, data) {
  const { customer_phone, customer_name, amount, tax_percent, due_date } = data;
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  await assertBusinessAccess(businessId, ownerId);
  const taxPct = Number(tax_percent) || 0;
  const taxAmount = Math.round(amountNum * taxPct) / 100;
  const total = amountNum + taxAmount;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const number = await nextInvoiceNumber(client, businessId);
    const res = await client.query(
      `INSERT INTO business_invoices (business_id, invoice_number, customer_phone, customer_name, amount, tax_percent, tax_amount, total_amount, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [businessId, number, customer_phone || null, customer_name || null, amountNum, taxPct, taxAmount, total, due_date || null]
    );
    await client.query('COMMIT');
    return res.rows[0];
  } finally { client.release(); }
}

async function listInvoices(businessId, ownerId, status) {
  await assertBusinessAccess(businessId, ownerId);
  let q = 'SELECT * FROM business_invoices WHERE business_id = $1';
  const params = [businessId];
  if (status) { q += ' AND status = $2'; params.push(status); }
  q += ' ORDER BY created_at DESC';
  const res = await pool.query(q, params);
  return res.rows;
}

async function payInvoice(invoiceId, payerUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query("SELECT * FROM business_invoices WHERE id = $1 AND status = 'PENDING' FOR UPDATE", [invoiceId]);
    if (!inv.rows.length) throw Object.assign(new Error('Ankara haipatikani au imelipwa.'), { statusCode: 404 });
    const i = inv.rows[0];
    await fin.debitWallet({ client, userId: payerUserId, amount: i.total_amount, reference: `BIZINV:${i.invoice_number}:PAID`, toAccount: 'BUSINESS_WALLET', description: 'Invoice payment' });
    await client.query('UPDATE business_accounts SET balance = balance + $1 WHERE id = $2', [i.total_amount, i.business_id]);
    await client.query("UPDATE business_invoices SET status = 'PAID', paid_at = NOW() WHERE id = $1", [invoiceId]);
    await logTx(client, payerUserId, Number(i.total_amount), 'TRANSFER', { feature: 'invoice', invoice_number: i.invoice_number, business_id: i.business_id });
    await client.query('COMMIT');
    return { success: true, amount: Number(i.total_amount), invoice_number: i.invoice_number, message: 'Ankara imelipwa.' };
  } finally { client.release(); }
}

// ====================================================================
// H4: INVENTORY
// ====================================================================

async function addProduct(businessId, ownerId, data) {
  const { name, sku, unit_price, stock_quantity, low_stock_threshold } = data;
  if (!name || !unit_price) throw Object.assign(new Error('Jina na bei vinahitajika.'), { statusCode: 400 });
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query(
    `INSERT INTO products (business_id, name, sku, unit_price, stock_quantity, low_stock_threshold)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [businessId, name, sku || null, Number(unit_price), Number(stock_quantity) || 0, Number(low_stock_threshold) || 5]
  );
  return res.rows[0];
}

async function listProducts(businessId, ownerId) {
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query('SELECT * FROM products WHERE business_id = $1 ORDER BY created_at DESC', [businessId]);
  return res.rows;
}

async function updateStock(productId, ownerId, delta) {
  const deltaNum = parseInt(delta, 10);
  if (Number.isNaN(deltaNum)) throw Object.assign(new Error('Badiliko la hisa si sahihi.'), { statusCode: 400 });
  const p = await pool.query('SELECT business_id FROM products WHERE id = $1', [productId]);
  if (!p.rows.length) throw Object.assign(new Error('Bidhaa haipatikani.'), { statusCode: 404 });
  await assertBusinessAccess(p.rows[0].business_id, ownerId);
  await pool.query('UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2', [deltaNum, productId]);
  const res = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
  return res.rows[0];
}

async function lowStockProducts(businessId, ownerId) {
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query('SELECT * FROM products WHERE business_id = $1 AND stock_quantity <= low_stock_threshold', [businessId]);
  return res.rows;
}

// ====================================================================
// H5: PAYROLL
// ====================================================================

async function runPayroll(businessId, ownerId, period, employees) {
  if (!period) throw Object.assign(new Error('Kipindi kinahitajika.'), { statusCode: 400 });
  if (!Array.isArray(employees) || !employees.length) throw Object.assign(new Error('Orodha ya wafanyakazi inahitajika.'), { statusCode: 400 });
  let total = 0;
  for (const e of employees) {
    if (!e.phone || !e.amount || Number(e.amount) <= 0) throw Object.assign(new Error('Mfanyakazi ana data isiyokamilika.'), { statusCode: 400 });
    total += Number(e.amount);
  }
  await assertBusinessAccess(businessId, ownerId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT balance FROM business_accounts WHERE id = $1 FOR UPDATE', [businessId]);
    if (Number(b.rows[0].balance) < total) throw Object.assign(new Error(`Salio la biashara halitoshi kwa payroll (${formatMoney(total)}).`), { statusCode: 400 });
    await client.query('UPDATE business_accounts SET balance = balance - $1 WHERE id = $2', [total, businessId]);
    const run = await client.query(
      `INSERT INTO payroll_runs (business_id, period, total_amount, employee_count, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [businessId, period, total, employees.length, ownerId]
    );
    let paid = 0, failed = 0;
    for (const e of employees) {
      const emp = await client.query('SELECT id FROM users WHERE phone_number = $1', [e.phone.trim()]);
      if (!emp.rows.length) { failed++; continue; }
      await fin.creditWallet({ client, userId: emp.rows[0].id, amount: e.amount, reference: `BIZPAYROLL:${run.rows[0].id}:${e.phone}`, fromAccount: 'BUSINESS_WALLET', description: 'Payroll payment' });
      await client.query(
        `INSERT INTO payroll_items (payroll_run_id, employee_phone, employee_name, amount, status) VALUES ($1,$2,$3,$4,'PROCESSED')`,
        [run.rows[0].id, e.phone, e.name || emp.rows[0].id, Number(e.amount)]
      );
      paid++;
    }
    await logTx(client, ownerId, total, 'BULK_PAYMENT', { feature: 'payroll', payroll_run: run.rows[0].id, period });
    await client.query('COMMIT');
    return { success: true, payroll_run: run.rows[0], paid, failed, message: `Payroll ya ${formatMoney(total)} imefanyika.` };
  } finally { client.release(); }
}

async function listPayroll(businessId, ownerId) {
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query('SELECT * FROM payroll_runs WHERE business_id = $1 ORDER BY created_at DESC', [businessId]);
  return res.rows;
}

// ====================================================================
// H6: SUPPLIERS
// ====================================================================

async function addSupplier(businessId, ownerId, data) {
  const { name, phone } = data;
  if (!name) throw Object.assign(new Error('Jina la muuzaji linahitajika.'), { statusCode: 400 });
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query('INSERT INTO suppliers (business_id, name, phone) VALUES ($1,$2,$3) RETURNING *', [businessId, name, phone || null]);
  return res.rows[0];
}

async function listSuppliers(businessId, ownerId) {
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query('SELECT * FROM suppliers WHERE business_id = $1 ORDER BY created_at DESC', [businessId]);
  return res.rows;
}

async function paySupplier(businessId, ownerId, supplierId, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  await assertBusinessAccess(businessId, ownerId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT balance FROM business_accounts WHERE id = $1 FOR UPDATE', [businessId]);
    if (Number(b.rows[0].balance) < amountNum) throw Object.assign(new Error('Salio la biashara halitoshi.'), { statusCode: 400 });
    const sup = await client.query('SELECT * FROM suppliers WHERE id = $1 AND business_id = $2', [supplierId, businessId]);
    if (!sup.rows.length) throw Object.assign(new Error('Muuzaji hapatikani.'), { statusCode: 404 });
    await client.query('UPDATE business_accounts SET balance = balance - $1 WHERE id = $2', [amountNum, businessId]);
    await client.query('UPDATE suppliers SET total_paid = total_paid + $1 WHERE id = $2', [amountNum, supplierId]);
    const ref = generateReference();
    await client.query('INSERT INTO supplier_payments (business_id, supplier_id, amount, reference) VALUES ($1,$2,$3,$4)', [businessId, supplierId, amountNum, ref]);
    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'BUSINESS_WALLET', direction: 'DR', amount: amountNum },
        { accountCode: 'MNO_CLEARING', direction: 'CR', amount: amountNum },
      ],
      referenceId: `BIZSUP:${ref}:PAID`, description: 'Supplier payment from business float',
    });
    await logTx(client, ownerId, amountNum, 'BULK_PAYMENT', { feature: 'supplier_payment', supplier_id: supplierId, supplier: sup.rows[0].name });
    await client.query('COMMIT');
    return { success: true, amount: amountNum, supplier: sup.rows[0].name, message: 'Malipo ya muuzaji yamefanyika.' };
  } finally { client.release(); }
}

// ====================================================================
// H7: SALES ANALYTICS
// ====================================================================

async function salesAnalytics(businessId, ownerId) {
  await assertBusinessAccess(businessId, ownerId);
  const inv = await pool.query("SELECT COALESCE(SUM(total_amount),0) AS revenue, COUNT(*)::int AS count FROM business_invoices WHERE business_id = $1 AND status = 'PAID'", [businessId]);
  const links = await pool.query("SELECT COALESCE(SUM(paid_amount),0) AS revenue, COUNT(*)::int AS count FROM payment_links WHERE business_id = $1 AND status = 'PAID'", [businessId]);
  const products = await pool.query('SELECT COUNT(*)::int AS count FROM products WHERE business_id = $1', [businessId]);
  return {
    revenue: {
      invoices: Number(inv.rows[0].revenue),
      payment_links: Number(links.rows[0].revenue),
      total: Number(inv.rows[0].revenue) + Number(links.rows[0].revenue),
    },
    counts: { paid_invoices: inv.rows[0].count, paid_links: links.rows[0].count, products: products.rows[0].count },
  };
}

// ====================================================================
// H8: BUSINESS LOANS
// ====================================================================

async function applyBusinessLoan(userId, businessId, data) {
  const { amount, interest_rate, term_months } = data;
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const biz = await pool.query('SELECT * FROM business_accounts WHERE id = $1 AND owner_id = $2', [businessId, userId]);
  if (!biz.rows.length) throw Object.assign(new Error('Biashara haipatikani au sio yako.'), { statusCode: 403 });
  const res = await pool.query(
    `INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [businessId, userId, amountNum, Number(interest_rate) || 10, Number(term_months) || 12]
  );
  return res.rows[0];
}

async function listBusinessLoans(userId, isAdmin) {
  if (isAdmin) {
    const res = await pool.query('SELECT bl.*, ba.business_name FROM business_loans bl JOIN business_accounts ba ON bl.business_id = ba.id ORDER BY bl.created_at DESC');
    return res.rows;
  }
  const res = await pool.query(
    `SELECT bl.*, ba.business_name FROM business_loans bl JOIN business_accounts ba ON bl.business_id = ba.id
     WHERE bl.applicant_user_id = $1 OR ba.owner_id = $1 ORDER BY bl.created_at DESC`,
    [userId]
  );
  return res.rows;
}

async function adminApproveLoan(loanId, adminId, note) {
  const loan = await pool.query("SELECT * FROM business_loans WHERE id = $1 AND status = 'PENDING' FOR UPDATE", [loanId]);
  if (!loan.rows.length) throw Object.assign(new Error('Mkopo haupatikani au haiko katika status ya PENDING.'), { statusCode: 404 });
  const res = await pool.query(
    `UPDATE business_loans SET status = 'APPROVED', admin_note = $1, approved_at = NOW() WHERE id = $2 RETURNING *`,
    [note || null, loanId]
  );
  await logAudit(adminId, 'LOAN_APPROVED', `Mkopo #${loanId} umeidhinishwa`).catch(() => {});
  return res.rows[0];
}

async function adminDisburseLoan(loanId, adminId) {
  const loan = await pool.query("SELECT * FROM business_loans WHERE id = $1 AND status = 'APPROVED' FOR UPDATE", [loanId]);
  if (!loan.rows.length) throw Object.assign(new Error('Mkopo haupatikani au haujaiddhinishwa.'), { statusCode: 404 });
  const l = loan.rows[0];
  const rate = Number(l.interest_rate);
  const due = Math.round(Number(l.amount) * (1 + rate / 100));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE business_accounts SET balance = balance + $1 WHERE id = $2', [l.amount, l.business_id]);
    await client.query(
      `UPDATE business_loans SET status = 'DISBURSED', disbursed_at = NOW(), due_amount = $1 WHERE id = $2`,
      [due, loanId]
    );
    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'MNO_CLEARING', direction: 'DR', amount: Number(l.amount) },
        { accountCode: 'BUSINESS_WALLET', direction: 'CR', amount: Number(l.amount) },
      ],
      referenceId: `BIZLOAN:${loanId}:DISBURSE`, description: 'Business loan disbursed into float',
    });
    await logTx(client, l.applicant_user_id, Number(l.amount), 'DEPOSIT', { feature: 'business_loan', loan_id: loanId });
    await client.query('COMMIT');
    await logAudit(adminId, 'LOAN_DISBURSED', `Mkopo #${loanId} umetolewa`).catch(() => {});
    return { success: true, amount: Number(l.amount), due_amount: due, message: 'Mkopo umetolewa kwenye biashara.' };
  } finally { client.release(); }
}

async function repayLoan(userId, loanId, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const loan = await pool.query("SELECT * FROM business_loans WHERE id = $1 AND status = 'DISBURSED'", [loanId]);
  if (!loan.rows.length) throw Object.assign(new Error('Mkopo haupatikani au haujatolewa.'), { statusCode: 404 });
  const l = loan.rows[0];
  const biz = await pool.query('SELECT owner_id, balance FROM business_accounts WHERE id = $1', [l.business_id]);
  if (!biz.rows.length || biz.rows[0].owner_id !== userId) throw Object.assign(new Error('Biashara haipatikani au sio yako.'), { statusCode: 403 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (Number(biz.rows[0].balance) < amountNum) throw Object.assign(new Error('Salio la biashara halitoshi.'), { statusCode: 400 });
    await client.query('UPDATE business_accounts SET balance = balance - $1 WHERE id = $2', [amountNum, l.business_id]);
    const newPaid = Number(l.paid_amount) + amountNum;
    const status = newPaid >= Number(l.due_amount) ? 'REPAID' : 'DISBURSED';
    await client.query('UPDATE business_loans SET paid_amount = $1, status = $2 WHERE id = $3', [newPaid, status, loanId]);
    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'BUSINESS_WALLET', direction: 'DR', amount: amountNum },
        { accountCode: 'MNO_CLEARING', direction: 'CR', amount: amountNum },
      ],
      referenceId: `BIZREPAY:${loanId}:${Date.now()}`, description: 'Business loan repayment from float',
    });
    await logTx(client, userId, amountNum, 'TRANSFER', { feature: 'loan_repayment', loan_id: loanId });
    await client.query('COMMIT');
    return { success: true, amount: amountNum, status, message: `Rejesho la mkopo limepokelewa (${formatMoney(newPaid)}/${formatMoney(l.due_amount)}).` };
  } finally { client.release(); }
}

// ====================================================================
// H9: TAX & COMPLIANCE
// ====================================================================

async function taxSummary(businessId, ownerId) {
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query(
    `SELECT COALESCE(SUM(tax_amount),0) AS collected_tax, COALESCE(SUM(total_amount),0) AS taxed_revenue,
            COUNT(*)::int AS taxed_invoices
     FROM business_invoices WHERE business_id = $1 AND status = 'PAID'`,
    [businessId]
  );
  const all = await pool.query('SELECT id, invoice_number, amount, tax_percent, tax_amount, total_amount, status, created_at FROM business_invoices WHERE business_id = $1 ORDER BY created_at DESC', [businessId]);
  const r = res.rows[0];
  return {
    summary: {
      collected_tax: Number(r.collected_tax),
      taxed_revenue: Number(r.taxed_revenue),
      taxed_invoices: r.taxed_invoices,
    },
    register: all.rows,
  };
}

// ====================================================================
// H10: STAFF ROLES + POS SESSIONS
// ====================================================================

async function addStaff(businessId, ownerId, data) {
  const { user_phone, role } = data;
  if (!user_phone) throw Object.assign(new Error('Simu ya mfanyakazi inahitajika.'), { statusCode: 400 });
  await assertBusinessAccess(businessId, ownerId);
  const u = await findUserByPhone(user_phone);
  if (!u) throw Object.assign(new Error('Mtumiaji hapatikani.'), { statusCode: 404 });
  const res = await pool.query(
    `INSERT INTO business_members (business_id, user_id, role, permissions, is_active) VALUES ($1,$2,$3,'{view}',TRUE)
     ON CONFLICT (business_id, user_id) DO UPDATE SET role = $3, is_active = TRUE
     RETURNING id, business_id, user_id, role, is_active`,
    [businessId, u.id, role || 'CASHIER']
  );
  return res.rows[0];
}

async function listStaff(businessId, ownerId) {
  await assertBusinessAccess(businessId, ownerId);
  const res = await pool.query(
    'SELECT bm.*, u.full_name, u.phone_number FROM business_members bm JOIN users u ON bm.user_id = u.id WHERE bm.business_id = $1',
    [businessId]
  );
  return res.rows;
}

async function openPosSession(businessId, userId, openingCash) {
  const biz = await assertBusinessAccess(businessId, userId);
  if (biz.owner_id !== userId) {
    const staff = await pool.query("SELECT * FROM business_members WHERE business_id = $1 AND user_id = $2 AND is_active = TRUE", [businessId, userId]);
    if (!staff.rows.length) throw Object.assign(new Error('Huna ruhusa ya POS.'), { statusCode: 403 });
  }
  const res = await pool.query(
    `INSERT INTO pos_sessions (business_id, cashier_user_id, opening_cash) VALUES ($1,$2,$3) RETURNING *`,
    [businessId, userId, Number(openingCash) || 0]
  );
  return res.rows[0];
}

async function closePosSession(sessionId, userId, closingCash, salesTotal) {
  const sess = await pool.query("SELECT * FROM pos_sessions WHERE id = $1 AND status = 'OPEN' FOR UPDATE", [sessionId]);
  if (!sess.rows.length) throw Object.assign(new Error('Kipindi cha POS hakipatikani au kimefungwa.'), { statusCode: 404 });
  const s = sess.rows[0];
  await assertBusinessAccess(s.business_id, userId);
  const close = Number(closingCash) || 0;
  const sales = Number(salesTotal) || (close - Number(s.opening_cash));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delta = close - Number(s.opening_cash);
    await client.query(
      `UPDATE pos_sessions SET status = 'CLOSED', closing_cash = $1, sales_total = $2, closed_at = NOW() WHERE id = $3`,
      [close, sales, sessionId]
    );
    if (delta > 0) {
      await client.query('UPDATE business_accounts SET balance = balance + $1 WHERE id = $2', [delta, s.business_id]);
      await fin.postJournal({
        client,
        lines: [
          { accountCode: 'MNO_CLEARING', direction: 'DR', amount: delta },
          { accountCode: 'BUSINESS_WALLET', direction: 'CR', amount: delta },
        ],
        referenceId: `BIZPOS:${sessionId}:CLOSE`, description: 'POS sales deposited into business float',
      });
      await logTx(client, userId, delta, 'DEPOSIT', { feature: 'pos_sales', pos_session: sessionId });
    }
    await client.query('COMMIT');
    return { success: true, sales, deposited: delta > 0 ? delta : 0, message: 'Kipindi cha POS kimefungwa.' };
  } finally { client.release(); }
}

module.exports = {
  registerBusiness, listBusinesses, getBusiness, fundBusiness, businessToWallet,
  createPaymentLink, listPaymentLinks, payPaymentLink,
  createInvoice, listInvoices, payInvoice,
  addProduct, listProducts, updateStock, lowStockProducts,
  runPayroll, listPayroll,
  addSupplier, listSuppliers, paySupplier,
  salesAnalytics,
  applyBusinessLoan, listBusinessLoans, adminApproveLoan, adminDisburseLoan, repayLoan,
  taxSummary,
  addStaff, listStaff, openPosSession, closePosSession,
};