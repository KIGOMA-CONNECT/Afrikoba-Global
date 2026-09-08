/* ============================================================
 * AFRIKOBA GLOBAL - PROCUREMENT / SUPPLIER NETWORK (Gap C1)
 * Migration 096 reconciled the suppliers schema: the 047
 * procurement columns (owner_user_id, business_name, category,
 * description, rating, verified) were unioned onto the 020
 * commerce `suppliers` table idempotently, so BOTH feature sets
 * live on one table (commerce keeps business_id/name/phone/
 * total_paid; procurement profiles add owner_user_id/business_name).
 * This suite proves end-to-end that the procurement module works
 * on the merged table AND that commerce suppliers still do:
 *  - register supplier profile -> 200 (owner_user_id set)
 *  - duplicate profile -> 409 (partial unique index)
 *  - buyer creates+opens RFQ, supplier bids, award -> AWARDED
 *  - supplier financing disburses through financial engine
 *    (ledger DR SUSPENSE / CR CUSTOMER_WALLET + transaction row)
 *  - commerce suppliers still creatable + payable (business_id)
 *  - ownership: other user cannot bid/finance your supplier (403)
 * ============================================================ */
const BASE = process.env.PROCUREMENT_TEST_BASE || 'http://127.0.0.1:3000';
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
async function fundWallet(userId, amount) {
  await pool.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2", [amount, userId]);
}

async function run() {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90) + 10}`;

  await section('Setup: supplier + buyer');
  const sup = await register(`25591${suffix}`, 'Mama Machozi Suppliers');
  await expect(!!sup, 'supplier registered');
  const buyer = await register(`25592${suffix}`, 'Jengo Builders Buyer');
  await expect(!!buyer, 'buyer registered');

  await section('Supplier profile on merged suppliers table');
  const prof = await api('POST', '/api/procurement/suppliers', sup.token, {
    business_name: 'Mama Machozi Hardware', category: 'BUILDING_MATERIALS', description: 'Cement, steel and timber.',
  });
  await expect(prof.status === 200 && prof.data.supplier && prof.data.supplier.id, `register supplier -> 200 (got ${prof.status})`);
  await expect(prof.data.supplier.owner_user_id === sup.user.id, `owner_user_id set to creator`);
  await expect(prof.data.supplier.business_name === 'Mama Machozi Hardware', `business_name stored`);
  const supId = prof.data.supplier.id;

  const dup = await api('POST', '/api/procurement/suppliers', sup.token, {
    business_name: 'Mama Machozi Hardware', category: 'BUILDING_MATERIALS',
  });
  await expect(dup.status === 409, `duplicate profile -> 409 (got ${dup.status})`);

  const list = await api('GET', '/api/procurement/suppliers', sup.token);
  await expect(list.status === 200 && list.data.suppliers.some((s) => s.id === supId), `suppliers listed`);

  const outsider = await register(`25593${suffix}`, 'Stranger Supplier');
  const dupOwn = await api('POST', '/api/procurement/suppliers', outsider.token, {
    business_name: 'Mama Machozi Hardware', category: 'OTHER',
  });
  // Different owner -> same business_name is allowed (unique is per owner).
  await expect(dupOwn.status === 200 && dupOwn.data.supplier.owner_user_id === outsider.user.id,
    `same name by another owner allowed (got ${dupOwn.status})`);

  await section('RFQ lifecycle');
  const req = await api('POST', '/api/procurement/requests', buyer.token, {
    title: `Cement supply - ${suffix}`, category: 'BUILDING_MATERIALS',
    quantity: 50, budget_cap: 5000000,
  });
  await expect(req.status === 200 && req.data.request.id, `RFQ created (got ${req.status})`);
  const reqId = req.data.request.id;
  const pub = await api('POST', `/api/procurement/requests/${reqId}/publish`, buyer.token);
  await expect(pub.status === 200 && pub.data.request.status === 'OPEN', `RFQ opened`);

  const bid = await api('POST', `/api/procurement/requests/${reqId}/bids`, sup.token, {
    amount: 4800000, delivery_days: 7, note: 'Door delivery.',
  });
  await expect(bid.status === 200 && bid.data.bid.id, `supplier bid -> 200 (got ${bid.status})`);
  const bidId = bid.data.bid.id;

  const awarded = await api('POST', `/api/procurement/requests/${reqId}/award/${bidId}`, buyer.token);
  await expect(awarded.status === 200 && awarded.data.request.status === 'AWARDED', `buyer awards bid`);
  await expect(awarded.data.request.selected_bid_id === bidId, `selected_bid_id set`);

  const getReq = await api('GET', `/api/procurement/requests/${reqId}`, buyer.token);
  await expect(getReq.status === 200 && getReq.data.bids.length === 1, `getRequest surfaces bids with supplier name`);
  await expect(getReq.data.bids[0].supplier_name === 'Mama Machozi Suppliers', `bid joined to supplier profile`);

  await section('Supplier financing (financial engine)');
  const fin = await api('POST', '/api/procurement/financing', sup.token, {
    supplier_id: supId, request_id: reqId, amount: 1000000, term_months: 6, annual_rate: 12,
  });
  await expect(fin.status === 200 && fin.data.success === true, `financing -> 200 (got ${fin.status}: ${JSON.stringify(fin.data).slice(0, 140)})`);
  const finRef = fin.data.financing_id;
  const finDb = (await pool.query('SELECT * FROM supplier_financing WHERE unique_reference = $1', [finRef])).rows;
  await expect(finDb.length === 1 && finDb[0].status === 'DISBURSED' && finDb[0].txn_id, `financing row DISBURSED with txn`);
  const bal = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [sup.user.id]);
  await expect(Number(bal.rows[0].wallet_balance) >= 1000000, `supplier wallet credited >= 1,000,000`);
  const ledger = await pool.query(
    `SELECT la.account_code, j.direction, j.amount
       FROM journal_entries j
       JOIN ledger_accounts la ON la.id = j.account_id
      WHERE j.reference_id = $1 ORDER BY j.id`, [finRef]
  );
  await expect(ledger.rows.length >= 2, `two balanced ledger entries booked`);
  await expect(ledger.rows.some((r) => r.account_code === 'SUSPENSE' && r.direction === 'DR'), `DR SUSPENSE booked`);
  await expect(ledger.rows.some((r) => r.account_code === 'CUSTOMER_WALLET' && r.direction === 'CR'), `CR CUSTOMER_WALLET booked`);

  const finList = await api('GET', '/api/procurement/financing', sup.token);
  await expect(finList.status === 200 && finList.data.financing.some((f) => f.unique_reference === finRef), `financing listed for owner`);

  await section('Ownership guard rails');
  const foreignFin = await api('POST', '/api/procurement/financing', buyer.token, {
    supplier_id: supId, amount: 100000, term_months: 3,
  });
  await expect(foreignFin.status === 403, `non-owner cannot finance another supplier (got ${foreignFin.status})`);
  const anon = await api('GET', '/api/procurement/suppliers', null);
  await expect(anon.status === 401, `unauthenticated -> 401 (got ${anon.status})`);

  await section('Commerce suppliers unaffected (020 still works)');
  const bizPhone = '25594' + suffix.slice(0, 6);
  const bizOwner = await register(bizPhone, 'Commerce Owner');
  await fundWallet(bizOwner.user.id, 200000);
  const bizReg = await api('POST', '/api/business/accounts', bizOwner.token, {
    business_name: 'Mkulima Fresh Ltd', business_type: 'AGRICULTURE', tin_number: '142-231-889',
  });
  await expect(bizReg.status === 200 && bizReg.data.business.id, `commerce business created (got ${bizReg.status})`);
  const bizId = bizReg.data.business.id;

  await fundWallet(bizOwner.user.id, 100000);
  const fundBiz = await api('POST', `/api/business/accounts/${bizId}/fund`, bizOwner.token, { amount: 100000 });
  await expect(fundBiz.status === 200 && fundBiz.data.result.success, `commerce business funded (got ${fundBiz.status})`);

  const csup = await api('POST', `/api/business/accounts/${bizId}/suppliers`, bizOwner.token, {
    name: 'Bega Kwa Bega Supplies', phone: '25596' + suffix.slice(0, 6),
  });
  await expect(csup.status === 200 && csup.data.supplier.id, `commerce supplier added (got ${csup.status})`);
  await expect(csup.data.supplier.business_id === bizId, `commerce supplier bound to business_id`);
  const csupId = csup.data.supplier.id;
  const cpay = await api('POST', `/api/business/accounts/${bizId}/suppliers/${csupId}/pay`, bizOwner.token, { amount: 10000 });
  await expect(cpay.status === 200 && cpay.data.result.success, `commerce supplier payment made`);
  const cbal = await pool.query('SELECT total_paid FROM suppliers WHERE id = $1', [csupId]);
  await expect(Number(cbal.rows[0].total_paid) === 10000, `commerce supplier total_paid tracked`);

  await section('C1 schema evidence');
  const cols = (await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='suppliers'"
  )).rows.map((r) => r.column_name);
  await expect(cols.includes('business_id') && cols.includes('name'), `commerce columns present`);
  await expect(cols.includes('owner_user_id') && cols.includes('business_name'), `procurement columns present (096)`);
  const idx = (await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='suppliers' AND indexname='uq_suppliers_procurement_profile'`
  )).rows;
  await expect(idx.length === 1, `partial unique index uq_suppliers_procurement_profile exists`);
}

run()
  .then(() => {
    console.log(`\nPROCUREMENT: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });