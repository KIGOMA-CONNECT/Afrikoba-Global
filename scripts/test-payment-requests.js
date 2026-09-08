/* ============================================================
 * AFRIKOBA GLOBAL - PAYMENT REQUESTS (request-to-pay)
 * A user (requester) asks another user (payer, by phone) for money.
 * The payer settles through the canonical wallet transfer path:
 *   - PRQ-<ref> request created (payer resolved, self-request blocked)
 *   - incoming/outgoing listing split by role
 *   - payer pays -> wallet transfer (TR-<ref>), request marked PAID
 *     with transaction_reference, requester credited
 *   - cancel by requester (CANCELLED), non-payer cannot see/pay,
 *     expired requests auto-marked EXPIRED, already-paid is idempotent
 *   - RBAC: unauthenticated requests blocked (401)
 * ============================================================ */
const BASE = process.env.PAYMENT_REQUESTS_TEST_BASE || 'http://127.0.0.1:3000';
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
async function fundUser(id, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, id]);
}

async function run() {
  const runSalt = String(Date.now()).slice(-5);
  const suffix = `${runSalt}${Math.floor(Math.random() * 90) + 10}`;

  await section('Schema evidence (migration 098)');
  const colsRes = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_name = 'payment_requests'`
  );
  const names = new Set(colsRes.rows.map((r) => `${r.table_name}:${r.column_name}`));
  const requiredCols = ['id', 'requester_id', 'payer_id', 'payer_phone', 'amount', 'note', 'reference', 'status', 'expires_at', 'paid_at', 'transaction_reference', 'created_at'];
  for (const c of requiredCols) {
    await expect(names.has(`payment_requests:${c}`), `column present: payment_requests:${c}`);
  }

  await section('Setup: register users, fund all');
  const requester = await register(`255821${suffix}`, `ReqOne${suffix}`);
  const payer = await register(`255822${suffix}`, `PayerOne${suffix}`);
  const stranger = await register(`255823${suffix}`, `Stranger${suffix}`);
  await fundUser(requester.user.id, 30000);
  await fundUser(payer.user.id, 40000);
  await fundUser(stranger.user.id, 10000);
  const requesterPhone = requester.user.phone_number;
  const payerPhone = payer.user.phone_number;
  await expect(true, 'users registered');

  await section('Request lifecycle');
  const createRes = await api('POST', '/api/banking/payment-requests', requester.token, {
    payerPhone,
    amount: 5000,
    note: 'Pesa za chakula',
  });
  await expect(createRes.status === 200, 'create request 200', JSON.stringify(createRes.data).slice(0, 160));
  const reqId = createRes.data.request && createRes.data.request.id;
  await expect(Boolean(reqId), 'request id present');
  await expect(createRes.data.request.reference.startsWith('PRQ-'), 'reference PRQ-*', createRes.data.request.reference);
  await expect(Number(createRes.data.request.amount) === 5000, 'amount matches');
  await expect(createRes.data.request.status === 'PENDING', 'status PENDING');

  const selfRes = await api('POST', '/api/banking/payment-requests', requester.token, {
    payerPhone: requesterPhone, amount: 1000,
  });
  await expect(selfRes.status === 400, 'self-request blocked', String(selfRes.status));

  const unknownRes = await api('POST', '/api/banking/payment-requests', requester.token, {
    payerPhone: '255700000000', amount: 1000,
  });
  await expect(unknownRes.status === 404, 'unknown payer -> 404', String(unknownRes.status));

  await section('Incoming/outgoing listing');
  const incoming = await api('GET', '/api/banking/payment-requests', payer.token);
  await expect(incoming.data.incoming.some((r) => r.id === reqId), 'payer sees incoming request');
  const outgoing = await api('GET', '/api/banking/payment-requests', requester.token);
  await expect(outgoing.data.outgoing.some((r) => r.id === reqId), 'requester sees outgoing request');
  const strangerList = await api('GET', '/api/banking/payment-requests', stranger.token);
  await expect(!strangerList.data.incoming.some((r) => r.id === reqId), 'stranger not listed as payer');

  await section('Payer pays via canonical transfer path');
  const payRes = await api('POST', `/api/banking/payment-requests/${reqId}/pay`, payer.token, { note: 'Sawa nimepiga' });
  await expect(payRes.status === 200, 'pay 200', JSON.stringify(payRes.data).slice(0, 160));
  await expect(payRes.data.status === 'PAID', 'returned PAID');
  await expect(String(payRes.data.transaction_reference).startsWith('TR-'), 'transaction_reference TR-*');

  const txn = await pool.query(
    `SELECT t.* FROM transactions t WHERE t.reference_id = $1`,
    [payRes.data.transaction_reference]
  );
  await expect(txn.rows.length === 1, 'transactions row exists');
  await expect(txn.rows[0].type === 'TRANSFER' && txn.rows[0].status === 'SUCCESS', 'txn TRANSFER/SUCCESS');
  await expect(Number(txn.rows[0].wallet_amount) === 5000, 'txn amount 5000');
  const txnMeta = txn.rows[0].meta || {};
  await expect(Number(txnMeta.to_user_id) === requester.user.id, 'txn credits requester');

  await expect(Number(payRes.data.amount) === 5000, 'pay amount 5000');

  const journal = await pool.query(
    `SELECT direction, amount FROM journal_entries WHERE reference_id = $1`, [payRes.data.transaction_reference]
  );
  await expect(journal.rows.length === 2, 'balanced journal pair (2 lines)');
  if (journal.rows.length === 2) {
    const jdr = journal.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
    const jcr = journal.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
    await expect(jdr === jcr && jdr === 5000, 'journal DR=CR balanced at 5000', `DR=${jdr} CR=${jcr}`);
  }

  const walletRes = await pool.query(
    `SELECT id, wallet_balance FROM users WHERE id IN ($1,$2) ORDER BY id`,
    [requester.user.id, payer.user.id]
  );
  const requesterRow = walletRes.rows.find((r) => r.id === requester.user.id);
  const payerRow = walletRes.rows.find((r) => r.id === payer.user.id);
  await expect(Number(requesterRow.wallet_balance) === 35000, 'requester credited 30000+5000=35000', String(requesterRow.wallet_balance));
  await expect(Number(payerRow.wallet_balance) === 35000, 'payer debited 40000-5000=35000', String(payerRow.wallet_balance));

  const ledger = await pool.query(
    `SELECT * FROM wallet_ledger WHERE reference_id = $1`,
    [payRes.data.transaction_reference]
  );
  await expect(ledger.rows.length === 1, 'wallet_ledger row');
  await expect(ledger.rows[0].from_user_id === payer.user.id && ledger.rows[0].to_user_id === requester.user.id, 'ledger payer->requester');

  await section('Idempotent re-pay + cancel + expiry');
  const repay = await api('POST', `/api/banking/payment-requests/${reqId}/pay`, payer.token, {});
  await expect(repay.data.alreadyPaid === true, 're-pay idempotent (alreadyPaid)', String(repay.data.alreadyPaid));
  await expect(String(repay.data.transaction_reference) === String(payRes.data.transaction_reference), 'same reference returned');

  const cancelRes = await api('POST', '/api/banking/payment-requests/999999/cancel', requester.token, {});
  await expect(cancelRes.status === 404, 'cancel missing -> 404', String(cancelRes.status));

  const c2 = await api('POST', '/api/banking/payment-requests', requester.token, {
    payerPhone, amount: 8000, note: 'Cancel me',
  });
  await expect(c2.data.request.status === 'PENDING', 'second request created');
  const cancelOk = await api('POST', `/api/banking/payment-requests/${c2.data.request.id}/cancel`, requester.token, {});
  await expect(cancelOk.status === 200 && cancelOk.data.request.status === 'CANCELLED', 'requester cancels PENDING');
  await expect(Number(cancelOk.data.request.amount) === 8000, 'cancelled request amount kept');

  const c3 = await api('POST', '/api/banking/payment-requests', requester.token, { payerPhone, amount: 7000 });
  await expect(c3.data.request.status === 'PENDING', 'third request created');
  await pool.query(
    `UPDATE payment_requests SET expires_at = NOW() - interval '1 hour' WHERE id = $1`,
    [c3.data.request.id]
  );
  const expiryPay = await api('POST', `/api/banking/payment-requests/${c3.data.request.id}/pay`, payer.token, {});
  await expect(expiryPay.status === 400, 'expired request -> 400', String(expiryPay.status));
  const dbStatus = await pool.query(`SELECT status FROM payment_requests WHERE id = $1`, [c3.data.request.id]);
  await expect(dbStatus.rows[0].status === 'EXPIRED', 'stale request auto-marked EXPIRED');

  await section('RBAC + audit');
  const unauth = await api('GET', '/api/banking/payment-requests', null);
  await expect(unauth.status === 401, 'unauthenticated -> 401', String(unauth.status));
  const audit = await pool.query(
    `SELECT action, entity_type, entity_id, meta FROM audit_logs
     WHERE (entity_type = 'PAYMENT_REQUEST' AND entity_id = $1)
        OR (entity_type = 'TRANSACTION' AND action = 'TRANSFER')
     ORDER BY id DESC LIMIT 10`,
    [reqId]
  );
  await expect(audit.rows.some((r) => r.entity_type === 'TRANSACTION' && JSON.stringify(r.meta || '').includes(payRes.data.transaction_reference)),
    'audit TRANSFER on paid request');
  await expect(audit.rows.some((r) => r.entity_type === 'PAYMENT_REQUEST' && Number(r.entity_id) === reqId),
    'audit PAYMENT_REQUEST entry');
}

run()
  .then(() => {
    console.log(`\nPAYMENT REQUESTS: ${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log('FAILED:', failures.join(' | '));
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('\nFATAL:', e && e.message ? e.message : e);
    process.exit(1);
  });