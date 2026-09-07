/* ============================================================
 * AFRIKOBA GLOBAL - FIELD PARTNER API (Kiva-style)
 * Migration 091: field partners gain a linked FIELD_PARTNER
 * operator, a PARTNER_BALANCE-backed lendable pool, and a loan
 * book (onboard borrower -> disburse -> repay). This suite proves:
 *  - admin creates/funds a partner; pool projection mirrors the
 *    PARTNER_BALANCE ledger account
 *  - admin binds a staff user as FIELD_PARTNER operator
 *  - partner onboards a borrower loan (total_due incl. interest)
 *  - disburse credits the borrower wallet and debits the pool
 *    (DR PARTNER_BALANCE / CR CUSTOMER_WALLET, journal-verified)
 *  - pool-insufficient disburses are refused (400)
 *  - field-collected partial repayment + borrower self-repayment
 *    repay the loan, restore the pool, and balance the journals
 *  - over-repayment and status violations are refused
 *  - RBAC: non-partner users get 403; borrower sees own loans
 * ============================================================ */
const BASE = process.env.FIELD_PARTNERS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');

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
async function makeAdmin(regData) {
  if (!regData || !regData.user || !regData.user.id) return null;
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [regData.user.id]);
  return regData.user.id;
}
async function seedWallet(userId, amount, reference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({ client, userId, amount, reference, fromAccount: 'SUSPENSE', description: 'Field partner test seed' });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function balanceOf(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}
async function partnerBalance(partnerId) {
  const r = await pool.query('SELECT available_balance FROM field_partners WHERE id = $1', [partnerId]);
  return Number(r.rows[0].available_balance);
}

async function run() {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90) + 10}`;

  await section('Setup: admin + FIELD_PARTNER staff + borrower, seed wallets');
  const adm = await register(`255801${suffix}`, 'FP Admin');
  const staff = await register(`255802${suffix}`, 'FP Staff');
  const borrower = await register(`255803${suffix}`, 'FP Borrower');
  const outsider = await register(`255804${suffix}`, 'FP Outsider');
  const admId = await makeAdmin(adm);
  await expect(!!admId, 'admin promoted');
  const staffId = staff.user.id;
  const borrowerId = borrower.user.id;
  await seedWallet(borrowerId, 500000, `FP-SEED-${suffix}`);
  await expect((await balanceOf(borrowerId)) === 500000, `borrower seeded 500k (got ${await balanceOf(borrowerId)})`);

  const adminToken = adm.token;
  const staffToken = staff.token;
  const borrowerToken = borrower.token;
  const outsiderToken = outsider.token;

  await section('Admin creates + funds a field partner');
  const created = await api('POST', '/api/field-partners', adminToken, {
    name: `Morogoro Field Partners ${suffix}`,
    region: 'Morogoro',
    countryCode: 'TZ',
    riskRating: 'LOW',
  });
  await expect(created.status === 201 && !!created.data.partner, `partner created (got ${created.status})`);
  const partnerId = created.data.partner.id;

  const fundRef = `FP-FUND-${suffix}`;
  const funded = await api('POST', `/api/field-partners/${partnerId}/fund`, adminToken, { amount: 1000000, reference: fundRef });
  await expect(funded.status === 200 && funded.data.funded === 1000000, `partner funded 1M (got ${funded.status})`);
  await expect((await partnerBalance(partnerId)) === 1000000, `pool projection 1M (got ${await partnerBalance(partnerId)})`);

  const partnerJersey = await pool.query(
    `SELECT direction, amount FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE l.account_code = 'PARTNER_BALANCE' AND j.reference_id = $1`,
    [fundRef]
  );
  await expect(partnerJersey.rows.length === 1 && partnerJersey.rows[0].direction === 'CR'
    && Number(partnerJersey.rows[0].amount) === 1000000,
    `PARTNER_BALANCE journal CR 1M (got ${JSON.stringify(partnerJersey.rows[0])})`);

  await section('Admin binds staff as FIELD_PARTNER operator');
  const bound = await api('PUT', `/api/field-partners/${partnerId}/bind-user`, adminToken, { userId: staffId });
  await expect(bound.status === 200 && bound.data.partner.user_id === staffId, `staff bound to partner (got ${bound.status})`);
  const roleRow = await pool.query('SELECT role FROM users WHERE id = $1', [staffId]);
  await expect(roleRow.rows[0].role === 'FIELD_PARTNER', `staff role promoted to FIELD_PARTNER (got ${roleRow.rows[0].role})`);

  await section('Partner onboards + disburses a borrower loan');
  const loan = await api('POST', '/api/field-partners/loans', staffToken, {
    borrowerUserId: borrowerId, amount: 200000, interestRate: 10, termMonths: 12, purpose: 'AGRICULTURE',
  });
  await expect(loan.status === 201 && loan.data.loan.status === 'PENDING', `loan created PENDING (got ${loan.status})`);
  await expect(Number(loan.data.loan.total_due) === 220000, `total_due 220k = 200k + 10% (got ${loan.data.loan.total_due})`);
  const loanId = loan.data.loan.id;
  const loanRef = loan.data.loan.loan_reference;

  const before = await balanceOf(borrowerId);
  const disb = await api('POST', `/api/field-partners/loans/${loanId}/disburse`, staffToken);
  await expect(disb.status === 200 && disb.data.disbursed === 200000, `loan disbursed 200k (got ${disb.status})`);
  await expect((await balanceOf(borrowerId)) === before + 200000, `borrower wallet +200k (got ${await balanceOf(borrowerId)})`);
  await expect((await partnerBalance(partnerId)) === 800000, `pool down to 800k (got ${await partnerBalance(partnerId)})`);
  const j = await pool.query(
    `SELECT j.direction, j.amount, l.account_code
     FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE j.reference_id = $1`,
    [`${loanRef}:DSB`]
  );
  const dr = j.rows.find((r) => r.direction === 'DR');
  const cr = j.rows.find((r) => r.direction === 'CR');
  await expect(dr && cr && dr.account_code === 'PARTNER_BALANCE' && Number(dr.amount) === 200000
    && cr.account_code === 'CUSTOMER_WALLET' && Number(cr.amount) === 200000,
    `disburse journal DR PARTNER_BALANCE / CR CUSTOMER_WALLET 200k`);

  await section('Pool-insufficient disbursement refused');
  const bigLoan = await api('POST', '/api/field-partners/loans', staffToken, {
    borrowerUserId: borrowerId, amount: 2000000, interestRate: 0, termMonths: 6,
  });
  await expect(bigLoan.status === 201, `oversized loan created (got ${bigLoan.status})`);
  const bigDisb = await api('POST', `/api/field-partners/loans/${bigLoan.data.loan.id}/disburse`, staffToken);
  await expect(bigDisb.status === 400 && bigDisb.data.code === 'FIELD_PARTNER_POOL_INSUFFICIENT',
    `disburse refused 400 (got ${bigDisb.status} ${bigDisb.data.code})`);

  await section('Field-collected partial repayment');
  const rep = await api('POST', `/api/field-partners/loans/${loanId}/repay`, staffToken, { amount: 120000, note: 'field collection' });
  await expect(rep.status === 200 && Number(rep.data.outstanding) === 100000 && rep.data.fullyRepaid === false,
    `partial repayment outstanding 100k (got ${rep.status} ${rep.data.outstanding})`);
  await expect((await partnerBalance(partnerId)) === 920000, `pool restored to 920k (got ${await partnerBalance(partnerId)})`);

  await section('Borrower self-repays remainder; loan REPAID');
  const selfRep = await api('POST', `/api/field-partners/my-loans/${loanId}/repay`, borrowerToken, { amount: 100000 });
  await expect(selfRep.status === 200 && Number(selfRep.data.outstanding) === 0 && selfRep.data.fullyRepaid === true,
    `self-repay settles (got ${selfRep.status})`);
  await expect((await partnerBalance(partnerId)) === 1020000, `pool ends at 1020k (got ${await partnerBalance(partnerId)})`);

  const statusRow = await pool.query('SELECT status FROM field_partner_loans WHERE id = $1', [loanId]);
  await expect(statusRow.rows[0].status === 'REPAID', `loan status REPAID (got ${statusRow.rows[0].status})`);
  const ledgerNet = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN j.direction = 'CR' THEN j.amount ELSE -j.amount END), 0) AS net
     FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE l.account_code = 'PARTNER_BALANCE' AND (j.reference_id = $1 OR j.reference_id LIKE $2)`,
    [fundRef, `${loanRef}%`]
  );
  const netAfterCycle = Number(ledgerNet.rows[0].net);
  await expect(netAfterCycle === (await partnerBalance(partnerId)),
    `ledger PARTNER_BALANCE net (${netAfterCycle}) == pool projection (${await partnerBalance(partnerId)})`);

  await section('Over-repayment + status guards');
  const over = await api('POST', `/api/field-partners/loans/${loanId}/repay`, staffToken, { amount: 500 });
  await expect(over.status === 400 && over.data.code === 'FP_LOAN_STATUS_INVALID',
    `repay on REPAID loan refused (got ${over.status} ${over.data.code})`);

  await section('Borrower visibility + RBAC');
  const mine = await api('GET', '/api/field-partners/my-loans', borrowerToken);
  const myLoan = (mine.data.loans || []).find((l) => l.id === loanId);
  await expect(mine.status === 200 && myLoan && myLoan.partner_name && Number(myLoan.paid_amount) === 220000,
    `borrower sees loan with partner + paid 220k`);
  const none = await api('GET', '/api/field-partners/my-loans', outsiderToken);
  await expect(none.status === 200 && none.data.loans.length === 0, `outsider sees no loans`);

  const otherLoan = await api('POST', '/api/field-partners/loans', outsiderToken, {
    partnerId, borrowerUserId: borrowerId, amount: 50000, interestRate: 0, termMonths: 3,
  });
  await expect(otherLoan.status === 403 && otherLoan.data.code === 'FIELD_PARTNER_UNAUTHORIZED',
    `non-partner cannot open loans 403 (got ${otherLoan.status} ${otherLoan.data.code})`);

  const anon = await api('GET', '/api/field-partners/loans', null);
  await expect(anon.status === 401, `unauthenticated loans -> 401 (got ${anon.status})`);

  const summary = await api('GET', '/api/field-partners/my', staffToken);
  await expect(summary.status === 200 && Number(summary.data.summary.active_loans) === 0
    && Number(summary.data.summary.pending_loans) === 1,
    `summary: 0 active + 1 pending (got ${summary.status})`);
  const _jAdmin = await api('GET', '/api/field-partners/all', adminToken);
  await expect(_jAdmin.status === 200 && Array.isArray(_jAdmin.data.partners), `admin can list all partners`);
}

run()
  .then(() => {
    console.log(`\nFIELD PARTNER API: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });