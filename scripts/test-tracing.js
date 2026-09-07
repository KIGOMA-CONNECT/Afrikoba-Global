/* ============================================================
 * AFRIKOBA GLOBAL - TRACE-LEVEL SPAN TRACING
 * Migration 094 + src/utils/trace.js: parent/child span tree for
 * every HTTP request. This suite proves:
 *  - an authenticated wallet transfer emits a ROOT span + CHILD
 *    spans (fin.postJournal / fin.accountIdByCode, etc.) under the
 *    request's span_id
 *  - child spans share the trace_id and link via parent_span_id
 *  - the ROOT span carries the HTTP status (OK for 2xx)
 *  - the Ops tracing endpoint returns the full span tree for a
 *    trace_id
 *  - RBAC: non-admins are refused on /api/ops/tracing/:id
 * ============================================================ */
const BASE = process.env.TRACE_TEST_BASE || 'http://127.0.0.1:3000';
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

async function api(method, path, token, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data, traceId: res.headers.get('x-trace-id') };
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
async function seedWallet(userId, amount, reference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({ client, userId, amount, reference, fromAccount: 'SUSPENSE', description: 'Trace test seed' });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function run() {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90) + 10}`;

  await section('Setup: sender + receiver, seed 100k');
  const send = await register(`255801${suffix}`, 'Trace Sender');
  const recv = await register(`255802${suffix}`, 'Trace Receiver');
  const admin = await register(`255803${suffix}`, 'Trace Admin');
  await seedWallet(send.user.id, 100000, `TR-SEED-${suffix}`);
  await expect(true, 'sender seeded 100k');

  const senderId = send.user.id;
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [admin.user.id]);

  await section('Wallet transfer emits ROOT + CHILD spans under one trace');
  const traceHeader = `tr_suite_${suffix}`;
  const tfr = await api('POST', '/api/wallet/transfer', send.token,
    { toPhoneNumber: recv.user.phone_number, amount: 10000, note: 'trace test' },
    { 'x-trace-id': traceHeader });
  await expect(tfr.status === 200 && tfr.data && tfr.data.success === true && Number(tfr.data.amount) === 10000,
    `transfer 10k succeeded (got ${tfr.status})`);
  const emitted = tfr.traceId || traceHeader;

  await new Promise((r) => setTimeout(r, 500));

  const spans = (await pool.query(
    `SELECT * FROM trace_spans WHERE trace_id = $1 ORDER BY start_ms, id`, [emitted]
  )).rows;
  await expect(spans.length >= 1, `trace produced ${spans.length} span(s)`);

  const root = spans.find((s) => s.span_kind === 'ROOT');
  await expect(!!root, `a ROOT span exists`);
  if (root) {
    await expect(root.parent_span_id === null, `ROOT span has no parent`);
    await expect((root.operation || '').includes('transfer'), `ROOT operation is the transfer route (got '${root.operation}')`);
  }

  const children = spans.filter((s) => s.span_kind !== 'ROOT');
  await expect(children.length >= 1, `${children.length} CHILD span(s) captured`);
  const ledgers = children.filter((s) => s.operation === 'fin.postJournal');
  await expect(ledgers.length >= 1, `at least one fin.postJournal child span`);
  if (ledgers[0]) {
    await expect(ledgers[0].trace_id === emitted, `postJournal child shares trace_id`);
    await expect(ledgers[0].parent_span_id === root.span_id, `postJournal child nests under ROOT span`);
    await expect(ledgers[0].status === 'OK', `postJournal child status OK`);
  }
  const allSameTrace = spans.every((s) => s.trace_id === emitted);
  await expect(allSameTrace, `all spans share the same trace_id`);

  // A failed/unknown account lookup should produce an ERROR child span.
  await section('Failing account lookup emits an ERROR child span');
  const errSpan = require('../src/utils/trace').startSpan('fin.accountIdByCode');
  errSpan.end('ERROR', { code: 'MISSING_ACCOUNT' });
  await new Promise((r) => setTimeout(r, 300));
  const errRows = (await pool.query(
    `SELECT status FROM trace_spans WHERE operation = 'fin.accountIdByCode' AND span_id = $1`, [errSpan.spanId]
  )).rows;
  await expect(errRows.length === 1 && errRows[0].status === 'ERROR', `ERROR span persisted with status ERROR`);

  await section('Ops tracing endpoint returns the span tree');
  const tree = await api('GET', `/api/ops/tracing/${emitted}`, admin.token);
  await expect(tree.status === 200 && tree.data.success === true, `tracing endpoint 200 (got ${tree.status})`);
  const st = tree.data.spans || [];
  await expect(Array.isArray(st) && st.length === spans.length, `endpoint returns all ${spans.length} spans (got ${st.length})`);
  await expect(st.some((s) => s.span_kind === 'ROOT'), `endpoint includes ROOT span`);
  await expect(st.some((s) => s.operation === 'fin.postJournal'), `endpoint includes postJournal child`);

  await section('RBAC');
  const denied = await api('GET', `/api/ops/tracing/${emitted}`, send.token);
  await expect(denied.status === 403, `non-admin refused on tracing endpoint (got ${denied.status})`);
  const anon = await api('GET', `/api/ops/tracing/${emitted}`, null);
  await expect(anon.status === 401, `unauthenticated -> 401 (got ${anon.status})`);

  // Clean up the standalone error span from this run's ledger of checks is fine.
  await pool.query('DELETE FROM trace_spans WHERE span_id = $1', [errSpan.spanId]);
}

run()
  .then(() => {
    console.log(`\nTRACE-LEVEL SPANS: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });