/* ============================================================
 * AFRIKOBA GLOBAL - AI INSIGHTS EXPANDED COVERAGE
 * Invoice / payroll / procurement generators added to
 * aiInsightService (blueprint Sec 89 gap: these domains were
 * previously "partial / not surfaced"). This suite proves:
 *  - a business owner with PENDING+OVERDUE invoices receives an
 *    INVOICE_CASHFLOW insight after /api/ai/insights/refresh
 *  - a business owner with growing payroll receives PAYROLL_HEALTH
 *  - a buyer with open RFQs and/or supplier financing receives
 *    PROCUREMENT_HEALTH
 *  - insights persist with model_version afri-ai-1.0 and are
 *    surfaced by GET /api/ai/insights
 *  - dismissing an insight flips the dismissed flag
 * ============================================================ */
const BASE = process.env.AI_INSIGHTS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}
async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.user) throw new Error(`register ${phoneNumber} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

async function run() {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90) + 10}`;

  await section('Setup: business owner + procurement buyer with fixtures');
  const owner = await register(`255801${suffix}`, 'AI Owner');
  const buyer = await register(`255802${suffix}`, 'AI Buyer');
  const ownerId = owner.user.id;
  const buyerId = buyer.user.id;

  // Business + invoices for the owner (one PENDING, one OVERDUE).
  const biz = await pool.query(
    `INSERT INTO business_accounts (owner_id, business_name, business_type, phone)
     VALUES ($1, 'Insights Traders ${suffix}', 'RETAIL', '255812345678') RETURNING id`,
    [ownerId]
  );
  await pool.query(
    `INSERT INTO business_invoices (business_id, invoice_number, customer_name, amount, tax_amount, total_amount, status, due_date)
     VALUES
      ($1, 'INV-${suffix}-1', 'Customer A', 100000, 0, 100000, 'PENDING', NOW() + INTERVAL '7 days'),
      ($1, 'INV-${suffix}-2', 'Customer B', 180000, 0, 180000, 'OVERDUE', NOW() - INTERVAL '3 days')`,
    [biz.rows[0].id]
  );
  await pool.query(
    `INSERT INTO payroll_runs (business_id, period, total_amount, employee_count)
     VALUES ($1, '${suffix}P1', 900000, 3)`,
    [biz.rows[0].id]
  );

  // Procurement buyer: one OPEN RFQ + a disbursed supplier financing (financing
  // linked to the buyer's RFQ, supplier owned by the owner's business).
  const supplier = await pool.query(
    `INSERT INTO suppliers (business_id, name, phone)
     VALUES ($1, 'Agro Supply ${suffix}', '255812345678') RETURNING id`,
    [biz.rows[0].id]
  );
  const rfq = await pool.query(
    `INSERT INTO procurement_requests (buyer_user_id, title, category, quantity, budget_cap, status)
     VALUES ($1, 'Maize ${suffix}', 'AGRICULTURE', 100, 2000000, 'OPEN') RETURNING id`,
    [buyerId]
  );
  await pool.query(
    `INSERT INTO supplier_financing (supplier_id, request_id, amount, term_months, annual_rate, status, unique_reference)
     VALUES ($1, $2, 800000, 3, 10.00, 'DISBURSED', 'SF-${suffix}')`,
    [supplier.rows[0].id, rfq.rows[0].id]
  );

  // Give payroll a previous month reference so PAYROLL_HEALTH computes (older run).
  await pool.query(
    `INSERT INTO payroll_runs (business_id, period, total_amount, employee_count, created_at)
     VALUES ($1, '${suffix}P0', 600000, 3, NOW() - INTERVAL '30 days')`,
    [biz.rows[0].id]
  );

  await section('Refresh generates invoice/payroll/procurement insights');
  const refresh = await api('POST', '/api/ai/insights/refresh', owner.token);
  await expect(refresh.status === 200 && refresh.data.success === true, `owner refresh 200 (got ${refresh.status})`);
  const ownerTypes = (refresh.data.insights || []).map((i) => i.insight_type);
  await expect(ownerTypes.includes('INVOICE_CASHFLOW'), `owner got INVOICE_CASHFLOW insight`);
  await expect(ownerTypes.includes('PAYROLL_HEALTH'), `owner got PAYROLL_HEALTH insight`);
  const flow = (refresh.data.insights || []).find((i) => i.insight_type === 'INVOICE_CASHFLOW');
  await expect(flow && flow.severity === 'alert', `overdue>pending invoice insight is severity=alert`);
  const payroll = (refresh.data.insights || []).find((i) => i.insight_type === 'PAYROLL_HEALTH');
  await expect(payroll && Number(payroll.metric) === 300000, `payroll insight flags 300k rise (got ${payroll ? payroll.metric : 'none'})`);

  const buyerRefresh = await api('POST', '/api/ai/insights/refresh', buyer.token);
  await expect(buyerRefresh.status === 200, `buyer refresh 200 (got ${buyerRefresh.status})`);
  const buyerInsights = buyerRefresh.data.insights || [];
  const buyerTypes = buyerInsights.map((i) => i.insight_type);
  await expect(buyerTypes.includes('PROCUREMENT_HEALTH'), `buyer got PROCUREMENT_HEALTH insight`);
  const proc = buyerInsights.find((i) => i.insight_type === 'PROCUREMENT_HEALTH' && Number(i.metric) === 800000);
  await expect(!!proc, `procurement insight notes 800k financing (got ${JSON.stringify(buyerInsights.filter((i) => i.insight_type === 'PROCUREMENT_HEALTH')).slice(0, 160)})`);

  const modelRows = (await pool.query(
    `SELECT model_version FROM ai_model_register
      WHERE scope_user_id = $1 ORDER BY id DESC LIMIT 1`, [ownerId]
  )).rows;
  await expect(modelRows.length === 1 && modelRows[0].model_version === 'afri-ai-1.0',
    `generation registered under afri-ai-1.0`);

  await section('Insights surfaced by GET and dismissible');
  const list = await api('GET', '/api/ai/insights', owner.token);
  await expect(list.status === 200 && list.data.insights.some((i) => i.insight_type === 'INVOICE_CASHFLOW'),
    `GET /api/ai/insights surfaces INVOICE_CASHFLOW`);
  const flowRow = (list.data.insights || []).find((i) => i.insight_type === 'INVOICE_CASHFLOW');
  if (flowRow) {
    const dismissed = await api('POST', `/api/ai/insights/${flowRow.id}/dismiss`, owner.token);
    await expect(dismissed.status === 200 && dismissed.data.dismissed && dismissed.data.dismissed.id === flowRow.id,
      `insight dismissed (got ${dismissed.status})`);
    const row = (await pool.query('SELECT dismissed FROM ai_insights WHERE id = $1 AND user_id = $2', [flowRow.id, ownerId])).rows[0];
    await expect(row && row.dismissed === true, `dismissed flag persisted in DB`);
  }

  await section('RBAC / auth');
  const anon = await api('GET', '/api/ai/insights', null);
  await expect(anon.status === 401, `unauthenticated insights -> 401 (got ${anon.status})`);

  // Cleanup fixtures so re-runs stay green.
  await pool.query(`DELETE FROM supplier_financing WHERE unique_reference = $1`, [`SF-${suffix}`]);
  await pool.query(`DELETE FROM procurement_requests WHERE id = $1`, [rfq.rows[0].id]);
  await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplier.rows[0].id]);
  await pool.query('DELETE FROM business_invoices WHERE business_id = $1', [biz.rows[0].id]);
  await pool.query('DELETE FROM payroll_runs WHERE business_id = $1', [biz.rows[0].id]);
  await pool.query('DELETE FROM business_accounts WHERE id = $1', [biz.rows[0].id]);
}

run()
  .then(() => {
    console.log(`\nAI INSIGHTS COVERAGE: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });